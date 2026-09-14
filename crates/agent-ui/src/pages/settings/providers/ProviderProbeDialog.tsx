// 探测对话框（设计文档 5.1 - 5.3）：对候选接口逐个拉模型列表，展示每个接口
// 的状态；完成后给出摘要——渠道芯片可取消、模型按家族分组勾选（"其他"默认不勾）
// ——采纳后交给调用方写入设置。

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
import type { ProviderPreset } from "@liveagent/ui/lib/providers/registry";
import {
  type AutoConfiguration,
  buildAutoConfiguration,
  type EndpointCandidate,
  groupProbeModels,
  legacyTypeForProtocol,
  type ProviderProbeResult,
  probeProvider,
  summarizeEndpointStatus,
} from "@liveagent/ui/pages/settings/providerProbe";
import {
  buildProviderModelsUrl,
  normalizeProviderModelsBaseUrl,
} from "@liveagent/ui/pages/settings/providerUtils";

/** 与真实拉取一致的模型列表地址预览（去重 /v1、Gemini 用 v1beta）。 */
function previewModelsUrl(candidate: EndpointCandidate): string {
  if (candidate.modelsUrl) return candidate.modelsUrl;
  const type = legacyTypeForProtocol(candidate.protocol);
  try {
    return buildProviderModelsUrl(
      type,
      normalizeProviderModelsBaseUrl(type, candidate.baseUrl, candidate.isFullUrl === true),
      "official",
    );
  } catch {
    return candidate.baseUrl;
  }
}

import { useEffect, useMemo, useRef, useState } from "react";
import { ChipButton, ProbeStatusChip, protocolLabel } from "./providerChips";
import { probeSummaryFor } from "./providerSettingsModel";

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
  onClose: () => void;
}) {
  const { request, onAccept, onClose } = props;
  const { t } = useLocale();
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
  const groups = useMemo(
    () =>
      done
        ? groupProbeModels(
            collectModels(done, request.candidates, rejectedProtocols, forcedProtocols),
            available,
            request.preset,
          )
        : [],
    [done, request.candidates, request.preset, rejectedProtocols, forcedProtocols, available],
  );
  const okCount = done
    ? request.candidates.filter(
        (candidate) => summarizeEndpointStatus(done, candidate.protocol).status === "ok",
      ).length
    : 0;
  const usable = available.length > 0;

  function toggleProtocol(protocol: ProviderChatProtocol) {
    if (!done) return;
    const status = summarizeEndpointStatus(done, protocol).status;
    if (status === "ok") {
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
    onAccept({ auto, probe: done, candidates: request.candidates });
    setOpen(false);
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
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[min(640px,calc(100dvh-2rem))] max-w-[640px] flex-col p-0"
        closeLabel={t("settings.close")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{request.title}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("settings.providerProbeDescription")}
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
                    .replace("{total}", String(request.candidates.length))}
                </span>
              ) : null}
            </div>
            {request.candidates.map((candidate) => {
              const probed = progress
                ? progress.credentials.some((entry) =>
                    entry.endpoints.some((endpoint) => endpoint.protocol === candidate.protocol),
                  )
                : false;
              const summary =
                probed && progress ? probeSummaryFor(progress, candidate.protocol) : undefined;
              const status = summary?.status;
              const accepted =
                done !== null &&
                ((status === "ok" && !rejectedProtocols.has(candidate.protocol)) ||
                  (status !== "ok" &&
                    status !== "missing" &&
                    forcedProtocols.has(candidate.protocol)));
              return (
                <div
                  key={candidate.protocol}
                  className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs"
                >
                  {done ? (
                    <ChipButton
                      tone={accepted ? "on" : "default"}
                      strike={status === "missing" || (!accepted && status !== "ok")}
                      active={accepted}
                      disabled={status === "missing"}
                      onClick={() => toggleProtocol(candidate.protocol)}
                      title={
                        status === "ok"
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
                    {previewModelsUrl(candidate)}
                  </span>
                  {candidate.note ? (
                    <span className="text-[10.5px] text-muted-foreground/70">{candidate.note}</span>
                  ) : null}
                  <ProbeStatusChip probe={summary} pending={!probed} />
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
                  {t("settings.providerProbeModelsSummary")
                    .replace("{selected}", String(selectedModels))
                    .replace("{total}", String(totalModels))}
                </span>
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
                      <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                        {group.models.length}
                      </span>
                      {group.protocol ? (
                        <span className="text-[10.5px] text-muted-foreground">
                          → {protocolLabel(group.protocol)}
                          {group.dialect !== "generic" ? ` · ${group.dialect}` : ""}
                        </span>
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
      if (status === "ok") return !rejected.has(candidate.protocol);
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
      if (endpoint.status !== "ok" || !available.has(endpoint.protocol)) continue;
      for (const model of endpoint.models) {
        if (!merged.has(model.id)) merged.set(model.id, model);
      }
    }
  }
  return [...merged.values()];
}
