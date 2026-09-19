// 抽屉三"编辑模型"（设计文档 6 / 7），每个属性只出现一次，固定六节：
// 1. 标识：ID、远端 ID、显示名、系列（分组）。
// 2. 目录：一行摘要（分区 / 条目 · 快照 · 发布 · 状态 · 价格）+ "查看目录"。
// 3. 能力与模态：一张表，列 = 属性 | 目录值 | 有效值 | 覆盖（三态）；视觉行的覆盖
//    同时写 capabilities.imageUnderstanding 与 inputModalities；音频 / 视频只读。
// 4. 限额：属性 | 目录值 | 当前值 | 来源，逐行还原。
// 5. 思考：目录档位阶梯（只读）；默认档由会话控制，不在模型级设置。
// 6. 路由：接口、方言、凭据、缓存提示；其下"实际请求预览"与"故障转移候选"
//    两个折叠块（默认收起）。

import {
  type AppSettings,
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
  resolveProviderChatRoute,
  resolveProviderDialect,
} from "@liveagent/app/lib/settings";
import { BookOpen, ChevronDown, X } from "@liveagent/ui/components/IconSet";
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
  type FieldCandidateSource,
  resolveModelCatalogInfo,
} from "@liveagent/ui/lib/models/modelCapabilities";
import type { CatalogProviderId } from "@liveagent/ui/lib/models/modelCatalog";
import {
  MODEL_PARAMETER_KEYS,
  type ModelParameterKey,
  PROTOCOL_TEMPERATURE_RANGE,
} from "@liveagent/ui/lib/models/modelParameters";
import {
  resolveModelThinking,
  THINKING_LEVEL_LADDER,
} from "@liveagent/ui/lib/models/modelThinking";
import { resolveModelType } from "@liveagent/ui/lib/models/modelType";
import { mergeCustomHeaders } from "@liveagent/ui/lib/providers/customHeaders";
import {
  PROVIDER_PROTOCOL_DIALECTS,
  resolveEndpointRequestBase,
} from "@liveagent/ui/lib/providers/registry";
import { buildBuiltinRequestHeaders } from "@liveagent/ui/lib/providers/requestHeaders";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { formatTokenCount } from "@liveagent/ui/pages/settings/providerUtils";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { DrawerGroupLabel, HintTip, PROMPT_CACHE_HINT_LABEL_KEYS } from "../ProviderPresentation";
import { ModelCatalogSummary } from "./ModelCatalogInfoPanel";
import { originHostLabel } from "./ProviderOriginList";
import {
  Chip,
  ChipButton,
  CommittedInput,
  dialectLabel,
  protocolLabel,
  SourceTag,
  StateChip,
} from "./providerChips";
import {
  adoptModelCapabilityCandidate,
  adoptModelLimitCandidate,
  capabilityChipView,
  credentialsCoveringModel,
  hasModelCapabilityOverrides,
  type ModelCapabilityOverride,
  type ModelCapabilityRow,
  type ModelLimitField,
  modelCapabilityRows,
  modelFailoverCandidates,
  modelGroupIsUser,
  modelGroupKey,
  modelLimitFieldInfos,
  modelParameterApplies,
  providerCredentials,
  providerUsesOrigins,
  resetModelCapabilityOverrides,
  resetModelLimitField,
  setModelCapabilityOverride,
  setModelParameter,
  updateProviderModel,
} from "./providerSettingsModel";

const LIMIT_FIELDS: readonly ModelLimitField[] = [
  "contextWindow",
  "maxInputTokens",
  "maxOutputToken",
];

const LIMIT_FIELD_LABEL_KEYS: Record<ModelLimitField, string> = {
  contextWindow: "settings.contextWindow",
  maxInputTokens: "settings.modelMaxInputTokens",
  maxOutputToken: "settings.maxOutputToken",
};

const CAPABILITY_ROW_LABEL_KEYS: Record<ModelCapabilityRow["key"], string> = {
  imageUnderstanding: "settings.modelCapabilityRow.imageUnderstanding",
  fileInput: "settings.modelCapabilityRow.fileInput",
  audioInput: "settings.modelCapabilityRow.audioInput",
  videoInput: "settings.modelCapabilityRow.videoInput",
  reasoning: "settings.modelCapability.reasoning",
  tools: "settings.modelCapability.tools",
  structuredOutput: "settings.modelCapability.structuredOutput",
  nativeWebSearch: "settings.modelCapability.nativeWebSearch",
  imageGeneration: "settings.modelCapability.imageGeneration",
};

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

