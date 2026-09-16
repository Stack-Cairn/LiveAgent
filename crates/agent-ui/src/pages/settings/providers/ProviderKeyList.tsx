// 渠道详情的"API 密钥"区：多 Key 列表（标签、Key、启停、范围芯片、上次拉取、逐 Key
// 检测、删除）+ 添加。范围与详情（手选模型、与主 Key 的差异）仍在"管理密钥"抽屉里，
// 范围芯片点击即跳到对应那把 Key。首把即旧字段 apiKey（setCredentials 维持不变量）。

import type { CustomProvider, ProviderCredential } from "@liveagent/app/lib/settings";
import { Plus, RefreshCw, Trash2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { getUsageRelativeTime } from "@liveagent/ui/lib/providers/usageQueryCore";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useState } from "react";
import { usageRelativeTimeText } from "../ProviderPresentation";
import { Chip, ChipButton, CommittedInput, SecretInput } from "./providerChips";
import {
  addProviderCredential,
  createCredential,
  credentialConfigured,
  type ProviderDrawerState,
  providerCredentials,
  refreshCredentialModelList,
  removeProviderCredential,
  updateProviderCredential,
} from "./providerSettingsModel";

type ProviderUpdater = (updater: (provider: CustomProvider) => CustomProvider) => void;

/** 标签为空时的展示名：首把"默认"，其余"备用 n"。 */
export function credentialDisplayName(
  t: (key: string) => string,
  credential: Pick<ProviderCredential, "label">,
  index: number,
): string {
  return (
    credential.label ||
    (index === 0
      ? t("settings.providerCredentialPrimary")
      : `${t("settings.providerCredentialBackup")} ${index}`)
  );
}

function keyInputId(credentialId: string) {
  return `provider-key-${credentialId}`;
}

