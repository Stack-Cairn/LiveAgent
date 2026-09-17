// 中栏"渠道详情"（设计文档 7）：标题行、API 密钥（多 Key 列表）、API 地址、模型列表
// （按分组折叠、分组内可拖拽排序、逐模型连通测试）、更多设置、可用性（故障转移）、
// 用量查询。所有写入经父组件的 onChange 走 normalizeCustomProvider。模型行的路由 /
// 能力 / 凭据覆盖按 provider 一次算成 Map，行组件 memo，避免大列表在无关状态变化时
// 全量重算。连通测试结果只在本组件内存里，切换供应商即清空。

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
  Activity,
  ArrowLeft,
  ChevronDown,
  FileText,
  Globe,
  ImageIcon,
  Lightbulb,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Wrench,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useVerticalListReorder } from "@liveagent/ui/components/ui/useVerticalListReorder";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ModelCheckAggregate, ModelCheckResult } from "@liveagent/ui/lib/providers/modelCheck";
import { CUSTOM_PRESET_ID, resolveEndpointRequestBase } from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  checkProviderModelAllKeys,
  checkProviderModels,
  formatTokenCount,
} from "@liveagent/ui/pages/settings/providerUtils";
import { ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UsagePlanLine, usageRelativeTimeText } from "../ProviderPresentation";
import { ModelListActions, ModelListToolbar } from "./ModelListToolbar";
import { ProviderFailoverSection } from "./ProviderFailoverSection";
import { credentialDisplayName, ProviderKeyList } from "./ProviderKeyList";
import { ProviderMoreSettings } from "./ProviderMoreSettings";
import { ProviderOriginList } from "./ProviderOriginList";
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
  SectionTitle,
  SourceTag,
} from "./providerChips";
import {
  addProviderModel,
  canConvertProviderToOrigins,
  configuredCredentials,
  convertProviderToOrigins,
  credentialScopesMatch,
  credentialsCoveringModel,
  EMPTY_MODEL_LIST_FILTER,
  enabledCredentials,
  filterProviderModels,
  groupProviderModels,
  type ModelListFilter,
  modelCapabilityFlags,
  modelListFilterActive,
  type ProviderDrawerState,
  presetForProvider,
  providerConfiguredProtocols,
  providerCredentials,
  providerDefaultProtocol,
  providerDocUrl,
  providerUsesOrigins,
  readEndpoint,
  readEndpointExpanded,
  removeProviderModel,
  reorderProviderModels,
  setProviderModelActive,
  writeEndpoint,
} from "./providerSettingsModel";

type ProviderUpdater = (updater: (provider: CustomProvider) => CustomProvider) => void;

const CHECKING: ModelCheckAggregate = { state: "checking", results: [] };

/** 单把 Key 结果的失败文案：按归类取 i18n，http 带状态码。 */
function modelCheckErrorText(t: (key: string) => string, result: ModelCheckResult): string {
  const kind = result.kind ?? "http";
  if (kind === "http") {
    return t("settings.modelCheckError.http").replace(
      "{status}",
      result.status !== undefined ? String(result.status) : "?",
    );
  }
  return t(`settings.modelCheckError.${kind}`);
}

function modelCheckResultLine(
  t: (key: string) => string,
  result: ModelCheckResult,
  credentialIndex: number,
): string {
  const name = credentialDisplayName(t, { label: result.credentialLabel }, credentialIndex);
  if (result.ok) return `${name}: ✓ ${result.latencyMs}ms`;
  const reason = modelCheckErrorText(t, result);
  return `${name}: ✗ ${reason}${result.error ? ` — ${result.error}` : ""}`;
}

/** 行内状态芯片：检测中 / ✓ 延迟 / ✗ 原因 / 部分 Key 失败；title 列每把 Key 的结果。 */
function ModelCheckChip(props: {
  check: ModelCheckAggregate;
  credentialIndexById: ReadonlyMap<string, number>;
}) {
  const { check, credentialIndexById } = props;
  const { t } = useLocale();
  if (check.state === "idle") return null;
  if (check.state === "checking") {
    return (
      <Chip tone="default">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        {t("settings.modelCheckState.checking")}
      </Chip>
    );
  }
  const title = check.results
    .map((result) =>
      modelCheckResultLine(t, result, credentialIndexById.get(result.credentialId) ?? 0),
    )
    .join("\n");
  if (check.state === "ok") {
    return (
      <Chip tone="ok" title={title}>
        ✓ {check.latencyMs}ms
      </Chip>
    );
  }
  if (check.state === "partial") {
    return (
      <Chip tone="warn" title={title}>
        {t("settings.modelCheckState.partial")}
      </Chip>
    );
  }
  const first = check.results.find((result) => !result.ok);
  return (
    <Chip tone="bad" title={title} className="max-w-[40cqw] overflow-hidden">
      <span className="truncate">✗ {first ? modelCheckErrorText(t, first) : ""}</span>
    </Chip>
  );
}

