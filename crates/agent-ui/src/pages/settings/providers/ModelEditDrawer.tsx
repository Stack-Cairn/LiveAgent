// 抽屉三"编辑模型"（设计文档 6 / 7）：ID、远端 ID、显示名、系列（分组）、目录信息
// （只读，6.6）、能力芯片（有效状态 + 来源，6.1）、输入模态（有效值 + 来源）、接口
// 多选（只列已启用渠道，首项路由）、方言、凭据、限额（逐字段来源）、缓存提示、
// 思考档位（目录只读）+ 默认档；底部展示 resolveProviderChatRoute 的解析结果与
// 三层故障转移候选（设计文档 6.4）。每个覆盖项显示来源（自动 / 用户）与还原。

import {
  type AppSettings,
  type ChatCapabilityName,
  type CustomProvider,
  getProviderImplicitChatProtocol,
  getProviderModelDefaults,
  isProviderChatProtocolEnabled,
  modelSelectableProtocols,
  PROMPT_CACHE_HINT_MODES,
  PROVIDER_PROTOCOL_FAMILY_LABELS,
  type PromptCacheHintMode,
  type ProviderChatProtocol,
  type ProviderModelConfig,
  type ProviderWireDialect,
  type ReasoningLevel,
  resolveProviderChatRoute,
  resolveProviderDialect,
} from "@liveagent/app/lib/settings";
import { X } from "@liveagent/ui/components/IconSet";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  resolveModelCapabilities,
  resolveModelCatalogInfo,
  resolveModelInputModalitiesResolved,
} from "@liveagent/ui/lib/models/modelCapabilities";
import {
  resolveModelThinking,
  THINKING_LEVEL_LADDER,
} from "@liveagent/ui/lib/models/modelThinking";
import { mergeCustomHeaders } from "@liveagent/ui/lib/providers/customHeaders";
import {
  buildProtocolAuthHeaders,
  PROVIDER_PROTOCOL_DIALECTS,
} from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  applyModelInputModalitiesMode,
  formatTokenCount,
  getModelInputModalitiesMode,
  providerSupportsModelInputModalitiesOverride,
} from "@liveagent/ui/pages/settings/providerUtils";
import { type ReactNode, useMemo } from "react";
import { DrawerGroupLabel, HintTip, PROMPT_CACHE_HINT_LABEL_KEYS } from "../ProviderPresentation";
import { ModalityChips, ModelCatalogInfoPanel } from "./ModelCatalogInfoPanel";
import {
  Chip,
  ChipButton,
  CommittedInput,
  dialectLabel,
  protocolLabel,
  SourceTag,
} from "./providerChips";
import {
  capabilityChipView,
  credentialsCoveringModel,
  type ModelLimitField,
  modelFailoverCandidates,
  modelGroupIsUser,
  modelGroupKey,
  modelLimitFieldSources,
  providerCredentials,
  resetModelLimitField,
  updateProviderModel,
} from "./providerSettingsModel";

const CAPABILITIES: readonly ChatCapabilityName[] = [
  "reasoning",
  "tools",
  "structuredOutput",
  "nativeWebSearch",
  "fileInput",
  "imageUnderstanding",
];