// ---------------------------------------------------------------------------
// 属性表：四列（属性 | 目录值 | 有效值或当前值 | 覆盖或来源），内容宽 < 500px（抽屉 < 560px）
// 时每行改为上下堆叠（容器查询，随抽屉而非视口）。
// ---------------------------------------------------------------------------

// 四列固定模板：末列宽度按表固定（能力表 = 三态分段控件宽，限额表 = 来源徽标 + 还原），
// 每行各自成 grid 时才不会因为末列内容宽窄不同（"—" vs 分段控件）把中间列挤歪。
const TABLE_ROW_BASE_CLASS =
  "grid items-center gap-x-3 gap-y-1 px-3 py-1.5 @max-[500px]:grid-cols-1 @max-[500px]:py-2";
const CAPABILITY_ROW_CLASS = cn(TABLE_ROW_BASE_CLASS, "grid-cols-[128px_44px_minmax(0,1fr)_136px]");
const LIMIT_ROW_CLASS = cn(TABLE_ROW_BASE_CLASS, "grid-cols-[128px_44px_minmax(0,1fr)_96px]");

function PropertyTable(props: {
  columns: readonly string[];
  rowClass: string;
  children: ReactNode;
}) {
  return (
    <div className="@container">
      <div className="divide-y overflow-hidden rounded-xl border bg-muted/20 text-xs">
        <div
          className={cn(
            props.rowClass,
            "bg-muted/30 text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70 @max-[500px]:hidden",
          )}
        >
          {props.columns.map((column, index) => (
            <span
              key={column}
              className={index === props.columns.length - 1 ? "justify-self-end" : undefined}
            >
              {column}
            </span>
          ))}
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** 表格单元：窄屏堆叠时在值前显示列名小字。 */
function Cell(props: { column: string; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn("flex min-h-[22px] min-w-0 flex-wrap items-center gap-1.5", props.className)}
    >
      <span className="hidden w-14 shrink-0 text-[10.5px] text-muted-foreground/70 @max-[500px]:inline">
        {props.column}
      </span>
      {props.children}
    </div>
  );
}

function CatalogMark(props: { value: ModelCapabilityOverride | undefined }) {
  const { t } = useLocale();
  if (props.value === undefined) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        props.value === "supported" ? "text-foreground/85" : "text-muted-foreground",
      )}
      title={t(`settings.modelCapabilityState.${props.value}`)}
    >
      <span aria-hidden="true">{props.value === "supported" ? "✓" : "✗"}</span>
      <span className="sr-only">{t(`settings.modelCapabilityState.${props.value}`)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 设计 §6.2：候选展示。"目录值"列保持原样显示目录值，有其它来源的候选时在右侧
// 加一个极小的数量标记（"+1"），hover 给出完整列表（title），点击在该行下方展开
// 一行"来源 值"。列数与列宽不变，展开行是表内的普通行。
// ---------------------------------------------------------------------------

type CandidateEntry = { source: FieldCandidateSource; label: string };

function CandidateMark(props: {
  primary: ReactNode;
  /** 除目录之外的候选（目录值已由 primary 呈现） */
  extras: readonly CandidateEntry[];
  conflict: boolean;
  expanded: boolean;
  onToggle: () => void;
  summary: string;
  label: string;
}) {
  if (props.extras.length === 0) return <>{props.primary}</>;
  return (
    <button
      type="button"
      title={props.summary}
      aria-expanded={props.expanded}
      aria-label={props.label}
      onClick={props.onToggle}
      className="inline-flex min-w-0 items-baseline gap-0.5 text-left"
    >
      {props.primary}
      <span
        aria-hidden="true"
        className={cn(
          "text-[9px] leading-none",
          props.conflict
            ? "font-semibold text-amber-600 dark:text-amber-400"
            : "text-muted-foreground/70",
        )}
      >
        +{props.extras.length}
      </span>
    </button>
  );
}

/** 候选展开行：与表格其它行同宽，不进四列网格。 */
function CandidateDetailRow(props: { entries: readonly CandidateEntry[] }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-muted/30 px-3 py-1.5 text-[10.5px]">
      {props.entries.map((entry) => (
        <span key={entry.source} className="inline-flex items-center gap-1">
          <span className="text-muted-foreground/70">
            {t(`settings.modelCapabilitySource.${entry.source}`)}
          </span>
          <span className="tabular-nums text-foreground/85">{entry.label}</span>
        </span>
      ))}
    </div>
  );
}

