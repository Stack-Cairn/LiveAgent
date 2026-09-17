// 渠道详情"API 地址"区的源地址列表（设计文档 2.3 / 4.2 / 8.2）：主 / 备标签、地址、
// 启停、上次探测状态、逐源检测、删除 + 添加备用地址。端点地址以 `{origin}` 占位相对
// 源地址书写；第一个启用的源即主源。逐源检测只写该源的观测，不改端点状态。

import type { CustomProvider, ProviderOrigin } from "@liveagent/app/lib/settings";
import { getProviderPrimaryOrigin } from "@liveagent/app/lib/settings";
import { Plus, Trash2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { probeProvider } from "@liveagent/ui/pages/settings/providerProbe";
import { useState } from "react";
import { Chip, CommittedInput, ProbeReason, ProbeStatusChip } from "./providerChips";
import {
  addProviderOrigin,
  enabledCredentials,
  originProbeSummaryFor,
  primaryCredential,
  providerExistingCandidates,
  providerOrigins,
  recordOriginProbe,
  removeProviderOrigin,
  updateProviderOrigin,
} from "./providerSettingsModel";

type ProviderUpdater = (updater: (provider: CustomProvider) => CustomProvider) => void;

/** 源地址的展示名：主机（含端口）。 */
export function originHostLabel(origin: Pick<ProviderOrigin, "url">): string {
  try {
    return new URL(origin.url).host;
  } catch {
    return origin.url.replace(/^https?:\/\//i, "");
  }
}

export function ProviderOriginList(props: { provider: CustomProvider; onChange: ProviderUpdater }) {
  const { provider, onChange } = props;
  const { t } = useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const origins = providerOrigins(provider);
  const primaryId = getProviderPrimaryOrigin(provider)?.id;
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function submitAdd() {
    const value = draft.trim();
    if (!value) {
      setAdding(false);
      return;
    }
    onChange((current) => addProviderOrigin(current, value));
    setDraft("");
    setAdding(false);
  }

  async function removeOrigin(origin: ProviderOrigin) {
    const confirmed = await confirm({
      title: t("settings.providerOriginRemove"),
      description: t("settings.providerOriginRemoveConfirm").replace("{url}", origin.url),
      detail: t("settings.providerOriginRemoveConfirmDesc"),
      confirmLabel: t("settings.providerOriginRemove"),
      cancelLabel: t("settings.cancel"),
      preferCancel: true,
    });
    if (!confirmed) return;
    onChange((current) => removeProviderOrigin(current, origin.id));
  }

  /** 逐源检测：该源下全部已配置接口 × 一把可用的 Key；只写该源的观测。 */
  async function checkOrigin(origin: ProviderOrigin) {
    const candidates = providerExistingCandidates(provider, {
      includeDisabled: true,
      originId: origin.id,
    });
    if (candidates.length === 0) return;
    const credential = enabledCredentials(provider)[0] ?? primaryCredential(provider);
    setChecking((previous) => new Set(previous).add(origin.id));
    try {
      const probe = await probeProvider({
        candidates,
        credentials: [{ ...credential, enabled: true }],
        useSystemProxy: provider.useSystemProxy,
        customHeaders: provider.customHeaders,
        providerId: provider.id,
      });
      onChange((current) =>
        recordOriginProbe(current, origin.id, originProbeSummaryFor(probe, candidates, origin.id)),
      );
    } finally {
      setChecking((previous) => {
        const next = new Set(previous);
        next.delete(origin.id);
        return next;
      });
    }
  }

  return (
    <div className="divide-y rounded-xl border bg-card">
      {origins.map((origin) => {
        const enabled = origin.enabled !== false;
        const isPrimary = origin.id === primaryId;
        const host = originHostLabel(origin);
        const roleLabel = isPrimary
          ? t("settings.providerOriginPrimary")
          : t("settings.providerOriginBackup");
        return (
          <div key={origin.id} className={cn("space-y-1 px-3 py-2", !enabled && "opacity-60")}>
            <div className="flex flex-wrap items-center gap-2">
              <Switch
                size="sm"
                checked={enabled}
                onCheckedChange={(next) =>
                  onChange((current) =>
                    updateProviderOrigin(current, origin.id, {
                      enabled: next === true ? undefined : false,
                    }),
                  )
                }
                aria-label={`${host} ${t("settings.enable")}`}
              />
              <Chip tone={isPrimary ? "on" : "default"}>{roleLabel}</Chip>
              <CommittedInput
                value={origin.url}
                className="h-8 min-w-[180px] flex-1 font-mono text-xs shadow-none"
                placeholder={t("settings.providerOriginPlaceholder")}
                aria-label={`${t("settings.providerOrigins")} · ${host}`}
                autoComplete="off"
                spellCheck={false}
                onCommit={(value) => {
                  // 清空不写入（归一化会把空地址整条丢弃）；保留旧值。
                  if (!value.trim()) return;
                  onChange((current) => updateProviderOrigin(current, origin.id, { url: value }));
                }}
              />
              <ProbeStatusChip probe={origin.lastProbe} pending={checking.has(origin.id)} />
              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={checking.has(origin.id)}
                  onClick={() => void checkOrigin(origin)}
                >
                  {t("settings.providerCheck")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  disabled={origins.length === 1}
                  onClick={() => void removeOrigin(origin)}
                  title={t("settings.providerOriginRemove")}
                  aria-label={`${t("settings.providerOriginRemove")} ${host}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>
            <ProbeReason probe={origin.lastProbe} />
          </div>
        );
      })}
      <div className="px-3 py-1.5">
        {adding ? (
          <div className="settings-inline-form flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              value={draft}
              className="h-8 min-w-[180px] flex-1 font-mono text-xs shadow-none"
              placeholder={t("settings.providerOriginPlaceholder")}
              aria-label={t("settings.providerOriginAdd")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitAdd();
                if (event.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
            />
            <Button size="sm" className="h-8 shadow-none" onClick={submitAdd}>
              {t("settings.add")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shadow-none"
              onClick={() => {
                setDraft("");
                setAdding(false);
              }}
            >
              {t("settings.cancel")}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3 w-3" />
            {t("settings.providerOriginAdd")}
          </Button>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}