function parsePositiveInteger(input: string): number | null {
  const value = Number(input.trim());
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function Field(props: { label: string; hint?: string; source?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {props.label}
          {props.hint ? <HintTip text={props.hint} label={props.label} /> : null}
        </Label>
        <span className="flex-1" />
        {props.source}
      </div>
      {props.children}
    </div>
  );
}

export function ModelEditDrawer(props: {
  settings: AppSettings;
  provider: CustomProvider;
  modelId: string;
  onChange: (updater: (provider: CustomProvider) => CustomProvider) => void;
  onClose: () => void;
}) {
  const { settings, provider, modelId, onChange, onClose } = props;
  const { t } = useLocale();
  const model = provider.models.find((item) => item.id === modelId);
  const route = useMemo(
    () => (model ? resolveProviderChatRoute(provider, modelId) : undefined),
    [provider, modelId, model],
  );
  const failover = useMemo(
    () => (route ? modelFailoverCandidates(settings, provider, modelId, route) : undefined),
    [settings, provider, modelId, route],
  );
  const credentials = providerCredentials(provider);
  const coveringCredentials = credentialsCoveringModel(provider, modelId);

  function patch(updater: (current: ProviderModelConfig) => ProviderModelConfig) {
    onChange((current) => updateProviderModel(current, modelId, updater));
  }

  function drop<K extends keyof ProviderModelConfig>(...keys: K[]) {
    patch((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  }

  if (!model || !route) return null;

  const adapterId = route.adapterProviderId;
  const thinking = resolveModelThinking(adapterId, model.id);
  // 能力 / 目录 / 输入模态都走 modelCapabilities 的单一解析入口（用户覆盖 >
  // 目录 > 供应商规则 / 启发式），与运行时读到的是同一份结果。
  const capabilities = resolveModelCapabilities(provider, model.id, route);
  const catalogInfo = resolveModelCatalogInfo(provider, model.id);
  const effectiveInput = resolveModelInputModalitiesResolved(provider, model.id, route);
  const canOverrideModalities = providerSupportsModelInputModalitiesOverride(adapterId);
  const modalitiesMode = getModelInputModalitiesMode(model);
  const selectableProtocols = modelSelectableProtocols(provider, model.id);
  const implicitProtocol = getProviderImplicitChatProtocol(provider);
  const protocolConfigured = (protocol: ProviderChatProtocol) =>
    isProviderChatProtocolEnabled(provider, protocol, implicitProtocol);
  const inheritedDialect = resolveProviderDialect(provider, route.protocol, {
    endpoint: provider.endpointConfigs?.[route.protocol],
  });
  const defaults = getProviderModelDefaults(adapterId, model.id, route.baseUrl);
  const limitSources = modelLimitFieldSources(model, defaults);
  const reasoningOptions: ReasoningLevel[] = [
    ...(thinking.alwaysOn ? [] : (["off"] as const)),
    ...thinking.levels,
  ];
  const credential = credentials.find((item) => item.id === route.credentialId);
  // 与运行时同一份合并规则：鉴权头打底，用户头（供应商级 + 端点级，已按大小写去重）
  // 覆盖；键为空 / 不合法 / 保留键的行不进入预览。
  const finalHeaders = Object.entries(
    mergeCustomHeaders(
      buildProtocolAuthHeaders(route.protocol, "••••••", route.auth),
      route.headers,
    ),
  );

  // 点击循环：用户支持 → 用户不支持 → 清除覆盖（回到目录 / 规则值）。
  function cycleCapability(name: ChatCapabilityName) {
    patch((current) => {
      const value = current.capabilities?.[name];
      const next = { ...current.capabilities };
      if (value === undefined) next[name] = "supported";
      else if (value === "supported") next[name] = "unsupported";
      else delete next[name];
      return {
        ...current,
        ...(Object.keys(next).length > 0 ? { capabilities: next } : { capabilities: undefined }),
      };
    });
  }

  const protocolSourceLabel = t(`settings.modelRouteSource.${route.protocolSource}`);
  const limitSourceTag = (field: ModelLimitField) => {
    const source = limitSources[field];
    return source ? (
      <SourceTag
        source={source}
        onReset={() => patch((current) => resetModelLimitField(current, defaults, field))}
      />
    ) : null;
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        variant="inset"
        className="settings-provider-drawer max-w-none border-border bg-background sm:max-w-[600px]"
        closeLabel={t("settings.close")}
        showCloseButton={false}
      >
        <div className="settings-provider-drawer-header relative flex items-center gap-3 px-6 pb-4 pt-[22px]">
          <SheetTitle className="min-w-0 flex-1 truncate text-[17px] leading-tight tracking-tight text-foreground/95">
            {t("settings.modelEditTitle")} · {model.displayName || model.id}
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
          <div className="space-y-5">
            <section className="space-y-3">
              <DrawerGroupLabel label={t("settings.modelIdentity")} />
              <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                <Field label={t("settings.modelId")}>
                  <div className="flex h-8 items-center rounded-lg border bg-muted/30 px-3 font-mono text-xs">
                    {model.id}
                  </div>
                </Field>
                <Field
                  label={t("settings.modelWireId")}
                  source={
                    <SourceTag
                      source={model.wireModelId ? "user" : "auto"}
                      onReset={() => drop("wireModelId")}
                    />
                  }
                >
                  <CommittedInput
                    value={model.wireModelId ?? ""}
                    className="h-8 font-mono text-xs shadow-none"
                    placeholder={t("settings.modelWireIdPlaceholder")}
                    aria-label={t("settings.modelWireId")}
                    autoComplete="off"
                    spellCheck={false}
                    onCommit={(value) =>
                      patch((current) => ({
                        ...current,
                        wireModelId:
                          value.trim() && value.trim() !== current.id ? value.trim() : undefined,
                      }))
                    }
                  />
                </Field>
                <Field label={t("settings.modelDisplayName")}>
                  <CommittedInput
                    value={model.displayName ?? ""}
                    className="h-8 text-xs shadow-none"
                    placeholder={model.id}
                    aria-label={t("settings.modelDisplayName")}
                    onCommit={(value) =>
                      patch((current) => ({ ...current, displayName: value.trim() || undefined }))
                    }
                  />
                </Field>
                <Field
                  label={t("settings.modelGroup")}
                  hint={t("settings.modelGroupHint")}
                  source={
                    <SourceTag
                      source={modelGroupIsUser(model) ? "user" : "auto"}
                      onReset={() => drop("group")}
                    />
                  }
                >
                  <CommittedInput
                    value={modelGroupKey(model)}
                    className="h-8 text-xs shadow-none"
                    aria-label={t("settings.modelGroup")}
                    onCommit={(value) =>
                      patch((current) => ({ ...current, group: value.trim() || undefined }))
                    }
                  />
                </Field>
              </div>
              <Field label={t("settings.modelType")}>
                <div className="flex flex-wrap gap-1.5">
                  <Chip tone="on">{t("settings.modelTypeChat")}</Chip>
                  {(["image", "embedding", "rerank"] as const).map((kind) => (
                    <Chip key={kind} className="opacity-50">
                      {t(`settings.modelType.${kind}`)}
                    </Chip>
                  ))}
                </div>
              </Field>
            </section>

            <ModelCatalogInfoPanel info={catalogInfo} modelId={model.id} />

            <section className="space-y-3">
              <DrawerGroupLabel
                label={t("settings.modelCapabilities")}
                hint={t("settings.modelCapabilitiesHint")}
              />
              <div className="flex flex-wrap gap-1.5">
                {CAPABILITIES.map((name) => {
                  const resolved = capabilities[name];
                  const view = capabilityChipView(resolved);
                  return (
                    <ChipButton
                      key={name}
                      tone={view.tone}
                      strike={view.strike}
                      className={cn(view.muted && "opacity-70")}
                      onClick={() => cycleCapability(name)}
                      title={`${t(`settings.modelCapabilitySource.${resolved.source}`)} · ${t(
                        `settings.modelCapabilityState.${resolved.state}`,
                      )}`}
                    >
                      {t(`settings.modelCapability.${name}`)}
                      {view.unknown ? " · ?" : ""}
                    </ChipButton>
                  );
                })}
                {model.capabilities ? (
                  <ChipButton onClick={() => drop("capabilities")}>
                    {t("settings.modelCapabilitiesResetCatalog")}
                  </ChipButton>
                ) : null}
              </div>
              <Field
                label={t("settings.modelInputModalities")}
                source={
                  canOverrideModalities ? (
                    <SourceTag
                      source={modalitiesMode === "auto" ? "auto" : "user"}
                      onReset={() =>
                        patch((current) => applyModelInputModalitiesMode(current, "auto"))
                      }
                    />
                  ) : null
                }
              >
                {canOverrideModalities ? (
                  <Select
                    value={modalitiesMode}
                    onValueChange={(value) => {
                      if (value === "auto" || value === "text" || value === "text-image") {
                        patch((current) => applyModelInputModalitiesMode(current, value));
                      }
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs shadow-none">
                      <SelectValue>
                        {t(
                          modalitiesMode === "auto"
                            ? "settings.modelInputModalitiesAuto"
                            : modalitiesMode === "text"
                              ? "settings.modelInputModalitiesText"
                              : "settings.modelInputModalitiesTextImage",
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("settings.modelInputModalitiesAuto")}</SelectItem>
                      <SelectItem value="text">{t("settings.modelInputModalitiesText")}</SelectItem>
                      <SelectItem value="text-image">
                        {t("settings.modelInputModalitiesTextImage")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-[11px] text-muted-foreground/75">
                    {t("settings.modelInputModalitiesUnavailable")}
                  </p>
                )}
                <p className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground/70">
                  {t("settings.modelInputModalitiesEffective")}
                  <ModalityChips modalities={effectiveInput.modalities} />
                  <span>· {t(`settings.modelCapabilitySource.${effectiveInput.source}`)}</span>
                </p>
              </Field>
            </section>

            <section className="space-y-3">
              <DrawerGroupLabel
                label={t("settings.modelRouting")}
                hint={t("settings.modelChatProtocolsHint")}
              />
              <Field
                label={t("settings.modelChatProtocol")}
                source={
                  <SourceTag
                    source={model.chatProtocol ? "user" : "auto"}
                    onReset={() => drop("chatProtocol")}
                  />
                }
              >
                {selectableProtocols.length <= 1 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone="on">{protocolLabel(selectableProtocols[0] ?? route.protocol)}</Chip>
                    <span className="text-[11px] text-muted-foreground/75">
                      {t("settings.modelChatProtocolFixed")}
                    </span>
                  </div>
                ) : (
                  <Select
                    value={model.chatProtocol ?? "auto"}
                    onValueChange={(value) =>
                      patch((current) => ({
                        ...current,
                        chatProtocol:
                          value === "auto" ? undefined : (value as ProviderChatProtocol),
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs shadow-none">
                      <SelectValue>
                        {model.chatProtocol
                          ? protocolLabel(model.chatProtocol)
                          : t("settings.modelChatProtocolAutoOption").replace(
                              "{protocol}",
                              protocolLabel(route.protocol),
                            )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">
                        {t("settings.modelChatProtocolAutoOption").replace(
                          "{protocol}",
                          protocolLabel(route.protocol),
                        )}
                      </SelectItem>
                      {selectableProtocols.map((protocol) => (
                        <SelectItem
                          key={protocol}
                          value={protocol}
                          disabled={!protocolConfigured(protocol)}
                        >
                          {protocolLabel(protocol)}
                          {protocolConfigured(protocol)
                            ? ""
                            : ` ${t("settings.modelChatProtocolUnconfigured")}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-[11px] text-muted-foreground/75">
                  {model.chatProtocol && model.chatProtocol !== route.protocol
                    ? t("settings.modelChatProtocolUnavailable").replace(
                        "{protocol}",
                        protocolLabel(route.protocol),
                      )
                    : model.chatProtocol
                      ? t("settings.modelChatProtocolExplicit")
                      : t("settings.modelChatProtocolsAuto")
                          .replace("{protocol}", protocolLabel(route.protocol))
                          .replace("{source}", protocolSourceLabel)}
                </p>
              </Field>
              <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                <Field
                  label={t("settings.providerDialect")}
                  source={
                    <SourceTag
                      source={model.dialect ? "user" : "auto"}
                      onReset={() => drop("dialect")}
                    />
                  }
                >
                  <Select
                    value={model.dialect ?? "inherit"}
                    onValueChange={(value) =>
                      patch((current) => ({
                        ...current,
                        dialect: value === "inherit" ? undefined : (value as ProviderWireDialect),
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs shadow-none">
                      <SelectValue>
                        {model.dialect
                          ? dialectLabel(t, model.dialect)
                          : t("settings.providerDialectInherit").replace(
                              "{dialect}",
                              dialectLabel(t, inheritedDialect),
                            )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">
                        {t("settings.providerDialectInherit").replace(
                          "{dialect}",
                          dialectLabel(t, inheritedDialect),
                        )}
                      </SelectItem>
                      {PROVIDER_PROTOCOL_DIALECTS[route.protocol].map((dialect) => (
                        <SelectItem key={dialect} value={dialect}>
                          {dialectLabel(t, dialect)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label={t("settings.modelCredential")}
                  source={
                    <SourceTag
                      source={model.credentialId ? "user" : "auto"}
                      onReset={() => drop("credentialId")}
                    />
                  }
                >
                  <Select
                    value={model.credentialId ?? "auto"}
                    onValueChange={(value) =>
                      patch((current) => ({
                        ...current,
                        credentialId: value === "auto" ? undefined : value,
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs shadow-none">
                      <SelectValue>
                        {model.credentialId
                          ? credentials.find((item) => item.id === model.credentialId)?.label ||
                            t("settings.providerCredentialPrimary")
                          : t("settings.modelCredentialAuto")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("settings.modelCredentialAuto")}</SelectItem>
                      {credentials.map((item, index) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label ||
                            (index === 0
                              ? t("settings.providerCredentialPrimary")
                              : `${t("settings.providerCredentialBackup")} ${index}`)}
                          {coveringCredentials.some((covering) => covering.id === item.id)
                            ? ""
                            : `（${t("settings.modelCredentialOutOfScope")}）`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10.5px] text-muted-foreground/70">
                    {t("settings.modelCredentialCovering")}
                    {coveringCredentials.length > 0
                      ? coveringCredentials
                          .map((item) => item.label || t("settings.providerCredentialPrimary"))
                          .join(" / ")
                      : t("settings.modelCredentialNoneCovering")}
                  </p>
                </Field>
              </div>
            </section>

            <section className="space-y-3">
              <DrawerGroupLabel
                label={t("settings.modelLimits")}
                hint={t("settings.modelLimitsHint")}
              />
              <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
                <Field label={t("settings.contextWindow")} source={limitSourceTag("contextWindow")}>
                  <CommittedInput
                    value={String(model.contextWindow)}
                    inputMode="numeric"
                    className="h-8 text-xs shadow-none"
                    aria-label={t("settings.contextWindow")}
                    onCommit={(value) => {
                      const parsed = parsePositiveInteger(value);
                      if (parsed === null) return;
                      patch((current) => ({
                        ...current,
                        contextWindow: parsed,
                        limitsSource: "user",
                      }));
                    }}
                  />
                </Field>
                <Field
                  label={t("settings.modelMaxInputTokens")}
                  source={limitSourceTag("maxInputTokens")}
                >
                  <CommittedInput
                    value={model.maxInputTokens ? String(model.maxInputTokens) : ""}
                    inputMode="numeric"
                    className="h-8 text-xs shadow-none"
                    placeholder={t("settings.modelMaxInputTokensUnset")}
                    aria-label={t("settings.modelMaxInputTokens")}
                    onCommit={(value) => {
                      const parsed = value.trim() ? parsePositiveInteger(value) : undefined;
                      if (parsed === null) return;
                      patch((current) => ({
                        ...current,
                        maxInputTokens: parsed,
                        limitsSource: "user",
                      }));
                    }}
                  />
                </Field>
                <Field
                  label={t("settings.maxOutputToken")}
                  source={limitSourceTag("maxOutputToken")}
                >
                  <CommittedInput
                    value={String(model.maxOutputToken)}
                    inputMode="numeric"
                    className="h-8 text-xs shadow-none"
                    aria-label={t("settings.maxOutputToken")}
                    onCommit={(value) => {
                      const parsed = parsePositiveInteger(value);
                      if (parsed === null) return;
                      patch((current) => ({
                        ...current,
                        maxOutputToken: parsed,
                        limitsSource: "user",
                      }));
                    }}
                  />
                </Field>
              </div>
              <p className="text-[10.5px] text-muted-foreground/70">
                {formatTokenCount(model.contextWindow)} ctx ·{" "}
                {formatTokenCount(model.maxOutputToken)} out
              </p>
              {adapterId === "codex" ? (
                <Field
                  label={t("settings.promptCacheHintModelOverride")}
                  source={
                    <SourceTag
                      source={model.promptCacheHintMode ? "user" : "auto"}
                      onReset={() => drop("promptCacheHintMode")}
                    />
                  }
                >
                  <Select
                    value={model.promptCacheHintMode ?? "inherit"}
                    onValueChange={(value) =>
                      patch((current) => ({
                        ...current,
                        promptCacheHintMode:
                          value === "inherit" ? undefined : (value as PromptCacheHintMode),
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs shadow-none">
                      <SelectValue>
                        {t(
                          model.promptCacheHintMode
                            ? PROMPT_CACHE_HINT_LABEL_KEYS[model.promptCacheHintMode]
                            : "settings.promptCacheHintMode.inherit",
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">
                        {t("settings.promptCacheHintMode.inherit")}
                      </SelectItem>
                      {PROMPT_CACHE_HINT_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {t(PROMPT_CACHE_HINT_LABEL_KEYS[mode])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </section>

            <section className="space-y-3">
              <DrawerGroupLabel
                label={t("settings.modelThinkingLevels")}
                hint={t("settings.modelThinkingLevelsHint")}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <SourceTag source={thinking.fromCatalog ? "catalog" : "heuristic"} />
                {thinking.reasoning ? (
                  <>
                    <Chip tone={thinking.alwaysOn ? "warn" : "default"}>
                      {thinking.alwaysOn
                        ? t("settings.modelThinkingAlwaysOn")
                        : t("settings.modelThinkingCanDisable")}
                    </Chip>
                    {THINKING_LEVEL_LADDER.map((level) => (
                      <Chip
                        key={level}
                        tone={thinking.levels.includes(level) ? "on" : "default"}
                        className={cn(!thinking.levels.includes(level) && "opacity-40")}
                      >
                        {t(`settings.reasoning.${level}`)}
                      </Chip>
                    ))}
                  </>
                ) : (
                  <span className="text-[11px] text-muted-foreground/75">
                    {t("settings.modelThinkingNone")}
                  </span>
                )}
              </div>
              {thinking.reasoning ? (
                <Field
                  label={t("settings.modelReasoningDefault")}
                  source={
                    <SourceTag
                      source={model.reasoning ? "user" : "auto"}
                      onReset={() => drop("reasoning")}
                    />
                  }
                >
                  <Select
                    value={model.reasoning ?? "inherit"}
                    onValueChange={(value) =>
                      patch((current) => ({
                        ...current,
                        reasoning: value === "inherit" ? undefined : (value as ReasoningLevel),
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs shadow-none">
                      <SelectValue>
                        {model.reasoning
                          ? t(`settings.reasoning.${model.reasoning}`)
                          : t("settings.modelReasoningInherit").replace(
                              "{level}",
                              t(`settings.reasoning.${provider.reasoning}`),
                            )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">
                        {t("settings.modelReasoningInherit").replace(
                          "{level}",
                          t(`settings.reasoning.${provider.reasoning}`),
                        )}
                      </SelectItem>
                      {reasoningOptions.map((level) => (
                        <SelectItem key={level} value={level}>
                          {t(`settings.reasoning.${level}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </section>

            <section className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.modelRouteResult")}
                hint={t("settings.modelRouteResultHint")}
              />
              <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border bg-muted/20 px-3 py-2.5 text-xs">
                <span className="text-muted-foreground">{t("settings.modelRouteProtocol")}</span>
                <span className="flex flex-wrap items-center gap-1.5 font-mono">
                  {route.protocol}
                  <SourceTag source={route.protocolSource === "model" ? "user" : "auto"} />
                  <span className="font-sans text-[10.5px] text-muted-foreground">
                    {protocolSourceLabel}
                  </span>
                </span>
                <span className="text-muted-foreground">{t("settings.providerDialect")}</span>
                <span className="flex flex-wrap items-center gap-1.5 font-mono">
                  {route.dialect}
                  <span className="font-sans text-[10.5px] text-muted-foreground">
                    {dialectLabel(t, route.dialect)}
                  </span>
                </span>
                <span className="text-muted-foreground">{t("settings.baseUrl")}</span>
                <span className="break-all font-mono">{route.baseUrl || "—"}</span>
                <span className="text-muted-foreground">{t("settings.modelWireId")}</span>
                <span className="font-mono">{route.wireModelId}</span>
                <span className="text-muted-foreground">{t("settings.modelCredential")}</span>
                <span className="flex flex-wrap items-center gap-1.5 font-mono">
                  {credential?.label || t("settings.providerCredentialPrimary")}
                  <span className="font-sans text-[10.5px] text-muted-foreground">
                    {t(`settings.modelRouteCredentialSource.${route.credentialSource}`)}
                  </span>
                </span>
                <span className="text-muted-foreground">quirks</span>
                <span className="break-all font-mono">
                  {Object.keys(route.quirks).length > 0
                    ? JSON.stringify(route.quirks)
                    : t("settings.providerQuirkAuto")}
                </span>
                <span className="text-muted-foreground">{t("settings.modelRouteHeaders")}</span>
                <span className="space-y-0.5 font-mono">
                  {finalHeaders.map(([key, value]) => (
                    <span key={key} className="block break-all">
                      {key}: {value}
                    </span>
                  ))}
                </span>
              </div>
            </section>

            {failover ? (
              <section className="space-y-2">
                <DrawerGroupLabel
                  label={t("settings.modelFailoverCandidates")}
                  hint={t("settings.modelFailoverCandidatesHint")}
                />
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border bg-muted/20 px-3 py-2.5 text-xs">
                  <span className="text-muted-foreground">
                    {t("settings.modelFailoverLayer.credential")}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {failover.credentials.length > 0 ? (
                      failover.credentials.map((item) => (
                        <Chip key={item.id}>
                          {item.label ||
                            (credentials.indexOf(item) === 0
                              ? t("settings.providerCredentialPrimary")
                              : `${t("settings.providerCredentialBackup")} ${credentials.indexOf(item)}`)}
                        </Chip>
                      ))
                    ) : (
                      <span className="text-muted-foreground/70">
                        {t("settings.modelFailoverNone")}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {t("settings.modelFailoverLayer.endpoint")}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {failover.endpoints.length > 0 ? (
                      failover.endpoints.map((protocol, index) => (
                        <Chip key={protocol}>
                          {index + 1} · {protocolLabel(protocol)}
                        </Chip>
                      ))
                    ) : (
                      <span className="text-muted-foreground/70">
                        {t("settings.modelFailoverNone")}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {t("settings.modelFailoverLayer.provider")}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {!failover.providerLayerEnabled ? (
                      <span className="text-muted-foreground/70">
                        {t("settings.modelFailoverProviderLayerOff").replace(
                          "{family}",
                          PROVIDER_PROTOCOL_FAMILY_LABELS[failover.family],
                        )}
                      </span>
                    ) : failover.providers.length > 0 ? (
                      failover.providers.map((item, index) => (
                        <Chip key={item.id}>
                          P{index + 1} · {item.name}
                        </Chip>
                      ))
                    ) : (
                      <span className="text-muted-foreground/70">
                        {t("settings.modelFailoverNone")}
                      </span>
                    )}
                  </span>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