export type ProviderDetailProps = SettingsSectionProps & {
  provider: CustomProvider;
  isGatewayWebui: boolean;
  onChange: ProviderUpdater;
  onOpenDrawer: (drawer: ProviderDrawerState) => void;
  onProbeConfigure: () => void;
  onQuickCheck: () => void;
  onRefreshModels: () => void;
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
  check: ModelCheckAggregate | undefined;
  credentialIndexById: ReadonlyMap<string, number>;
  dragging: boolean;
  onChange: ProviderUpdater;
  onOpenDrawer: (drawer: ProviderDrawerState) => void;
  onCheck: (modelId: string) => void;
  renderDragHandle: (itemId: string, label: string) => ReactNode;
  getItemProps: (itemId: string) => {
    "data-vertical-reorder-id": string;
    style?: React.CSSProperties;
  };
}) {
  const {
    model,
    info,
    check,
    credentialIndexById,
    dragging,
    onChange,
    onOpenDrawer,
    onCheck,
    renderDragHandle,
    getItemProps,
  } = props;
  const { t } = useLocale();
  const checking = check?.state === "checking";
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
      {check ? <ModelCheckChip check={check} credentialIndexById={credentialIndexById} /> : null}
      <span className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          disabled={checking}
          onClick={() => onCheck(model.id)}
          title={t("settings.modelCheck")}
          aria-label={`${t("settings.modelCheck")} ${model.id}`}
        >
          <Activity className="h-3.5 w-3.5" />
        </Button>
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
  /** 搜索 / 过滤生效时只含匹配的模型；否则是分组全部模型 */
  models: ProviderModelConfig[];
  totalCount: number;
  activeCount: number;
};

/**
 * 一个分组一份拖拽上下文：分组内排序，写回时按显示顺序拼成全局 modelOrder。搜索 /
 * 过滤生效时列表是子集，禁用拖拽（reorderProviderModels 要求整组 id）。
 */