function candidateSummary(
  entries: readonly CandidateEntry[],
  translate: (key: string) => string,
): string {
  return entries
    .map((entry) => `${translate(`settings.modelCapabilitySource.${entry.source}`)} ${entry.label}`)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// 设计 §6.3：请求参数。只有运行时真的会透传的字段，按接口白名单启停。
// ---------------------------------------------------------------------------

const PARAMETER_LABEL_KEYS: Record<ModelParameterKey, string> = {
  temperature: "settings.modelParameterTemperature",
  maxTokens: "settings.modelParameterMaxTokens",
  topP: "settings.modelParameterTopP",
};

function parseParameterInput(key: ModelParameterKey, input: string): number | null | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return key === "maxTokens" ? Math.floor(value) : value;
}

function ModelParameterFields(props: {
  model: ProviderModelConfig;
  protocol: ProviderChatProtocol;
  onChange: (key: ModelParameterKey, value: number | undefined) => void;
}) {
  const { t } = useLocale();
  const { model, protocol } = props;
  const range = PROTOCOL_TEMPERATURE_RANGE[protocol];
  const hint: Record<ModelParameterKey, string> = {
    temperature: `${range.min}–${range.max}`,
    maxTokens: `≤ ${formatTokenCount(model.maxOutputToken)}`,
    topP: "0–1",
  };
  return (
    <div className="space-y-2 pt-1">
      <DrawerGroupLabel
        label={t("settings.modelParameters")}
        hint={t("settings.modelParametersHint")}
      />
      <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
        {MODEL_PARAMETER_KEYS.map((key) => {
          const applies = modelParameterApplies(protocol, key);
          const value = model.parameters?.[key];
          return (
            <Field
              key={key}
              label={t(PARAMETER_LABEL_KEYS[key])}
              hint={applies ? hint[key] : t("settings.modelParameterUnsupported")}
              source={
                <SourceTag
                  source={value === undefined ? "auto" : "user"}
                  onReset={() => props.onChange(key, undefined)}
                />
              }
            >
              <CommittedInput
                value={value === undefined ? "" : String(value)}
                inputMode="decimal"
                disabled={!applies}
                className="h-7 w-full text-xs shadow-none"
                placeholder={t("settings.modelParameterUnset")}
                aria-label={t(PARAMETER_LABEL_KEYS[key])}
                onCommit={(input) => {
                  const parsed = parseParameterInput(key, input);
                  if (parsed === null) return;
                  props.onChange(key, parsed);
                }}
              />
            </Field>
          );
        })}
      </div>
    </div>
  );
}

