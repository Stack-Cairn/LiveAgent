// 探测对话框（设计文档 5.1 - 5.3）：对候选接口逐个拉模型列表，展示每个接口
// 的状态；完成后给出摘要——渠道芯片可取消、模型按家族分组勾选（"其他"默认不勾）
// ——采纳后交给调用方写入设置。已配置的端点（existing）探测失败也保留，只是不
// 参与模型合并；取消时观测仍经 onDismiss 写回。源地址模式下候选按"源 × 接口"
// 展开：摘要按接口分组，每个源一行状态；模型列表取并集。

import type { ProviderChatProtocol, ProviderCredential } from "@liveagent/app/lib/settings";
import { Button } from "@liveagent/ui/components/ui/button";
import { Checkbox } from "@liveagent/ui/components/ui/checkbox";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { CustomHeader } from "@liveagent/ui/lib/providers/customHeaders";
import {
  MODEL_CATALOG_SNAPSHOT_DATE,
  type ProviderPreset,
  presetUsesCatalogModels,
} from "@liveagent/ui/lib/providers/registry";
import {
  type AutoConfiguration,
  buildAutoConfiguration,
  type EndpointCandidate,
  groupProbeModels,
  isProbeStatusUsable,
  type ProviderProbeResult,
  probeModelsUrl,
  probeProvider,
  summarizeEndpointStatus,
} from "@liveagent/ui/pages/settings/providerProbe";
import { useEffect, useMemo, useRef, useState } from "react";
import { originHostLabel } from "./ProviderOriginList";
import {
  Chip,
  ChipButton,
  dialectLabel,
  ProbeReason,
  ProbeStatusChip,
  ProviderAvatar,
  protocolLabel,
} from "./providerChips";
import { probeSummaryFor } from "./providerSettingsModel";

/** 候选按接口分组（保持首次出现顺序）；源地址模式下一个接口对应多个源的候选。 */
function groupCandidatesByProtocol(
  candidates: readonly EndpointCandidate[],
): { protocol: ProviderChatProtocol; candidates: EndpointCandidate[] }[] {
  const groups: { protocol: ProviderChatProtocol; candidates: EndpointCandidate[] }[] = [];
  for (const candidate of candidates) {
    const group = groups.find((item) => item.protocol === candidate.protocol);
    if (group) group.candidates.push(candidate);
    else groups.push({ protocol: candidate.protocol, candidates: [candidate] });
  }
  return groups;
}

export type ProviderProbeRequest = {
  preset: ProviderPreset | undefined;
  candidates: EndpointCandidate[];
  credentials: ProviderCredential[];
  useSystemProxy: boolean;
  customHeaders: readonly CustomHeader[];
  providerId?: string;
  title: string;
  acceptLabel: string;
};