function ModelGroup(props: {
  group: ModelGroupView;
  collapsed: boolean;
  filtering: boolean;
  infoById: ReadonlyMap<string, ModelRowInfo>;
  checks: ReadonlyMap<string, ModelCheckAggregate>;
  credentialIndexById: ReadonlyMap<string, number>;
  onToggle: (key: string) => void;
  onChange: ProviderUpdater;
  onOpenDrawer: (drawer: ProviderDrawerState) => void;
  onCheck: (modelId: string) => void;
}) {
  const {
    group,
    collapsed,
    filtering,
    infoById,
    checks,
    credentialIndexById,
    onToggle,
    onChange,
    onOpenDrawer,
    onCheck,
  } = props;
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
      canReorder: !filtering,
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
        {filtering ? (
          <Chip tone="on" title={t("settings.modelGroupMatchHint")}>
            {group.models.length} / {group.totalCount}
          </Chip>
        ) : (
          <Chip>
            {group.activeCount} / {group.totalCount}
          </Chip>
        )}
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
                check={checks.get(model.id)}
                credentialIndexById={credentialIndexById}
                dragging={draggingItemId === model.id}
                onChange={onChange}
                onOpenDrawer={onOpenDrawer}
                onCheck={onCheck}
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
    onDelete,
    onBack,
    busy,
    notice,
    usage,
  } = props;
  const { t } = useLocale();
  const preset = presetForProvider(provider);
  /** 预设厂商的名称固定，只有自定义渠道可以改名 */
  const nameEditable = preset.id === CUSTOM_PRESET_ID;
  const defaultProtocol = providerDefaultProtocol(provider);
  const defaultEndpoint = readEndpoint(provider, defaultProtocol);
  const usesOrigins = providerUsesOrigins(provider);
  const configured = providerConfiguredProtocols(provider);
  const enabledKeys = enabledCredentials(provider);
  const configuredKeyCount = configuredCredentials(provider).length;
  const credentialIndexById = useMemo(
    () => new Map(providerCredentials(provider).map((credential, index) => [credential.id, index])),
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
  // 搜索 / 过滤只在内存里：切换供应商（父组件按 id 重挂）即复位。生效时无匹配的分组
  // 整组隐藏，"全部测试"也只测可见的已启用模型。
  const [listFilter, setListFilter] = useState<ModelListFilter>(EMPTY_MODEL_LIST_FILTER);
  const filtering = modelListFilterActive(listFilter);
  const allGroups = useMemo(() => groupProviderModels(provider), [provider]);
  const groups = useMemo<ModelGroupView[]>(() => {
    const visible = filtering ? filterProviderModels(provider.models, infoById, listFilter) : null;
    const views: ModelGroupView[] = [];
    for (const group of allGroups) {
      const models = visible ? group.models.filter((model) => visible.has(model.id)) : group.models;
      if (visible && models.length === 0) continue;
      views.push({
        key: group.key,
        models,
        totalCount: group.models.length,
        activeCount: group.models.filter((model) => provider.activeModels.includes(model.id))
          .length,
      });
    }
    return views;
  }, [allGroups, filtering, infoById, listFilter, provider.activeModels, provider.models]);
  const docUrl = providerDocUrl(provider);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // "收起 / 展开全部"看当前显示的分组：全部已折叠时一键展开，否则一键折叠所有分组。
  const allCollapsed = groups.length > 0 && groups.every((group) => collapsedGroups.has(group.key));
  const toggleCollapseAll = useCallback(() => {
    setCollapsedGroups(allCollapsed ? new Set() : new Set(allGroups.map((group) => group.key)));
  }, [allCollapsed, allGroups]);
  const [addingModel, setAddingModel] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const enabled = provider.enabled !== false;
  const firstUsagePlan = usage.display.plans[0];

  // 连通测试结果只在内存里；切换供应商即清空，同时中止还在跑的批量测试。
  const [checks, setChecks] = useState<ReadonlyMap<string, ModelCheckAggregate>>(() => new Map());
  const [checkingAll, setCheckingAll] = useState(false);
  const checkAllAbortRef = useRef<AbortController | null>(null);
  // 最新的 provider 给异步测试用：用户在测试期间改了 Key / 地址时按最新配置发。
  const providerRef = useRef(provider);
  providerRef.current = provider;
  useEffect(() => {
    return () => {
      checkAllAbortRef.current?.abort();
    };
  }, []);
  const setCheck = useCallback((modelId: string, aggregate: ModelCheckAggregate) => {
    setChecks((previous) => new Map(previous).set(modelId, aggregate));
  }, []);
  const checkOne = useCallback(
    (modelId: string) => {
      setCheck(modelId, CHECKING);
      void checkProviderModelAllKeys(providerRef.current, modelId).then((aggregate) =>
        setCheck(modelId, aggregate),
      );
    },
    [setCheck],
  );
  const activeModelIds = useMemo(
    () =>
      groups.flatMap((group) =>
        group.models.filter((model) => provider.activeModels.includes(model.id)).map((m) => m.id),
      ),
    [groups, provider.activeModels],
  );
  function checkAll() {
    if (checkingAll) {
      // 立即停：按钮与"检测中"的行马上复位；已发出的请求由各自的结果自然落地或被丢弃。
      checkAllAbortRef.current?.abort();
      checkAllAbortRef.current = null;
      setCheckingAll(false);
      setChecks((previous) => {
        const next = new Map(previous);
        for (const [modelId, aggregate] of previous) {
          if (aggregate.state === "checking") next.delete(modelId);
        }
        return next;
      });
      return;
    }
    if (activeModelIds.length === 0) return;
    const controller = new AbortController();
    checkAllAbortRef.current = controller;
    setCheckingAll(true);
    setChecks((previous) => {
      const next = new Map(previous);
      for (const modelId of activeModelIds) next.set(modelId, CHECKING);
      return next;
    });
    void checkProviderModels(providerRef.current, activeModelIds, {
      concurrency: 3,
      signal: controller.signal,
      onResult: setCheck,
    }).finally(() => {
      if (checkAllAbortRef.current === controller) {
        checkAllAbortRef.current = null;
        setCheckingAll(false);
      }
    });
  }

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
        {nameEditable ? (
          <CommittedInput
            value={provider.name}
            className="h-8 w-56 min-w-0 max-w-full border-transparent bg-transparent px-2 text-base font-semibold tracking-tight shadow-none hover:border-border focus-visible:border-border max-[760px]:w-auto max-[760px]:flex-1 max-[760px]:basis-40"
            aria-label={t("settings.channelName")}
            onCommit={(value) => {
              const name = value.trim();
              if (name) onChange((current) => ({ ...current, name }));
            }}
          />
        ) : (
          <span className="min-w-0 max-w-full truncate px-2 text-base font-semibold tracking-tight">
            {provider.name}
          </span>
        )}
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
          badge={
            enabledKeys.length >= 2 ? (
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
            ) : null
          }
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-[11px]"
                disabled={busy !== null}
                onClick={onQuickCheck}
              >
                <RefreshCw className={cn("h-3 w-3", busy === "check" && "animate-spin")} />
                {t("settings.providerCheck")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => onOpenDrawer({ kind: "keys" })}
              >
                {t("settings.providerKeysDetails").replace("{count}", String(configuredKeyCount))}
              </Button>
            </>
          }
        />
        <ProviderKeyList
          provider={provider}
          isGatewayWebui={isGatewayWebui}
          authOptional={preset.authOptional}
          onChange={onChange}
        />
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
        {usesOrigins ? (
          <div className="space-y-2">
            <ProviderOriginList provider={provider} onChange={onChange} />
            <div className="divide-y rounded-xl border bg-card">
              {configured.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground/75">
                  {t("settings.providerNoEndpointsHint")}
                </div>
              ) : (
                configured.map((protocol) => {
                  const view = readEndpoint(provider, protocol);
                  const expanded = readEndpointExpanded(provider, protocol);
                  const isEnabled = view?.config.enabled !== false;
                  const resolved = expanded?.config.baseUrl
                    ? resolveEndpointRequestBase(
                        protocol,
                        expanded.config.baseUrl,
                        expanded.config.isFullUrl === true,
                      ).requestUrl
                    : "";
                  return (
                    <div key={protocol} className="space-y-0.5 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <ChipButton
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
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                          {view?.config.baseUrl}
                        </span>
                        <ProbeStatusChip probe={view?.config.lastProbe} />
                      </div>
                      <p className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground/70">
                        <span className="font-sans">{t("settings.providerOriginResolved")}: </span>
                        {resolved || t("settings.providerOriginUnresolved")}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
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
              {canConvertProviderToOrigins(provider) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 px-2 text-[11px] text-muted-foreground"
                  title={t("settings.providerConvertToOriginsHint")}
                  onClick={() => onChange((current) => convertProviderToOrigins(current))}
                >
                  {t("settings.providerConvertToOrigins")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <section className="@container/models space-y-2">
        <SectionTitle
          title={t("settings.models")}
          badge={
            <>
              <Chip>
                {t("settings.modelsEnabledCount")
                  .replace("{enabled}", String(provider.activeModels.length))
                  .replace("{total}", String(provider.models.length))}
              </Chip>
              <ModelListToolbar
                docUrl={docUrl}
                hasGroups={groups.length > 0}
                allCollapsed={allCollapsed}
                onToggleCollapseAll={toggleCollapseAll}
                filter={listFilter}
                onFilterChange={setListFilter}
              />
            </>
          }
          actions={
            <ModelListActions
              checkingAll={checkingAll}
              checkAllDisabled={!checkingAll && activeModelIds.length === 0}
              checkAllScoped={filtering}
              onCheckAll={checkAll}
              refreshing={busy === "refresh"}
              refreshDisabled={busy !== null}
              onRefreshModels={onRefreshModels}
              onAddModel={() => setAddingModel(true)}
            />
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
              {filtering ? t("settings.modelsFilterEmpty") : t("settings.modelsEmptyHint")}
            </div>
          ) : (
            groups.map((group) => (
              <ModelGroup
                key={group.key}
                group={group}
                collapsed={collapsedGroups.has(group.key)}
                filtering={filtering}
                infoById={infoById}
                checks={checks}
                credentialIndexById={credentialIndexById}
                onToggle={toggleGroup}
                onChange={onChange}
                onOpenDrawer={onOpenDrawer}
                onCheck={checkOne}
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
