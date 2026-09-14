// 中栏"渠道详情"（设计文档 7）：标题行、API 密钥、API 地址、模型列表（按分组折叠）、
// 更多设置、可用性（故障转移）、用量查询。所有写入经父组件的 onChange 走
// normalizeCustomProvider。

import { ProviderCopyConfigButton } from "@liveagent/adapters/providerSettings";
import type { getProviderUsageCardDisplay } from "@liveagent/app/lib/providers/usageQuery";
import {
  type CustomProvider,
  type ProviderModelConfig,
  resolveProviderChatRoute,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  ArrowLeft,
  ChevronDown,
  Globe,
  ImageIcon,
  Lightbulb,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { resolveModelInputModalities } from "@liveagent/ui/lib/models/modelCatalog";
import { resolveModelThinking } from "@liveagent/ui/lib/models/modelThinking";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { formatTokenCount } from "@liveagent/ui/pages/settings/providerUtils";
import { ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { useState } from "react";
import { UsagePlanLine, usageRelativeTimeText } from "../ProviderPresentation";
import { ProviderFailoverSection } from "./ProviderFailoverSection";
import { ProviderMoreSettings } from "./ProviderMoreSettings";
import { ProviderUsageQueryPanel } from "./ProviderUsageQueryPanel";
import {
  CategoryChip,
  Chip,
  ChipButton,
  CommittedInput,
  ProbeStatusChip,
  ProviderAvatar,
  protocolLabel,
  SecretInput,
  SectionTitle,
  SourceTag,
} from "./providerChips";
import {
  addProviderModel,
  credentialScopesMatch,
  credentialsCoveringModel,
  enabledCredentials,
  groupProviderModels,
  type ProviderDrawerState,
  presetForProvider,
  primaryCredential,
  providerConfiguredProtocols,
  providerDefaultProtocol,
  readEndpoint,
  removeProviderModel,
  setPrimaryApiKey,
  setProviderModelActive,
  writeEndpoint,
} from "./providerSettingsModel";

type ProviderUpdater = (updater: (provider: CustomProvider) => CustomProvider) => void;

export type ProviderDetailProps = SettingsSectionProps & {
  provider: CustomProvider;
  isGatewayWebui: boolean;
  onChange: ProviderUpdater;
  onOpenDrawer: (drawer: ProviderDrawerState) => void;
  onProbeConfigure: () => void;
  onQuickCheck: () => void;
  onRefreshModels: () => void;
  onAddInstance: () => void;
  onDelete: () => void;
  onBack: () => void;
  busy: "check" | "refresh" | null;
  notice: { tone: "ok" | "bad"; text: string } | null;
  usage: {
    display: ReturnType<typeof getProviderUsageCardDisplay>;
    refreshing: boolean;
    onRefresh: () => void;
  };
};

function ModelRow(props: {
  provider: CustomProvider;
  model: ProviderModelConfig;
  onChange: ProviderUpdater;
  onEdit: () => void;
}) {
  const { provider, model, onChange, onEdit } = props;
  const { t } = useLocale();
  const active = provider.activeModels.includes(model.id);
  const route = resolveProviderChatRoute(provider, model.id);
  const thinking = resolveModelThinking(route.adapterProviderId, model.id);
  const modalities =
    model.inputModalities ?? resolveModelInputModalities(route.adapterProviderId, model.id);
  const vision =
    model.capabilities?.imageUnderstanding === "supported" ||
    (model.capabilities?.imageUnderstanding !== "unsupported" && modalities?.includes("image"));
  const reasoning =
    model.capabilities?.reasoning === "supported" ||
    (model.capabilities?.reasoning !== "unsupported" && thinking.reasoning);
  const tools = model.capabilities?.tools === "supported";
  const search =
    model.capabilities?.nativeWebSearch === "supported" || model.nativeWebSearch === true;
  const enabledKeys = enabledCredentials(provider);
  const coveringKeys = credentialsCoveringModel(provider, model.id);
  const keyChip =
    enabledKeys.length < 2
      ? null
      : coveringKeys.length === 0
        ? { tone: "warn" as const, text: t("settings.modelKeyNoMatch") }
        : coveringKeys.length === enabledKeys.length
          ? null
          : {
              tone: "warn" as const,
              text: `${t("settings.modelKeyLabel")}${coveringKeys
                .map((credential) => credential.label || t("settings.providerCredentialPrimary"))
                .join(" / ")}`,
            };
  const hasEndpoint = Boolean(readEndpoint(provider, route.protocol));

  return (
    <div
      className={cn(
        "settings-model-row group flex flex-wrap items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/30",
        !active && "opacity-60",
      )}
    >
      <Switch
        size="sm"
        checked={active}
        onCheckedChange={(next) =>
          onChange((current) => setProviderModelActive(current, model.id, next === true))
        }
        aria-label={model.id}
      />
      <span className="min-w-0 flex-1 basis-40 leading-tight">
        <span className="block truncate font-mono text-[12.5px] text-foreground/90">
          {model.displayName ? (
            <>
              <span className="font-sans font-medium">{model.displayName}</span>
              <span className="ml-1.5 text-muted-foreground/70">{model.id}</span>
            </>
          ) : (
            model.id
          )}
        </span>
        <span className="block truncate text-[10.5px] tabular-nums text-muted-foreground/70">
          {formatTokenCount(model.contextWindow)} ctx · {formatTokenCount(model.maxOutputToken)} out
          {model.limitsSource === "fallback" ? ` · ${t("settings.estimatedLimitsBadge")}` : ""}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground/70">
        {vision ? (
          <span
            role="img"
            title={t("settings.modelCapability.imageUnderstanding")}
            aria-label={t("settings.modelCapability.imageUnderstanding")}
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {reasoning ? (
          <span
            role="img"
            title={t("settings.modelCapability.reasoning")}
            aria-label={t("settings.modelCapability.reasoning")}
          >
            <Lightbulb className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {tools ? (
          <span
            role="img"
            title={t("settings.modelCapability.tools")}
            aria-label={t("settings.modelCapability.tools")}
          >
            <Wrench className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {search ? (
          <span
            role="img"
            title={t("settings.modelCapability.nativeWebSearch")}
            aria-label={t("settings.modelCapability.nativeWebSearch")}
          >
            <Globe className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </span>
      {hasEndpoint ? (
        <Chip tone={route.protocolSource === "model" ? "on" : "default"}>
          {route.protocolSource === "model" ? "" : `${t("settings.modelRouteAuto")} · `}
          {protocolLabel(route.protocol)}
        </Chip>
      ) : (
        <Chip tone="bad">{t("settings.modelNoEndpoint")}</Chip>
      )}
      {route.dialect !== "generic" ? <Chip tone="purple">{route.dialect}</Chip> : null}
      {model.wireModelId ? (
        <Chip className="font-mono">
          {t("settings.modelWireIdShort")} {model.wireModelId}
        </Chip>
      ) : null}
      {keyChip ? <Chip tone={keyChip.tone}>{keyChip.text}</Chip> : null}
      <span className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          title={t("settings.modelSettings")}
          aria-label={`${t("settings.modelSettings")} ${model.id}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onChange((current) => removeProviderModel(current, model.id))}
          title={t("settings.delete")}
          aria-label={`${t("settings.delete")} ${model.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </span>
    </div>
  );
}

export function ProviderDetail(props: ProviderDetailProps) {
  const {
    settings,
    setSettings,
    provider,
    isGatewayWebui,
    onChange,
    onOpenDrawer,
    onProbeConfigure,
    onQuickCheck,
    onRefreshModels,
    onAddInstance,
    onDelete,
    onBack,
    busy,
    notice,
    usage,
  } = props;
  const { t } = useLocale();
  const preset = presetForProvider(provider);
  const defaultProtocol = providerDefaultProtocol(provider);
  const defaultEndpoint = readEndpoint(provider, defaultProtocol);
  const configured = providerConfiguredProtocols(provider);
  const primary = primaryCredential(provider);
  const enabledKeys = enabledCredentials(provider);
  const redactedKey = isGatewayWebui && primary.apiKey === "" && primary.apiKeyConfigured === true;
  const keyConfigured = primary.apiKeyConfigured === true || primary.apiKey.length > 0;
  const groups = groupProviderModels(provider);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [addingModel, setAddingModel] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const enabled = provider.enabled !== false;
  const firstUsagePlan = usage.display.plans[0];

  function submitNewModel() {
    const id = newModelName.trim();
    if (!id) return;
    onChange((current) => addProviderModel(current, id));
    setNewModelName("");
    setAddingModel(false);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="settings-provider-back hidden h-8 w-8 max-[720px]:inline-flex"
          onClick={onBack}
          title={t("settings.channelBackToList")}
          aria-label={t("settings.channelBackToList")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <ProviderAvatar preset={preset} name={provider.name} className="h-9 w-9 text-base" />
        <CommittedInput
          value={provider.name}
          className="h-8 w-56 max-w-full border-transparent bg-transparent px-2 text-base font-semibold tracking-tight shadow-none hover:border-border focus-visible:border-border"
          aria-label={t("settings.providerName")}
          onCommit={(value) => {
            const name = value.trim();
            if (name) onChange((current) => ({ ...current, name }));
          }}
        />
        <Chip>{preset.name}</Chip>
        <CategoryChip category={provider.category ?? preset.category} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
          onClick={onAddInstance}
          title={t("settings.channelAddInstanceHint")}
        >
          <Plus className="h-3 w-3" />
          {t("settings.channelAddInstance")}
        </Button>
        <span className="flex-1" />
        <ProviderCopyConfigButton provider={provider} />
        <ConfirmDeletePopover name={provider.name} onConfirm={onDelete}>
          {(open) => (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={open}
              title={t("settings.delete")}
              aria-label={`${t("settings.delete")} ${provider.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </ConfirmDeletePopover>
        <span className="text-[11px] text-muted-foreground">{t("settings.enable")}</span>
        <Switch
          checked={enabled}
          onCheckedChange={(next) =>
            onChange((current) => ({ ...current, enabled: next === true ? undefined : false }))
          }
          aria-label={`${provider.name} ${t("settings.enable")}`}
        />
      </div>

      {notice ? (
        <p
          className={cn(
            "rounded-lg border px-3 py-2 text-[11px]",
            notice.tone === "ok"
              ? "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
          role="status"
        >
          {notice.text}
        </p>
      ) : null}

      <section className="space-y-2">
        <SectionTitle
          title={t("settings.apiKey")}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => onOpenDrawer({ kind: "keys" })}
            >
              {t("settings.providerManageKeys").replace(
                "{count}",
                String((provider.credentials ?? [primary]).length),
              )}
            </Button>
          }
        />
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2.5">
          <SecretInput
            value={primary.apiKey}
            configured={keyConfigured}
            redacted={redactedKey}
            ariaLabel={t("settings.apiKey")}
            className="min-w-[200px]"
            onCommit={(value) =>
              onChange((current) =>
                setPrimaryApiKey(current, value.trim(), { keepConfigured: redactedKey }),
              )
            }
          />
          {!keyConfigured && !preset.authOptional ? (
            <Chip tone="bad">{t("settings.providerKeyMissing")}</Chip>
          ) : null}
          {enabledKeys.length >= 2 ? (
            credentialScopesMatch(provider) ? (
              <Chip tone="ok">
                {t("settings.providerKeysInterchangeable").replace(
                  "{count}",
                  String(enabledKeys.length),
                )}
              </Chip>
            ) : (
              <Chip tone="warn">
                {t("settings.providerKeysScoped").replace("{count}", String(enabledKeys.length))}
              </Chip>
            )
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[11px] shadow-none"
            disabled={busy !== null}
            onClick={onQuickCheck}
          >
            <RefreshCw className={cn("h-3 w-3", busy === "check" && "animate-spin")} />
            {t("settings.providerCheck")}
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <SectionTitle
          title={t("settings.providerApiAddress")}
          badge={
            <>
              <Chip>
                {t("settings.providerEndpointDefault")} · {protocolLabel(defaultProtocol)}
              </Chip>
              <ProbeStatusChip probe={defaultEndpoint?.config.lastProbe} />
            </>
          }
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={busy !== null}
                onClick={onProbeConfigure}
              >
                {t("settings.providerProbeAndConfigure")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => onOpenDrawer({ kind: "request" })}
              >
                {t("settings.providerDialogRequest")}
              </Button>
            </>
          }
        />
        <div className="space-y-2 rounded-xl border bg-card px-3 py-2.5">
          <div className="flex items-center gap-2">
            <CommittedInput
              value={defaultEndpoint?.config.baseUrl ?? provider.baseUrl}
              className="h-8 min-w-0 flex-1 font-mono text-xs shadow-none"
              placeholder="https://api.example.com/v1"
              aria-label={t("settings.baseUrl")}
              autoComplete="off"
              spellCheck={false}
              onCommit={(value) =>
                onChange((current) => writeEndpoint(current, defaultProtocol, { baseUrl: value }))
              }
            />
            {defaultEndpoint?.config.source ? (
              <SourceTag source={defaultEndpoint.config.source} />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {configured.length === 0 ? (
              <span className="text-[11px] text-muted-foreground/75">
                {t("settings.providerNoEndpointsHint")}
              </span>
            ) : (
              configured.map((protocol) => {
                const view = readEndpoint(provider, protocol);
                const isEnabled = view?.config.enabled !== false;
                return (
                  <ChipButton
                    key={protocol}
                    tone={isEnabled ? "on" : "default"}
                    strike={!isEnabled}
                    onClick={() => onOpenDrawer({ kind: "request", focus: protocol })}
                    title={t("settings.providerDialogRequest")}
                  >
                    {protocolLabel(protocol)}
                    {protocol === defaultProtocol
                      ? ` · ${t("settings.providerEndpointDefault")}`
                      : ""}
                  </ChipButton>
                );
              })
            )}
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <SectionTitle
          title={t("settings.models")}
          badge={
            <Chip>
              {t("settings.modelsEnabledCount")
                .replace("{enabled}", String(provider.activeModels.length))
                .replace("{total}", String(provider.models.length))}
            </Chip>
          }
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-[11px]"
                disabled={busy !== null}
                onClick={onRefreshModels}
              >
                <RefreshCw className={cn("h-3 w-3", busy === "refresh" && "animate-spin")} />
                {busy === "refresh" ? t("settings.fetching") : t("settings.refreshModels")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-[11px]"
                onClick={() => setAddingModel(true)}
              >
                <Plus className="h-3 w-3" />
                {t("settings.manualAddModel")}
              </Button>
            </>
          }
        />
        <div className="overflow-hidden rounded-xl border bg-card">
          {addingModel ? (
            <div className="settings-inline-form flex gap-2 border-b bg-muted/20 p-2.5 max-[720px]:flex-wrap">
              <Input
                autoFocus
                value={newModelName}
                className="h-8 font-mono text-xs shadow-none max-[720px]:basis-full"
                placeholder={t("settings.modelName")}
                onChange={(event) => setNewModelName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitNewModel();
                  if (event.key === "Escape") setAddingModel(false);
                }}
              />
              <Button size="sm" className="h-8 shadow-none" onClick={submitNewModel}>
                {t("settings.add")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shadow-none"
                onClick={() => setAddingModel(false)}
              >
                {t("settings.cancel")}
              </Button>
            </div>
          ) : null}
          {groups.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("settings.modelsEmptyHint")}
            </div>
          ) : (
            groups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              const activeCount = group.models.filter((model) =>
                provider.activeModels.includes(model.id),
              ).length;
              return (
                <div key={group.key} className="border-b last:border-b-0">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 bg-muted/20 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/40"
                    aria-expanded={!collapsed}
                    onClick={() =>
                      setCollapsedGroups((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  >
                    <ChevronDown
                      className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")}
                    />
                    <span className="font-medium text-foreground/80">
                      {group.key === "other" ? t("settings.modelGroupOther") : group.key}
                    </span>
                    <Chip>
                      {activeCount} / {group.models.length}
                    </Chip>
                  </button>
                  {!collapsed ? (
                    <div className="divide-y">
                      {group.models.map((model) => (
                        <ModelRow
                          key={model.id}
                          provider={provider}
                          model={model}
                          onChange={onChange}
                          onEdit={() => onOpenDrawer({ kind: "model", modelId: model.id })}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="space-y-2">
        <SectionTitle title={t("settings.providerMoreSettings")} />
        <ProviderMoreSettings provider={provider} onChange={onChange} />
      </section>

      <section className="space-y-2">
        <SectionTitle
          title={t("settings.providerAvailability")}
          badge={<Chip>{t("settings.failoverTitle")}</Chip>}
        />
        <ProviderFailoverSection
          settings={settings}
          setSettings={setSettings}
          provider={provider}
        />
      </section>

      <section className="space-y-2">
        <SectionTitle
          title={t("settings.providerUsageQuery")}
          badge={
            usage.display.show ? (
              <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                {firstUsagePlan ? (
                  <UsagePlanLine plan={firstUsagePlan} />
                ) : usage.display.loading ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-24 animate-pulse rounded-full bg-foreground/[0.08] motion-reduce:animate-none"
                  />
                ) : (
                  <span className={cn("truncate", usage.display.error && "text-destructive")}>
                    {usage.display.error ?? t("settings.providerUsageNoData")}
                  </span>
                )}
                {usage.display.updatedAt ? (
                  <time className="text-muted-foreground/70">
                    {usageRelativeTimeText(t, usage.display.updatedAt)}
                  </time>
                ) : null}
              </span>
            ) : null
          }
          actions={
            usage.display.show ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                disabled={usage.display.refreshDisabled}
                onClick={usage.onRefresh}
                title={t("settings.providerUsageRefresh")}
                aria-label={t("settings.providerUsageRefresh")}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", usage.refreshing && "animate-spin")} />
              </Button>
            ) : null
          }
        />
        <ProviderUsageQueryPanel
          provider={provider}
          onChange={onChange}
          isGatewayWebui={isGatewayWebui}
        />
      </section>
    </div>
  );
}