export function ProviderKeyList(props: {
  provider: CustomProvider;
  isGatewayWebui: boolean;
  /** 免鉴权预设：缺 Key 不提示 */
  authOptional: boolean;
  onChange: ProviderUpdater;
  onOpenDrawer: (drawer: ProviderDrawerState) => void;
}) {
  const { provider, isGatewayWebui, authOptional, onChange, onOpenDrawer } = props;
  const { t } = useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const credentials = providerCredentials(provider);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshFailed, setRefreshFailed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  // 新增后聚焦到那一行的 Key 输入：等它渲染出来再找。
  useEffect(() => {
    if (!pendingFocusId) return;
    const input = document.getElementById(keyInputId(pendingFocusId));
    if (input instanceof HTMLElement) {
      input.focus();
      setPendingFocusId(null);
    }
  }, [pendingFocusId]);

  function addKey() {
    const credential = createCredential("");
    onChange((current) => addProviderCredential(current, credential));
    setPendingFocusId(credential.id);
  }

  async function removeKey(credential: ProviderCredential, index: number) {
    const confirmed = await confirm({
      title: t("settings.providerCredentialRemove"),
      description: t("settings.providerCredentialRemoveConfirm").replace(
        "{label}",
        credentialDisplayName(t, credential, index),
      ),
      detail: t("settings.providerCredentialRemoveConfirmDesc"),
      confirmLabel: t("settings.providerCredentialRemove"),
      cancelLabel: t("settings.cancel"),
      preferCancel: true,
    });
    if (!confirmed) return;
    onChange((current) => removeProviderCredential(current, credential.id));
  }

  async function refreshKey(credential: ProviderCredential) {
    setRefreshing((previous) => new Set(previous).add(credential.id));
    try {
      const result = await refreshCredentialModelList(provider, credential);
      if (!result.ok) {
        setRefreshFailed((previous) => new Map(previous).set(credential.id, result.reason));
        return;
      }
      setRefreshFailed((previous) => {
        const next = new Map(previous);
        next.delete(credential.id);
        return next;
      });
      onChange((current) =>
        updateProviderCredential(current, credential.id, (item) => ({
          modelScope: item.modelScope ?? { mode: "auto" },
          lastModels: { at: result.at, models: result.models },
        })),
      );
    } finally {
      setRefreshing((previous) => {
        const next = new Set(previous);
        next.delete(credential.id);
        return next;
      });
    }
  }

  function scopeChipText(credential: ProviderCredential): string {
    const scope = credential.modelScope ?? { mode: "auto" as const };
    if (scope.mode === "all") return t("settings.providerCredentialScopeChip.all");
    if (scope.mode === "manual") {
      return t("settings.providerCredentialScopeChip.manual").replace(
        "{count}",
        String(scope.models.length),
      );
    }
    return t("settings.providerCredentialScopeChip.auto");
  }

  function lastFetchText(credential: ProviderCredential): string {
    if (!credential.lastModels) return t("settings.providerCredentialNotFetched");
    const count = t("settings.providerCredentialSeenModels").replace(
      "{count}",
      String(credential.lastModels.models.length),
    );
    const time = usageRelativeTimeText(
      t,
      getUsageRelativeTime(credential.lastModels.at, Date.now()),
    );
    return `${count} · ${time}`;
  }

  return (
    <div className="divide-y rounded-xl border bg-card">
      {credentials.map((credential, index) => {
        const configured = credentialConfigured(credential);
        const redacted =
          isGatewayWebui && credential.apiKey === "" && credential.apiKeyConfigured === true;
        const displayName = credentialDisplayName(t, credential, index);
        const failure = refreshFailed.get(credential.id);
        return (
          <div
            key={credential.id}
            className={cn(
              "flex flex-wrap items-center gap-2 px-3 py-2",
              !credential.enabled && "opacity-60",
            )}
            data-credential-id={credential.id}
          >
            <Switch
              size="sm"
              checked={credential.enabled}
              onCheckedChange={(next) =>
                onChange((current) =>
                  updateProviderCredential(current, credential.id, { enabled: next === true }),
                )
              }
              aria-label={`${displayName} ${t("settings.enable")}`}
            />
            <CommittedInput
              value={credential.label}
              className="h-8 w-28 text-xs shadow-none"
              placeholder={
                index === 0
                  ? t("settings.providerCredentialPrimary")
                  : `${t("settings.providerCredentialBackup")} ${index}`
              }
              aria-label={`${t("settings.providerCredentialLabel")} ${index + 1}`}
              onCommit={(value) =>
                onChange((current) =>
                  updateProviderCredential(current, credential.id, { label: value.trim() }),
                )
              }
            />
            <SecretInput
              id={keyInputId(credential.id)}
              value={credential.apiKey}
              configured={configured}
              redacted={redacted}
              ariaLabel={`${t("settings.apiKey")} · ${displayName}`}
              className="min-w-[180px]"
              onCommit={(value) =>
                onChange((current) =>
                  updateProviderCredential(current, credential.id, {
                    apiKey: value.trim(),
                    apiKeyConfigured: value.trim().length > 0 || redacted,
                  }),
                )
              }
            />
            {!configured && !authOptional ? (
              <Chip tone="warn">{t("settings.providerKeyMissing")}</Chip>
            ) : null}
            <ChipButton
              onClick={() => onOpenDrawer({ kind: "keys", focus: credential.id })}
              title={t("settings.providerCredentialScope")}
            >
              {scopeChipText(credential)}
            </ChipButton>
            <span
              className={cn(
                "text-[10.5px] text-muted-foreground/75",
                failure !== undefined && "text-destructive",
              )}
              title={failure || undefined}
            >
              {failure !== undefined
                ? t("settings.providerCredentialRefreshFailed")
                : lastFetchText(credential)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={refreshing.has(credential.id) || (!configured && !authOptional)}
                onClick={() => void refreshKey(credential)}
                title={t("settings.providerCredentialRefetch")}
                aria-label={`${t("settings.providerCredentialRefetch")} · ${displayName}`}
              >
                <RefreshCw
                  className={cn("h-3 w-3", refreshing.has(credential.id) && "animate-spin")}
                />
                {t("settings.providerCheck")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={credentials.length === 1}
                onClick={() => void removeKey(credential, index)}
                title={t("settings.providerCredentialRemove")}
                aria-label={`${t("settings.providerCredentialRemove")} ${displayName}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>
        );
      })}
      <div className="px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
          onClick={addKey}
        >
          <Plus className="h-3 w-3" />
          {t("settings.providerCredentialAddKey")}
        </Button>
      </div>
      {confirmDialog}
    </div>
  );
}