export function ProviderProbeDialog(props: {
  request: ProviderProbeRequest;
  onAccept: (result: {
    auto: AutoConfiguration;
    probe: ProviderProbeResult;
    candidates: EndpointCandidate[];
  }) => void;
  /** 未采纳即关闭：探测已完成时把观测交回调用方（只写 lastProbe） */
  onDismiss?: (result: { probe: ProviderProbeResult; candidates: EndpointCandidate[] }) => void;
  onClose: () => void;
}) {
  const { request, onAccept, onDismiss, onClose } = props;
  const { t } = useLocale();
  // catalog 渠道：模型列表随应用内置，整场探测不发请求，文案与状态都换一套说法。
  const fromCatalog = presetUsesCatalogModels(request.preset);
  const [open, setOpen] = useState(true);
  const [progress, setProgress] = useState<ProviderProbeResult | null>(null);
  const [done, setDone] = useState<ProviderProbeResult | null>(null);
  const [rejectedProtocols, setRejectedProtocols] = useState<ReadonlySet<ProviderChatProtocol>>(
    () => new Set(),
  );
  const [forcedProtocols, setForcedProtocols] = useState<ReadonlySet<ProviderChatProtocol>>(
    () => new Set(),
  );
  const [rejectedGroups, setRejectedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const acceptedRef = useRef(false);
  // 探测只发起一次；效果重跑（StrictMode、request 变化）时只重新挂接结果。
  const activeRef = useRef(false);
  const probeRef = useRef<{
    request: ProviderProbeRequest;
    promise: Promise<ProviderProbeResult>;
  } | null>(null);

  useEffect(() => {
    activeRef.current = true;
    if (!probeRef.current || probeRef.current.request !== request) {
      probeRef.current = {
        request,
        promise: probeProvider({
          candidates: request.candidates,
          credentials: request.credentials,
          preset: request.preset,
          useSystemProxy: request.useSystemProxy,
          customHeaders: request.customHeaders,
          providerId: request.providerId,
          onProgress: (partial) => {
            if (activeRef.current) setProgress(partial);
          },
        }),
      };
    }
    void probeRef.current.promise
      .then((result) => {
        if (!activeRef.current) return;
        setProgress(result);
        setDone(result);
        setRejectedGroups(
          new Set(
            groupProbeModels(
              collectModels(result, request.candidates, new Set(), new Set()),
              availableProtocols(result, request.candidates, new Set(), new Set()),
              request.preset,
            )
              .filter((group) => group.key === "other")
              .map((group) => group.key),
          ),
        );
      })
      .catch((error: unknown) => {
        if (!activeRef.current) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setDone({ at: Date.now(), credentials: [] });
      });
    return () => {
      activeRef.current = false;
    };
  }, [request]);

  const available = useMemo(
    () =>
      done ? availableProtocols(done, request.candidates, rejectedProtocols, forcedProtocols) : [],
    [done, request.candidates, rejectedProtocols, forcedProtocols],
  );
  // 采纳后可路由的接口 = 本次探测通过的 + 既有端点（既有端点不会因探测失败被停用，
  // 只要用户没在上面取消它）。摘要里的推荐接口按这个集合算，与运行时路由一致。
  const routable = useMemo(() => {
    const out = [...available];
    for (const candidate of request.candidates) {
      if (candidate.origin !== "existing") continue;
      if (rejectedProtocols.has(candidate.protocol) || out.includes(candidate.protocol)) continue;
      out.push(candidate.protocol);
    }
    return out;
  }, [available, request.candidates, rejectedProtocols]);
  const groups = useMemo(
    () =>
      done
        ? groupProbeModels(
            collectModels(done, request.candidates, rejectedProtocols, forcedProtocols),
            available,
            request.preset,
            routable,
          )
        : [],
    [
      done,
      request.candidates,
      request.preset,
      rejectedProtocols,
      forcedProtocols,
      available,
      routable,
    ],
  );
  const protocolGroups = useMemo(
    () => groupCandidatesByProtocol(request.candidates),
    [request.candidates],
  );
  const okCount = done
    ? protocolGroups.filter((group) =>
        isProbeStatusUsable(summarizeEndpointStatus(done, group.protocol).status),
      ).length
    : 0;
  const usable = available.length > 0;

  function toggleProtocol(protocol: ProviderChatProtocol) {
    if (!done) return;
    const status = summarizeEndpointStatus(done, protocol).status;
    const existing = request.candidates.some(
      (candidate) => candidate.protocol === protocol && candidate.origin === "existing",
    );
    // 已配置端点：探测失败也保留，点击只是"取消 / 恢复采纳"（采纳后写 enabled:false）。
    if (isProbeStatusUsable(status) || existing) {
      setRejectedProtocols((previous) => {
        const next = new Set(previous);
        if (next.has(protocol)) next.delete(protocol);
        else next.add(protocol);
        return next;
      });
      return;
    }
    if (status === "missing") return;
    setForcedProtocols((previous) => {
      const next = new Set(previous);
      if (next.has(protocol)) next.delete(protocol);
      else next.add(protocol);
      return next;
    });
  }

  function toggleGroup(key: string, checked: boolean) {
    setRejectedGroups((previous) => {
      const next = new Set(previous);
      if (checked) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function accept() {
    if (!done) return;
    const auto = buildAutoConfiguration({
      preset: request.preset,
      candidates: request.candidates,
      probe: done,
      credentials: request.credentials,
      rejectedProtocols,
      rejectedGroups,
      forcedProtocols,
    });
    acceptedRef.current = true;
    onAccept({ auto, probe: done, candidates: request.candidates });
    setOpen(false);
  }

  function handleClosed() {
    if (!acceptedRef.current && done && !failure) {
      onDismiss?.({ probe: done, candidates: request.candidates });
    }
    onClose();
  }

  const totalModels = groups.reduce((count, group) => count + group.models.length, 0);
  const selectedModels = groups
    .filter((group) => !rejectedGroups.has(group.key))
    .reduce((count, group) => count + group.models.length, 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) handleClosed();
      }}
    >
      <DialogContent
        className="flex max-h-[min(640px,calc(100dvh-2rem))] max-w-[640px] flex-col p-0"
        closeLabel={t("settings.close")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ProviderAvatar preset={request.preset} className="h-6 w-6" />
            {request.title}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t(
              fromCatalog
                ? "settings.providerProbeDescriptionCatalog"
                : "settings.providerProbeDescription",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <section className="space-y-1.5">
            <div className="text-xs font-medium text-foreground/80">
              {t("settings.providerProbeEndpoints")}
              {done ? (
                <span className="ml-2 text-muted-foreground">
                  {t("settings.providerProbeEndpointsSummary")
                    .replace("{ok}", String(okCount))
                    .replace("{total}", String(protocolGroups.length))}
                </span>
              ) : null}
            </div>
            {protocolGroups.map((group) => {
              const candidate = group.candidates[0];
              const multiOrigin = group.candidates.length > 1;
              const probed = progress
                ? progress.credentials.some((entry) =>
                    entry.endpoints.some((endpoint) => endpoint.protocol === candidate.protocol),
                  )
                : false;
              const summary =
                probed && progress ? probeSummaryFor(progress, candidate.protocol) : undefined;
              const status = summary?.status;
              const existing = group.candidates.some((item) => item.origin === "existing");
              // 可用 = 拉到了列表（ok）或列表本就内置（catalog）。
              const usableStatus = status !== undefined && isProbeStatusUsable(status);
              const accepted =
                done !== null &&
                ((usableStatus && !rejectedProtocols.has(candidate.protocol)) ||
                  (existing && !usableStatus && !rejectedProtocols.has(candidate.protocol)) ||
                  (!existing &&
                    !usableStatus &&
                    status !== "missing" &&
                    forcedProtocols.has(candidate.protocol)));
              const unreachable = !existing && status === "missing";
              return (
                <div
                  key={candidate.protocol}
                  className="space-y-1 rounded-lg border bg-card px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {done ? (
                      <ChipButton
                        tone={accepted ? "on" : "default"}
                        className={!accepted ? "opacity-60" : undefined}
                        active={accepted}
                        disabled={unreachable}
                        onClick={() => toggleProtocol(candidate.protocol)}
                        title={
                          usableStatus || existing
                            ? t("settings.providerProbeToggleEndpoint")
                            : status === "missing"
                              ? t("settings.providerProbeStatus.missing")
                              : t("settings.providerProbeForceEnable")
                        }
                      >
                        {protocolLabel(candidate.protocol)}
                      </ChipButton>
                    ) : (
                      <span className="font-medium">{protocolLabel(candidate.protocol)}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {fromCatalog
                        ? candidate.baseUrl
                        : multiOrigin
                          ? (candidate.template?.baseUrl ?? "")
                          : probeModelsUrl(candidate)}
                    </span>
                    {candidate.note ? (
                      <span className="text-[10.5px] text-muted-foreground/70">
                        {candidate.note}
                      </span>
                    ) : null}
                    <ProbeStatusChip probe={summary} pending={!probed} />
                  </div>
                  {multiOrigin
                    ? group.candidates.map((item) => {
                        const originSummary =
                          probed && progress
                            ? probeSummaryFor(progress, item.protocol, item.originId)
                            : undefined;
                        return (
                          <div
                            key={item.originId ?? item.baseUrl}
                            className="flex flex-wrap items-center gap-2 pl-3 text-[11px]"
                          >
                            <span className="font-medium text-muted-foreground">
                              {originHostLabel({ url: item.baseUrl })}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground/70">
                              {probeModelsUrl(item)}
                            </span>
                            <ProbeStatusChip probe={originSummary} pending={!probed} />
                            <ProbeReason probe={originSummary} />
                          </div>
                        );
                      })
                    : null}
                  {fromCatalog ? (
                    <p className="text-[10.5px] leading-relaxed text-muted-foreground/70">
                      {t("settings.providerProbeCatalogEndpointHint")}
                    </p>
                  ) : null}
                  {!multiOrigin ? <ProbeReason probe={summary} /> : null}
                </div>
              );
            })}
            {failure ? (
              <p className="text-xs text-destructive" role="alert">
                {failure}
              </p>
            ) : null}
          </section>

          {done ? (
            <section className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground/80">
                {t("settings.providerProbeModels")}
                <span className="text-muted-foreground">
                  {t("settings.providerProbeModelsSummaryInactive")
                    .replace("{selected}", String(selectedModels))
                    .replace("{total}", String(totalModels))}
                </span>
                {fromCatalog ? (
                  <span className="text-muted-foreground">
                    {t("settings.providerProbeModelsFromCatalog").replace(
                      "{date}",
                      MODEL_CATALOG_SNAPSHOT_DATE,
                    )}
                  </span>
                ) : null}
                {done.credentials.length > 1 ? (
                  <span className="text-muted-foreground">
                    {t("settings.providerProbeKeysSummary").replace(
                      "{count}",
                      String(done.credentials.length),
                    )}
                  </span>
                ) : null}
              </div>
              {groups.length === 0 ? (
                <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  {usable
                    ? t("settings.providerProbeNoModels")
                    : t("settings.providerProbeNoEndpoints")}
                </div>
              ) : (
                groups.map((group) => {
                  const checked = !rejectedGroups.has(group.key);
                  const checkboxId = `provider-probe-group-${group.key}`;
                  return (
                    <label
                      key={group.key}
                      htmlFor={checkboxId}
                      className="flex cursor-pointer flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs"
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={checked}
                        onCheckedChange={(value) => toggleGroup(group.key, value === true)}
                      />
                      <span className="font-medium">
                        {group.key === "other" ? t("settings.modelGroupOther") : group.key}
                      </span>
                      <Chip className="tabular-nums">{group.models.length}</Chip>
                      {group.protocol ? (
                        <span className="text-[10.5px] text-muted-foreground">
                          → {protocolLabel(group.protocol)}
                          {group.dialect !== "generic"
                            ? ` · ${dialectLabel(t, group.dialect)}`
                            : ""}
                        </span>
                      ) : null}
                      {group.protocol && !group.verified ? (
                        <Chip tone="warn" title={t("settings.providerProbeGroupUnverifiedHint")}>
                          {t("settings.providerProbeGroupUnverified")}
                        </Chip>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-muted-foreground/70">
                        {group.models
                          .slice(0, 3)
                          .map((model) => model.id)
                          .join(", ")}
                        {group.models.length > 3 ? " …" : ""}
                      </span>
                    </label>
                  );
                })
              )}
              <p className="text-[10.5px] leading-relaxed text-muted-foreground/70">
                {t("settings.providerProbeAcceptHint")}
              </p>
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter className="bg-muted/20">
          <DialogActions>
            <Button variant="outline" className="h-8" onClick={() => setOpen(false)}>
              {t("settings.cancel")}
            </Button>
            <Button className="h-8" disabled={!done || !usable} onClick={accept}>
              {request.acceptLabel}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function availableProtocols(
  probe: ProviderProbeResult,
  candidates: readonly EndpointCandidate[],
  rejected: ReadonlySet<ProviderChatProtocol>,
  forced: ReadonlySet<ProviderChatProtocol>,
): ProviderChatProtocol[] {
  return candidates
    .filter((candidate) => {
      const status = summarizeEndpointStatus(probe, candidate.protocol).status;
      if (isProbeStatusUsable(status)) return !rejected.has(candidate.protocol);
      return status !== "missing" && forced.has(candidate.protocol);
    })
    .map((candidate) => candidate.protocol);
}

function collectModels(
  probe: ProviderProbeResult,
  candidates: readonly EndpointCandidate[],
  rejected: ReadonlySet<ProviderChatProtocol>,
  forced: ReadonlySet<ProviderChatProtocol>,
) {
  const available = new Set(availableProtocols(probe, candidates, rejected, forced));
  const merged = new Map<
    string,
    ProviderProbeResult["credentials"][number]["endpoints"][number]["models"][number]
  >();
  for (const credential of probe.credentials) {
    for (const endpoint of credential.endpoints) {
      if (!isProbeStatusUsable(endpoint.status) || !available.has(endpoint.protocol)) continue;
      for (const model of endpoint.models) {
        if (!merged.has(model.id)) merged.set(model.id, model);
      }
    }
  }
  return [...merged.values()];
}
