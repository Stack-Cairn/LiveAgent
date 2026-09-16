// 中栏"渠道详情"（设计文档 7）：标题行、API 密钥、API 地址、模型列表（按分组折叠、
// 分组内可拖拽排序）、更多设置、可用性（故障转移）、用量查询。所有写入经父组件的
// onChange 走 normalizeCustomProvider。模型行的路由 / 能力 / 凭据覆盖按 provider
// 一次算成 Map，行组件 memo，避免大列表在无关状态变化时全量重算。

import { ProviderCopyConfigButton } from "@liveagent/adapters/providerSettings";
import type { getProviderUsageCardDisplay } from "@liveagent/app/lib/providers/usageQuery";
import {
  type CustomProvider,
  type ProviderChatProtocol,
  type ProviderModelConfig,
  type ProviderWireDialect,
  resolveProviderChatRoute,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  ArrowLeft,
  ChevronDown,
  FileText,
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
import { useVerticalListReorder } from "@liveagent/ui/components/ui/useVerticalListReorder";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { formatTokenCount } from "@liveagent/ui/pages/settings/providerUtils";
import { ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { UsagePlanLine, usageRelativeTimeText } from "../ProviderPresentation";
import { ProviderFailoverSection } from "./ProviderFailoverSection";
import { ProviderMoreSettings } from "./ProviderMoreSettings";
import { ProviderUsageQueryPanel } from "./ProviderUsageQueryPanel";
import {
  Chip,
  ChipButton,
  CommittedInput,
  dialectLabel,
  ProbeReason,
  ProbeStatusChip,
  ProviderAvatar,
  protocolLabel,
  protocolShortLabel,
  SecretInput,
  SectionTitle,
  SourceTag,
} from "./providerChips";
import {
  addProviderModel,
  configuredCredentials,
  credentialScopesMatch,
  credentialsCoveringModel,
  enabledCredentials,
  groupProviderModels,
  modelCapabilityFlags,
  type ProviderDrawerState,
  presetForProvider,
  primaryCredential,
  providerConfiguredProtocols,
  providerDefaultProtocol,
  readEndpoint,
  removeProviderModel,
  reorderProviderModels,
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

/** 模型行的派生信息：按 provider 一次算好，行组件只做渲染。 */
type ModelRowInfo = {
  active: boolean;
  vision: boolean;
  /** 文件输入：目录 attachment 位或 pdf 模态 */
  file: boolean;
  reasoning: boolean;
  tools: boolean;
  search: boolean;
  protocol: ProviderChatProtocol;
  protocolExplicit: boolean;
  hasEndpoint: boolean;
  dialect: ProviderWireDialect;
  /** null = 不需要提示；labels 为空 = 无匹配 Key */
  keyLabels: string[] | null;
};

function computeModelRowInfo(
  provider: CustomProvider,
  model: ProviderModelConfig,
  enabledKeyCount: number,
): ModelRowInfo {
  const route = resolveProviderChatRoute(provider, model.id);
  // 能力图标与编辑抽屉同源：有效能力（用户覆盖 > 目录 > 规则 / 启发式）+ 有效输入模态。
  const flags = modelCapabilityFlags(provider, model.id, route);
  const coveringKeys = enabledKeyCount < 2 ? [] : credentialsCoveringModel(provider, model.id);
  const keyLabels =
    enabledKeyCount < 2 || coveringKeys.length === enabledKeyCount
      ? null
      : coveringKeys.map((credential) => credential.label);
  return {
    active: provider.activeModels.includes(model.id),
    ...flags,
    protocol: route.protocol,
    protocolExplicit: route.protocolSource === "model",
    hasEndpoint: Boolean(readEndpoint(provider, route.protocol)),
    dialect: route.dialect,
    keyLabels,
  };
}

const ModelRow = memo(function ModelRow(props: {
  model: ProviderModelConfig;
  info: ModelRowInfo;
  dragging: boolean;
  onChange: ProviderUpdater;
  onOpenDrawer: (drawer: ProviderDrawerState) => void;
  renderDragHandle: (itemId: string, label: string) => ReactNode;
  getItemProps: (itemId: string) => {
    "data-vertical-reorder-id": string;
    style?: React.CSSProperties;
  };
}) {
  const { model, info, dragging, onChange, onOpenDrawer, renderDragHandle, getItemProps } = props;
  const { t } = useLocale();
  const keyChipText =
    info.keyLabels === null
      ? null
      : info.keyLabels.length === 0
        ? t("settings.modelKeyNoMatch")
        : `${t("settings.modelKeyLabel")}${info.keyLabels
            .map((label) => label || t("settings.providerCredentialPrimary"))
            .join(" / ")}`;

  return (
    <div
      {...getItemProps(model.id)}
      className={cn(
        "settings-model-row group @container/row flex items-center gap-2 bg-card px-2 py-1.5 transition-colors hover:bg-accent/30",
        !info.active && "opacity-60",
        dragging && "z-10 bg-accent shadow-lg",
      )}
    >
      {renderDragHandle(model.id, model.displayName || model.id)}
      <Switch
        size="sm"
        checked={info.active}
        onCheckedChange={(next) =>
          onChange((current) => setProviderModelActive(current, model.id, next === true))
        }
        aria-label={model.id}
      />
      <span className="min-w-0 flex-1 leading-tight">
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
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {info.vision ? (
          <span
            role="img"
            title={t("settings.modelCapability.imageUnderstanding")}
            aria-label={t("settings.modelCapability.imageUnderstanding")}
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {info.file ? (
          <span
            role="img"
            title={t("settings.modelCapability.fileInput")}
            aria-label={t("settings.modelCapability.fileInput")}
          >
            <FileText className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {info.reasoning ? (
          <span
            role="img"
            title={t("settings.modelCapability.reasoning")}
            aria-label={t("settings.modelCapability.reasoning")}
          >
            <Lightbulb className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {info.tools ? (
          <span
            role="img"
            title={t("settings.modelCapability.tools")}
            aria-label={t("settings.modelCapability.tools")}
          >
            <Wrench className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {info.search ? (
          <span
            role="img"
            title={t("settings.modelCapability.nativeWebSearch")}
            aria-label={t("settings.modelCapability.nativeWebSearch")}
          >
            <Globe className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </span>
      {info.hasEndpoint ? (
        <Chip
          tone={info.protocolExplicit ? "on" : "default"}
          className="max-w-[40cqw] shrink overflow-hidden"
          title={protocolLabel(info.protocol)}
        >
          <span className="truncate">
            {info.protocolExplicit ? "" : `${t("settings.modelRouteAuto")} · `}
            {protocolShortLabel(info.protocol)}
          </span>
        </Chip>
      ) : (
        <Chip tone="bad">{t("settings.modelNoEndpoint")}</Chip>
      )}
      {model.dialect ? (
        <Chip className="@max-[720px]/row:hidden">{dialectLabel(t, model.dialect)}</Chip>
      ) : null}
      {model.wireModelId ? (
        <Chip className="font-mono @max-[840px]/row:hidden">
          {t("settings.modelWireIdShort")} {model.wireModelId}
        </Chip>
      ) : null}
      {keyChipText ? <Chip tone="warn">{keyChipText}</Chip> : null}
      <span className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={() => onOpenDrawer({ kind: "model", modelId: model.id })}
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
});

type ModelGroupView = {
  key: string;
  models: ProviderModelConfig[];
  activeCount: number;
};

/** 一个分组一份拖拽上下文：分组内排序，写回时按显示顺序拼成全局 modelOrder。 */
function ModelGroup(props: {
  group: ModelGroupView;
  collapsed: boolean;
  infoById: ReadonlyMap<string, ModelRowInfo>;
  onToggle: (key: string) => void;
  onChange: ProviderUpdater;
  onOpenDrawer: (drawer: ProviderDrawerState) => void;
}) {
  const { group, collapsed, infoById, onToggle, onChange, onOpenDrawer } = props;
  const { t } = useLocale();
  const itemIds = useMemo(() => group.models.map((model) => model.id), [group.models]);
  const onReorder = useCallback(
    (nextIds: string[]) =>
      onChange((current) => reorderProviderModels(current, group.key, nextIds)),
    [onChange, group.key],
  );
  const { draggingItemId, getItemProps, renderDragHandle, scrollContainerRef } =
    useVerticalListReorder({
      itemIds,
      canReorder: true,
      reorderLabel: t("settings.reorderModel"),
      reorderHint: t("settings.reorderVerticalHint"),
      disabledHint: t("settings.reorderNeedsTwoItems"),
      onReorder,
    });

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 bg-muted/20 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/40"
        aria-expanded={!collapsed}
        onClick={() => onToggle(group.key)}
      >
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")}
        />
        <span className="font-medium text-foreground/80">
          {group.key === "other" ? t("settings.modelGroupOther") : group.key}
        </span>
        <Chip>
          {group.activeCount} / {group.models.length}
        </Chip>
      </button>
      {!collapsed ? (
        <div ref={scrollContainerRef} className="divide-y">
          {group.models.map((model) => {
            const info = infoById.get(model.id);
            if (!info) return null;
            return (
              <ModelRow
                key={model.id}
                model={model}
                info={info}
                dragging={draggingItemId === model.id}
                onChange={onChange}
                onOpenDrawer={onOpenDrawer}
                renderDragHandle={renderDragHandle}
                getItemProps={getItemProps}
              />
            );
          })}
        </div>
      ) : null}
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
  const configuredKeyCount = configuredCredentials(provider).length;
  const redactedKey = isGatewayWebui && primary.apiKey === "" && primary.apiKeyConfigured === true;
  const keyConfigured = primary.apiKeyConfigured === true || primary.apiKey.length > 0;
  const groups = useMemo<ModelGroupView[]>(
    () =>
      groupProviderModels(provider).map((group) => ({
        ...group,
        activeCount: group.models.filter((model) => provider.activeModels.includes(model.id))
          .length,
      })),
    [provider],
  );
  const infoById = useMemo(() => {
    const enabledKeyCount = enabledCredentials(provider).length;
    return new Map(
      provider.models.map((model) => [
        model.id,
        computeModelRowInfo(provider, model, enabledKeyCount),
      ]),
    );
  }, [provider]);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
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
      <div className="settings-provider-detail-title flex flex-wrap items-center gap-2">
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
        <ProviderAvatar preset={preset} className="h-10 w-10" />
        <CommittedInput
          value={provider.name}
          className="h-8 w-56 min-w-0 max-w-full border-transparent bg-transparent px-2 text-base font-semibold tracking-tight shadow-none hover:border-border focus-visible:border-border max-[760px]:w-auto max-[760px]:flex-1 max-[760px]:basis-40"
          aria-label={t("settings.channelName")}
          onCommit={(value) => {
            const name = value.trim();
            if (name) onChange((current) => ({ ...current, name }));
          }}
        />
        <Chip>{preset.name}</Chip>
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
        <span className="settings-provider-detail-actions ml-auto flex items-center gap-2">
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
          <span className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-[11px] text-muted-foreground">{t("settings.enable")}</span>
            <Switch
              checked={enabled}
              onCheckedChange={(next) =>
                onChange((current) => ({
                  ...current,
                  enabled: next === true ? undefined : false,
                }))
              }
              aria-label={`${provider.name} ${t("settings.enable")}`}
            />
          </span>
        </span>
      </div>

      {!enabled ? (
        <p
          className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
          role="status"
        >
          {t("settings.providerDisabledBanner")}
        </p>
      ) : null}

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
              {t("settings.providerManageKeys").replace("{count}", String(configuredKeyCount))}
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
            <Chip tone="warn">{t("settings.providerKeyMissing")}</Chip>
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
          <div className="settings-provider-address-row flex flex-wrap items-center gap-2">
            <CommittedInput
              value={defaultEndpoint?.config.baseUrl ?? provider.baseUrl}
              className="h-8 min-w-0 flex-1 basis-56 font-mono text-xs shadow-none"
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
          <ProbeReason probe={defaultEndpoint?.config.lastProbe} />
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
                    className={cn(!isEnabled && "opacity-60")}
                    onClick={() => onOpenDrawer({ kind: "request", focus: protocol })}
                    title={
                      isEnabled
                        ? t("settings.providerDialogRequest")
                        : `${protocolLabel(protocol)} · ${t("settings.providerDisabled")}`
                    }
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
            groups.map((group) => (
              <ModelGroup
                key={group.key}
                group={group}
                collapsed={collapsedGroups.has(group.key)}
                infoById={infoById}
                onToggle={toggleGroup}
                onChange={onChange}
                onOpenDrawer={onOpenDrawer}
              />
            ))
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
