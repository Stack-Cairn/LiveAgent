// 抽屉二"管理密钥"（设计文档 5.6）：多 Key 列表（标签、Key、启停、排序、删除），
// 每把 Key 的模型范围（自动 / 全部 / 手选通配）、上次拉取的模型数与与主 Key 的差异、
// "用此 Key 重新拉取"。首把即旧字段 apiKey。

import type { CustomProvider, ProviderCredential } from "@liveagent/app/lib/settings";
import { ArrowUp, ChevronDown, Plus, RefreshCw, Trash2, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { probeProvider } from "@liveagent/ui/pages/settings/providerProbe";
import { useState } from "react";
import { DrawerGroupLabel } from "../ProviderPresentation";
import { Chip, CommittedInput, SecretInput } from "./providerChips";
import {
  createCredential,
  credentialModelDiff,
  providerCredentials,
  providerExistingCandidates,
  setCredentials,
} from "./providerSettingsModel";

const SCOPE_CHIP_LIMIT = 40;

export function CredentialsDrawer(props: {
  provider: CustomProvider;
  onChange: (updater: (provider: CustomProvider) => CustomProvider) => void;
  isGatewayWebui: boolean;
  onClose: () => void;
}) {
  const { provider, onChange, isGatewayWebui, onClose } = props;
  const { t } = useLocale();
  const credentials = providerCredentials(provider);
  const primary = credentials[0];
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshFailed, setRefreshFailed] = useState<ReadonlySet<string>>(() => new Set());

  function update(mutate: (list: ProviderCredential[]) => ProviderCredential[]) {
    onChange((current) => setCredentials(current, mutate(providerCredentials(current))));
  }

  function patch(id: string, patchValue: Partial<ProviderCredential>) {
    update((list) =>
      list.map((credential) =>
        credential.id === id ? { ...credential, ...patchValue } : credential,
      ),
    );
  }

  function move(index: number, delta: number) {
    update((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  async function refreshCredential(credential: ProviderCredential) {
    const candidates = providerExistingCandidates(provider);
    if (candidates.length === 0) return;
    setRefreshing((previous) => new Set(previous).add(credential.id));
    try {
      const result = await probeProvider({
        candidates,
        credentials: [{ ...credential, enabled: true }],
        useSystemProxy: provider.useSystemProxy,
        customHeaders: provider.customHeaders,
        providerId: provider.id,
      });
      const seen = new Set<string>();
      let ok = false;
      for (const entry of result.credentials) {
        for (const endpoint of entry.endpoints) {
          if (endpoint.status !== "ok") continue;
          ok = true;
          for (const model of endpoint.models) seen.add(model.id);
        }
      }
      if (!ok) {
        setRefreshFailed((previous) => new Set(previous).add(credential.id));
        return;
      }
      setRefreshFailed((previous) => {
        const next = new Set(previous);
        next.delete(credential.id);
        return next;
      });
      patch(credential.id, {
        modelScope: credential.modelScope ?? { mode: "auto" },
        lastModels: { at: result.at, models: [...seen].sort() },
      });
    } finally {
      setRefreshing((previous) => {
        const next = new Set(previous);
        next.delete(credential.id);
        return next;
      });
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        variant="inset"
        className="settings-provider-drawer max-w-none border-border bg-background sm:max-w-[560px]"
        closeLabel={t("settings.close")}
        showCloseButton={false}
      >
        <div className="settings-provider-drawer-header relative flex items-center gap-3 px-6 pb-4 pt-[22px]">
          <SheetTitle className="min-w-0 flex-1 truncate text-[17px] leading-tight tracking-tight text-foreground/95">
            {t("settings.providerCredentialsTitle")} · {provider.name}
          </SheetTitle>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground"
            title={t("settings.close")}
            aria-label={t("settings.close")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          aria-hidden="true"
          className="relative mx-6 h-px bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent"
        />
        <div className="settings-provider-drawer-body relative min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
          <div className="space-y-4">
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              {t("settings.providerCredentialsHint")}
            </p>
            <DrawerGroupLabel label={t("settings.providerCredentialsList")} />
            {credentials.map((credential, index) => {
              const scope = credential.modelScope ?? { mode: "auto" as const };
              const seen = credential.lastModels?.models.length ?? 0;
              const diff = index > 0 ? credentialModelDiff(credential, primary) : null;
              const redacted =
                isGatewayWebui && credential.apiKey === "" && credential.apiKeyConfigured === true;
              return (
                <div key={credential.id} className="rounded-xl border bg-card">
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <Switch
                      size="sm"
                      checked={credential.enabled}
                      onCheckedChange={(next) => patch(credential.id, { enabled: next === true })}
                      aria-label={`${credential.label || t("settings.providerCredentialPrimary")} ${t("settings.enable")}`}
                    />
                    <CommittedInput
                      value={credential.label}
                      className="h-8 w-32 text-xs shadow-none"
                      placeholder={
                        index === 0
                          ? t("settings.providerCredentialPrimary")
                          : `${t("settings.providerCredentialBackup")} ${index}`
                      }
                      aria-label={t("settings.providerCredentialLabel")}
                      onCommit={(value) => patch(credential.id, { label: value.trim() })}
                    />
                    <SecretInput
                      value={credential.apiKey}
                      configured={
                        credential.apiKeyConfigured === true || credential.apiKey.length > 0
                      }
                      redacted={redacted}
                      ariaLabel="API Key"
                      onCommit={(value) =>
                        patch(credential.id, {
                          apiKey: value.trim(),
                          apiKeyConfigured: value.trim().length > 0,
                        })
                      }
                    />
                    <Chip tone={index === 0 ? "on" : "default"}>
                      {index === 0
                        ? t("settings.providerCredentialPrimary")
                        : `${t("settings.providerCredentialBackup")} ${index}`}
                    </Chip>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      title={t("settings.providerCredentialMoveUp")}
                      aria-label={t("settings.providerCredentialMoveUp")}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      disabled={index === credentials.length - 1}
                      onClick={() => move(index, 1)}
                      title={t("settings.providerCredentialMoveDown")}
                      aria-label={t("settings.providerCredentialMoveDown")}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      disabled={credentials.length === 1}
                      onClick={() =>
                        update((list) => list.filter((item) => item.id !== credential.id))
                      }
                      title={t("settings.providerCredentialRemove")}
                      aria-label={t("settings.providerCredentialRemove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="space-y-3 border-t px-3 py-3">
                    <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">
                          {t("settings.providerCredentialScope")}
                        </Label>
                        <Select
                          value={scope.mode}
                          onValueChange={(value) =>
                            patch(credential.id, {
                              modelScope:
                                value === "manual"
                                  ? {
                                      mode: "manual",
                                      models:
                                        scope.mode === "manual"
                                          ? scope.models
                                          : (credential.lastModels?.models.slice(0, 3) ?? []),
                                    }
                                  : value === "all"
                                    ? { mode: "all" }
                                    : { mode: "auto" },
                            })
                          }
                        >
                          <SelectTrigger className="h-8 text-xs shadow-none">
                            <SelectValue>
                              {t(`settings.providerCredentialScope.${scope.mode}`)}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {(["auto", "all", "manual"] as const).map((mode) => (
                              <SelectItem key={mode} value={mode}>
                                {t(`settings.providerCredentialScope.${mode}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Label className="text-[11px] text-muted-foreground">
                            {t("settings.providerCredentialLastFetch")}
                          </Label>
                          <span className="flex-1" />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-2 text-[11px]"
                            disabled={refreshing.has(credential.id)}
                            onClick={() => void refreshCredential(credential)}
                          >
                            <RefreshCw
                              className={cn(
                                "h-3 w-3",
                                refreshing.has(credential.id) && "animate-spin",
                              )}
                            />
                            {t("settings.providerCredentialRefetch")}
                          </Button>
                        </div>
                        <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border px-3 py-1 text-xs">
                          <span>
                            {credential.lastModels
                              ? t("settings.providerCredentialSeenModels").replace(
                                  "{count}",
                                  String(seen),
                                )
                              : t("settings.providerCredentialNotFetched")}
                          </span>
                          {diff ? (
                            diff.more === 0 && diff.less === 0 ? (
                              <Chip tone="ok">{t("settings.providerCredentialSameAsPrimary")}</Chip>
                            ) : (
                              <Chip tone="warn">
                                {t("settings.providerCredentialDiffFromPrimary")
                                  .replace("{more}", String(diff.more))
                                  .replace("{less}", String(diff.less))}
                              </Chip>
                            )
                          ) : null}
                          {refreshFailed.has(credential.id) ? (
                            <Chip tone="bad">{t("settings.providerCredentialRefreshFailed")}</Chip>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {scope.mode === "manual" ? (
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">
                          {t("settings.providerCredentialManualModels")}
                        </Label>
                        <CommittedInput
                          value={scope.models.join(", ")}
                          className="h-8 font-mono text-xs shadow-none"
                          placeholder="claude-*, gpt-5"
                          aria-label={t("settings.providerCredentialManualModels")}
                          autoComplete="off"
                          spellCheck={false}
                          onCommit={(value) =>
                            patch(credential.id, {
                              modelScope: {
                                mode: "manual",
                                models: value
                                  .split(",")
                                  .map((item) => item.trim())
                                  .filter(Boolean),
                              },
                            })
                          }
                        />
                      </div>
                    ) : null}
                    {scope.mode === "auto" && credential.lastModels ? (
                      <div className="flex flex-wrap gap-1">
                        {provider.models.slice(0, SCOPE_CHIP_LIMIT).map((model) => {
                          const covered = credential.lastModels?.models.includes(model.id) ?? false;
                          return (
                            <Chip
                              key={model.id}
                              tone={covered ? "on" : "default"}
                              className={cn("font-mono", !covered && "opacity-50")}
                            >
                              {model.id}
                            </Chip>
                          );
                        })}
                        {provider.models.length > SCOPE_CHIP_LIMIT ? (
                          <Chip>+{provider.models.length - SCOPE_CHIP_LIMIT}</Chip>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 shadow-none"
              onClick={() =>
                update((list) => [
                  ...list,
                  createCredential(`${t("settings.providerCredentialBackup")} ${list.length}`),
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {t("settings.providerCredentialAdd")}
            </Button>
            <p className="text-[10.5px] leading-relaxed text-muted-foreground/70">
              {t("settings.providerCredentialsFooter")}
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