/** 三态覆盖：继承 / 支持 / 不支持，小型分段控件。 */
function OverrideSegment(props: {
  value: ModelCapabilityOverride | undefined;
  label: string;
  onChange: (next: ModelCapabilityOverride | undefined) => void;
}) {
  const { t } = useLocale();
  const options: { key: string; value: ModelCapabilityOverride | undefined; label: string }[] = [
    { key: "inherit", value: undefined, label: t("settings.modelCapabilityOverrideInherit") },
    { key: "supported", value: "supported", label: t("settings.modelCapabilityState.supported") },
    {
      key: "unsupported",
      value: "unsupported",
      label: t("settings.modelCapabilityState.unsupported"),
    },
  ];
  return (
    <fieldset className="inline-flex h-[22px] items-stretch overflow-hidden rounded-md border border-border/70 p-0">
      <legend className="sr-only">{props.label}</legend>
      {options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            className={cn(
              "px-2 text-[11px] leading-none transition-colors first:rounded-l-md last:rounded-r-md",
              active
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** 可折叠块：标题行是按钮（含 chevron），说明气泡放在按钮外避免嵌套交互元素。 */
function CollapsibleBlock(props: {
  label: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((previous) => !previous)}
          className="flex shrink-0 items-center gap-1 text-[10.5px] font-semibold uppercase leading-none tracking-[0.08em] text-muted-foreground/65 transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")}
            aria-hidden="true"
          />
          {props.label}
        </button>
        {props.hint ? <HintTip text={props.hint} label={props.label} /> : null}
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-foreground/[0.07]" />
      </div>
      {open ? props.children : null}
    </section>
  );
}

export function ModelEditDrawer(props: {
  settings: AppSettings;
  provider: CustomProvider;
  modelId: string;
  onChange: (updater: (provider: CustomProvider) => CustomProvider) => void;
  onClose: () => void;
  /** 打开"模型目录"浏览抽屉，预选该模型所在分区并以模型 id 作为搜索词 */
  onOpenCatalog?: (target: { sectionId?: CatalogProviderId; query: string }) => void;
}) {
  const { settings, provider, modelId, onChange, onClose, onOpenCatalog } = props;
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
  // §6.2：当前展开候选列表的行（"能力行键" / "限额字段键"），同一时刻只展开一行。
  const [openCandidates, setOpenCandidates] = useState<string | undefined>(undefined);
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
  const modelType = resolveModelType(provider, model.id);

  const adapterId = route.adapterProviderId;
  const thinking = resolveModelThinking(adapterId, model.id);
  // 目录 / 能力 / 模态都走 modelCapabilities 的单一解析入口（用户覆盖 > 目录 >
  // 供应商规则 / 启发式），与运行时读到的是同一份结果。
  const catalogInfo = resolveModelCatalogInfo(provider, model.id);
  const catalogEntry = catalogInfo?.entry;
  const capabilityRows = modelCapabilityRows(provider, model.id, route);
  const selectableProtocols = modelSelectableProtocols(provider, model.id);
  const implicitProtocol = getProviderImplicitChatProtocol(provider);
  const protocolConfigured = (protocol: ProviderChatProtocol) =>
    isProviderChatProtocolEnabled(provider, protocol, implicitProtocol);
  const inheritedDialect = resolveProviderDialect(provider, route.protocol, {
    endpoint: provider.endpointConfigs?.[route.protocol],
  });
  const defaults = getProviderModelDefaults(adapterId, model.id, route.baseUrl);
  const limitInfos = modelLimitFieldInfos(model, defaults);
  const credential = credentials.find((item) => item.id === route.credentialId);
  // 与运行时同一份合并规则：鉴权头打底，用户头（供应商级 + 端点级，已按大小写去重）
  // 覆盖；键为空 / 不合法 / 保留键的行不进入预览。
  const finalHeaders = Object.entries(
    mergeCustomHeaders(
      buildBuiltinRequestHeaders({
        protocol: route.protocol,
        dialect: route.dialect,
        apiKey: "••••••",
        sessionId: "{session-id}",
        auth: route.auth,
        identity: route.identity,
      }),
      route.headers,
    ),
  );

  const protocolSourceLabel = t(`settings.modelRouteSource.${route.protocolSource}`);
  const columnCatalog = t("settings.modelPropertyColumn.catalog");
  const catalogLimit = (field: ModelLimitField): string =>
    catalogEntry?.[field] ? formatTokenCount(catalogEntry[field]) : "—";

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
            {/* 1. 标识 */}
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
              {/* 模型类型：对话 / 生图。生图模型不走四类聊天接口，由 generate_image 工具调用。 */}
              <Field
                label={t("settings.modelType")}
                hint={t("settings.modelTypeHint")}
                source={
                  <SourceTag
                    source={model.modelType ? "user" : "auto"}
                    onReset={() => drop("modelType")}
                  />
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <fieldset className="inline-flex h-[22px] items-stretch overflow-hidden rounded-md border border-border/70 p-0">
                    {(["chat", "image"] as const).map((value) => {
                      const active = modelType.type === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={active}
                          className={cn(
                            "px-2 text-[11px] leading-none transition-colors first:rounded-l-md last:rounded-r-md",
                            active
                              ? "bg-primary/10 font-medium text-primary"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                          onClick={() =>
                            patch((current) => ({
                              ...current,
                              modelType:
                                value === resolveModelType(provider, current.id).type &&
                                !current.modelType
                                  ? undefined
                                  : value,
                            }))
                          }
                        >
                          {t(
                            value === "chat" ? "settings.modelTypeChat" : "settings.modelTypeImage",
                          )}
                        </button>
                      );
                    })}
                  </fieldset>
                  <span className="text-[10.5px] text-muted-foreground">
                    {t(`settings.modelCapabilitySource.${modelType.source}`)}
                  </span>
                </div>
              </Field>
            </section>

            {/* 2. 目录 */}
            <ModelCatalogSummary
              info={catalogInfo}
              modelId={model.id}
              action={
                onOpenCatalog ? (
                  <button
                    type="button"
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    onClick={() =>
                      onOpenCatalog({
                        sectionId: catalogInfo?.catalogProviderId,
                        query: model.id,
                      })
                    }
                  >
                    <BookOpen className="h-3 w-3" />
                    {t("settings.modelCatalogBrowserOpen")}
                  </button>
                ) : null
              }
            />

            {/* 3. 能力与模态 */}
            <section className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.modelCapabilities")}
                hint={t("settings.modelCapabilitiesHint")}
              />
              <PropertyTable
                rowClass={CAPABILITY_ROW_CLASS}
                columns={[
                  t("settings.modelPropertyColumn.property"),
                  columnCatalog,
                  t("settings.modelPropertyColumn.effective"),
                  t("settings.modelPropertyColumn.override"),
                ]}
              >
                {capabilityRows.map((row) => {
                  const label = t(CAPABILITY_ROW_LABEL_KEYS[row.key]);
                  const view = capabilityChipView(row.effective);
                  // §6.2：目录之外的候选（供应商 / 适配器 / 启发式）。
                  const extras: CandidateEntry[] = row.candidates
                    .filter((item) => item.source !== "catalog")
                    .map((item) => ({
                      source: item.source,
                      label: t(`settings.modelCapabilityState.${item.value}`),
                    }));
                  const all: CandidateEntry[] = row.candidates.map((item) => ({
                    source: item.source,
                    label: t(`settings.modelCapabilityState.${item.value}`),
                  }));
                  const expanded = openCandidates === `capability:${row.key}`;
                  return (
                    <Fragment key={row.key}>
                      <div className={CAPABILITY_ROW_CLASS}>
                        <span className="text-foreground/90">{label}</span>
                        <Cell column={columnCatalog}>
                          <CandidateMark
                            primary={<CatalogMark value={row.catalog} />}
                            extras={extras}
                            conflict={row.conflict !== undefined}
                            expanded={expanded}
                            onToggle={() =>
                              setOpenCandidates(expanded ? undefined : `capability:${row.key}`)
                            }
                            summary={candidateSummary(all, t)}
                            label={`${label} · ${t("settings.modelPropertyColumn.candidates")}`}
                          />
                        </Cell>
                        <Cell column={t("settings.modelPropertyColumn.effective")}>
                          <StateChip state={view.state} overridden={view.overridden}>
                            {t(`settings.modelCapabilityState.${row.effective.state}`)}
                          </StateChip>
                          <span className="text-[10.5px] text-muted-foreground">
                            {t(`settings.modelCapabilitySource.${row.effective.source}`)}
                          </span>
                          {row.conflict && row.editable ? (
                            <>
                              <Chip tone="warn" title={candidateSummary(all, t)}>
                                {t("settings.modelFieldConflict")}
                              </Chip>
                              <ChipButton
                                onClick={() =>
                                  patch((current) =>
                                    adoptModelCapabilityCandidate(
                                      current,
                                      row.key,
                                      // biome-ignore lint/style/noNonNullAssertion: conflict 存在即有 provider 候选
                                      row.conflict!.provider,
                                    ),
                                  )
                                }
                              >
                                {t("settings.modelFieldAdoptProvider")}
                              </ChipButton>
                            </>
                          ) : null}
                        </Cell>
                        <Cell
                          column={t("settings.modelPropertyColumn.override")}
                          className="justify-self-end @max-[500px]:justify-self-start"
                        >
                          {row.editable ? (
                            <OverrideSegment
                              value={row.override}
                              label={`${label} · ${t("settings.modelPropertyColumn.override")}`}
                              onChange={(next) =>
                                patch((current) =>
                                  setModelCapabilityOverride(current, row.key, next),
                                )
                              }
                            />
                          ) : (
                            <span
                              className="text-muted-foreground/60"
                              title={t("settings.modelCapabilityOverrideReadonly")}
                            >
                              —
                            </span>
                          )}
                        </Cell>
                      </div>
                      {expanded ? <CandidateDetailRow entries={all} /> : null}
                    </Fragment>
                  );
                })}
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="text-[10.5px] text-muted-foreground/70">
                    {t("settings.modelCapabilitiesFootnote")}
                  </span>
                  <ChipButton
                    disabled={!hasModelCapabilityOverrides(model)}
                    onClick={() => patch(resetModelCapabilityOverrides)}
                  >
                    {t("settings.modelCapabilitiesResetCatalog")}
                  </ChipButton>
                </div>
              </PropertyTable>
            </section>

            {/* 4. 限额 */}
            <section className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.modelLimits")}
                hint={t("settings.modelLimitsHint")}
              />
              <PropertyTable
                rowClass={LIMIT_ROW_CLASS}
                columns={[
                  t("settings.modelPropertyColumn.property"),
                  columnCatalog,
                  t("settings.modelPropertyColumn.current"),
                  t("settings.modelPropertyColumn.source"),
                ]}
              >
                {LIMIT_FIELDS.map((field) => {
                  const label = t(LIMIT_FIELD_LABEL_KEYS[field]);
                  const info = limitInfos[field];
                  const source = info.source;
                  const value = model[field];
                  // §6.2：目录之外的候选（供应商声明 / 兜底常量）。
                  const all: CandidateEntry[] = info.candidates.map((item) => ({
                    source: item.source,
                    label: formatTokenCount(item.value),
                  }));
                  const extras = all.filter((item) => item.source !== "catalog");
                  const expanded = openCandidates === `limit:${field}`;
                  return (
                    <Fragment key={field}>
                      <div className={LIMIT_ROW_CLASS}>
                        <span className="text-foreground/90">{label}</span>
                        <Cell column={columnCatalog}>
                          <CandidateMark
                            primary={
                              <span className="tabular-nums text-muted-foreground">
                                {catalogLimit(field)}
                              </span>
                            }
                            extras={extras}
                            conflict={info.conflict !== undefined}
                            expanded={expanded}
                            onToggle={() =>
                              setOpenCandidates(expanded ? undefined : `limit:${field}`)
                            }
                            summary={candidateSummary(all, t)}
                            label={`${label} · ${t("settings.modelPropertyColumn.candidates")}`}
                          />
                        </Cell>
                        <Cell column={t("settings.modelPropertyColumn.current")}>
                          <CommittedInput
                            value={value === undefined ? "" : String(value)}
                            inputMode="numeric"
                            className="h-7 w-full max-w-[160px] text-xs shadow-none"
                            placeholder={
                              field === "maxInputTokens"
                                ? t("settings.modelMaxInputTokensUnset")
                                : undefined
                            }
                            aria-label={label}
                            onCommit={(input) => {
                              const parsed =
                                field === "maxInputTokens" && !input.trim()
                                  ? undefined
                                  : parsePositiveInteger(input);
                              if (parsed === null) return;
                              patch((current) => ({
                                ...current,
                                [field]: parsed,
                                limitsSource: "user",
                              }));
                            }}
                          />
                          {info.conflict ? (
                            <>
                              <Chip tone="warn" title={candidateSummary(all, t)}>
                                {t("settings.modelFieldConflict")}
                              </Chip>
                              <ChipButton
                                onClick={() =>
                                  patch((current) =>
                                    adoptModelLimitCandidate(
                                      current,
                                      field,
                                      // biome-ignore lint/style/noNonNullAssertion: conflict 存在即有 provider 候选
                                      info.conflict!.provider,
                                    ),
                                  )
                                }
                              >
                                {t("settings.modelFieldAdoptProvider")}
                              </ChipButton>
                            </>
                          ) : null}
                        </Cell>
                        <Cell
                          column={t("settings.modelPropertyColumn.source")}
                          className="justify-self-end @max-[500px]:justify-self-start"
                        >
                          {source ? (
                            <SourceTag
                              source={source}
                              onReset={() =>
                                patch((current) => resetModelLimitField(current, defaults, field))
                              }
                            />
                          ) : (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </Cell>
                      </div>
                      {expanded ? <CandidateDetailRow entries={all} /> : null}
                    </Fragment>
                  );
                })}
              </PropertyTable>
              {/* 设计 §6.3：请求参数（限适配器 schema 之内） */}
              <ModelParameterFields
                model={model}
                protocol={route.protocol}
                onChange={(key, next) => patch((current) => setModelParameter(current, key, next))}
              />
            </section>

            {/* 5. 思考 */}
            <section className="space-y-3">
              <DrawerGroupLabel
                label={t("settings.modelThinkingLevels")}
                hint={t("settings.modelThinkingLevelsHint")}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <SourceTag source={thinking.fromCatalog ? "catalog" : "heuristic"} />
                {thinking.reasoning ? (
                  <>
                    <Chip>
                      {thinking.alwaysOn
                        ? t("settings.modelThinkingAlwaysOn")
                        : t("settings.modelThinkingCanDisable")}
                    </Chip>
                    {/* 可用档 = 描边芯片，不可用档 = 只降透明度。 */}
                    {THINKING_LEVEL_LADDER.map((level) => {
                      const available = thinking.levels.includes(level);
                      return (
                        <Chip
                          key={level}
                          className={cn(!available && "opacity-40")}
                          title={
                            available ? undefined : t("settings.modelThinkingLevelUnavailable")
                          }
                        >
                          {t(`settings.reasoning.${level}`)}
                        </Chip>
                      );
                    })}
                  </>
                ) : (
                  <span className="text-[11px] text-muted-foreground/75">
                    {t("settings.modelThinkingNone")}
                  </span>
                )}
              </div>
            </section>

            {/* 6. 路由 */}
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
                  hint={t("settings.providerDialectHint")}
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
              </div>

              <CollapsibleBlock
                label={t("settings.modelRouteResult")}
                hint={t("settings.modelRouteResultHint")}
              >
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
                  {route.originUrl ? (
                    <>
                      <span className="text-muted-foreground">
                        {t("settings.modelRouteOrigin")}
                      </span>
                      <span className="break-all font-mono">{route.originUrl}</span>
                    </>
                  ) : null}
                  <span className="text-muted-foreground">{t("settings.baseUrl")}</span>
                  <span className="break-all font-mono">{route.baseUrl || "—"}</span>
                  <span className="text-muted-foreground">
                    {t("settings.channelRequestPathPreview").replace(/[:：]\s*$/, "")}
                  </span>
                  <span className="break-all font-mono">
                    {resolveEndpointRequestBase(route.protocol, route.baseUrl, route.isFullUrl)
                      .requestUrl || "—"}
                  </span>
                  <span className="text-muted-foreground">{t("settings.modelWireId")}</span>
                  <span className="font-mono">{route.wireModelId}</span>
                  <span className="text-muted-foreground">{t("settings.modelCredential")}</span>
                  <span className="flex flex-wrap items-center gap-1.5 font-mono">
                    {credential?.label || t("settings.providerCredentialPrimary")}
                    <span className="font-sans text-[10.5px] text-muted-foreground">
                      {t(`settings.modelRouteCredentialSource.${route.credentialSource}`)}
                    </span>
                  </span>
                  <span className="text-muted-foreground">{t("settings.modelRouteQuirks")}</span>
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
              </CollapsibleBlock>

              {failover ? (
                <CollapsibleBlock
                  label={t("settings.modelFailoverCandidates")}
                  hint={t("settings.modelFailoverCandidatesHint")}
                >
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
                    {providerUsesOrigins(provider) ? (
                      <>
                        <span className="text-muted-foreground">
                          {t("settings.modelFailoverLayer.origin")}
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {failover.origins.length > 0 ? (
                            failover.origins.map((item, index) => (
                              <Chip key={item.id}>
                                {index + 1} · {originHostLabel(item)}
                              </Chip>
                            ))
                          ) : (
                            <span className="text-muted-foreground/70">
                              {t("settings.modelFailoverNone")}
                            </span>
                          )}
                        </span>
                      </>
                    ) : null}
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
                </CollapsibleBlock>
              ) : null}
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
