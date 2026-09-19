// 渠道详情的"API 密钥"区：多 Key 列表（标签、Key、启停、范围芯片、上次拉取、逐 Key
// 检测、删除）+ 添加。范围与详情（手选模型、与主 Key 的差异）仍在"管理密钥"抽屉里，
// 范围芯片点击即跳到对应那把 Key。首把即旧字段 apiKey（setCredentials 维持不变量）。

import type { CustomProvider, ProviderCredential } from "@liveagent/app/lib/settings";
import { Plus, Trash2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useState } from "react";
import { Chip, CommittedInput, SecretInput } from "./providerChips";
import {
  addProviderCredential,
  createCredential,
  credentialConfigured,
  providerCredentials,
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
}) {
  const { provider, isGatewayWebui, authOptional, onChange } = props;
  const { t } = useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const credentials = providerCredentials(provider);
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

  return (
    <div className="divide-y rounded-xl border bg-card">
      {credentials.map((credential, index) => {
        const configured = credentialConfigured(credential);
        const redacted =
          isGatewayWebui && credential.apiKey === "" && credential.apiKeyConfigured === true;
        const displayName = credentialDisplayName(t, credential, index);
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
              className="min-w-[180px] flex-1"
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
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
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
