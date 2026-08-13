import { ProviderSettingsExtension } from "@liveagent/adapters/providerSettings";
import {
  getProviderUsageCardDisplay,
  getUsagePlanDisplay,
  type ProviderUsageState,
  testProviderUsage,
  type UsageData,
  type UsagePlanDisplay,
  type UsageRelativeTime,
  useProviderUsage,
  useUsageNowTicker,
} from "@liveagent/app/lib/providers/usageQuery";
import {
  CODEX_REQUEST_FORMAT_LABELS,
  type CodexRequestFormat,
  type CustomProvider,
  getDefaultUsageQueryConfig,
  MODEL_FAILOVER_QUEUE_LIMIT,
  PROMPT_CACHE_HINT_MODES,
  type PromptCacheHintMode,
  type ProviderFailoverSettings,
  type ProviderId,
  type ProviderModelConfig,
  type UsageQueryMode,
  updateCustomProviders,
  updateCustomSettings,
  updateModelFailover,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  Check,
  ChevronDown,
  ChevronUp,
  ClaudeIcon,
  ClipboardPaste,
  ExternalLink,
  Eye,
  EyeOff,
  GeminiIcon,
  Globe,
  GrokIcon,
  Key,
  Link2,
  List,
  OpenaiChatgptIcon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Waypoints,
  X,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle } from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useVerticalListReorder } from "@liveagent/ui/components/ui/useVerticalListReorder";
import { useLocale } from "@liveagent/ui/i18n/index";
import { buildModelOptions } from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue, toModelValue } from "@liveagent/ui/lib/models/modelValue";
import {
  CustomHeaderImportError,
  type CustomHeaderImportErrorCode,
  type CustomHeaderImportIssue,
  getCustomHeaderKeyPresets,
  isReservedCustomHeaderKey,
  isValidCustomHeaderKey,
  isValidCustomHeaderValue,
  mergeImportedCustomHeaders,
  parseCustomHeadersImport,
} from "@liveagent/ui/lib/providers/customHeaders";
import {
  applyModelOrderSnapshot,
  createModelOrderSnapshot,
  findNewModelIds,
} from "@liveagent/ui/lib/providers/modelVendor";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ModelPicker } from "@liveagent/ui/pages/settings/modelPicker";
import {
  applyModelBulkActiveState,
  applyUsageQueryModePreset,
  buildProviderModelsFetchKey,
  clampUsageQueryTimeoutSecs,
  createDraftModelConfig,
  createUsageQueryDraft,
  detectCodingPlanProvider,
  fetchModelsFromApi,
  formatTokenCount,
  getModelBulkActionCounts,
  getPersistedUsageQueryProviderId,
  isGatewayWebuiRuntime,
  matchBalanceProviders,
  mergeFetchedModels,
  normalizeFetchedModels,
  requiresCustomUsageQueryConfirmation,
  serializeUsageQueryDraft,
  setUsageQueryScript,
  USAGE_QUERY_CODING_PLAN_PROVIDERS,
} from "@liveagent/ui/pages/settings/providerUtils";
import { ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ModalProps = {
  providerType: ProviderId;
  initialData?: CustomProvider;
  onSave: (data: Omit<CustomProvider, "id">) => void;
  onClose: () => void;
};

// 脚本编写说明里的示例代码(纯代码,locale 无关);语义须与 Rust 沙箱执行
// 契约一致:声明式单请求 + extractor 接收响应 JSON。
const USAGE_QUERY_SCRIPT_HELP_EXAMPLE = `({
  request: {
    url: "{{baseUrl}}/api/usage",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}"
    }
  },
  extractor: function (response) {
    return {
      planName: "Pro",
      remaining: response.balance,
      total: response.quota,
      unit: "USD"
    };
  }
})`;

function usagePlanTitleText(
  t: (key: string) => string,
  title: UsagePlanDisplay["title"],
): string | null {
  if (title.kind === "window") return t(`settings.providerUsageWindow.${title.token}`);
  if (title.kind === "text") return title.text;
  return null;
}

function usageRelativeTimeText(t: (key: string) => string, time: UsageRelativeTime): string {
  switch (time.kind) {
    case "justNow":
      return t("settings.providerUsageUpdated.justNow");
    case "minutesAgo":
      return t("settings.providerUsageUpdated.minutesAgo").replace("{count}", String(time.value));
    case "hoursAgo":
      return t("settings.providerUsageUpdated.hoursAgo").replace("{count}", String(time.value));
    case "daysAgo":
      return t("settings.providerUsageUpdated.daysAgo").replace("{count}", String(time.value));
  }
}

// 单个套餐/余额行:失效红、余量 <10% 橙、正常绿(对齐 cc-switch UsageFooter 分级)。
function UsagePlanLine({ plan }: { plan: UsagePlanDisplay }) {
  const { t } = useLocale();
  const title = usagePlanTitleText(t, plan.title);
  if (plan.invalid) {
    return (
      <span className="flex min-w-0 items-baseline gap-1.5 text-destructive">
        {title ? <span className="truncate">{title}</span> : null}
        <span className="truncate">
          {plan.invalidMessage ?? t("settings.providerUsageInvalid")}
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {title ? <span className="truncate">{title}</span> : null}
      <span
        className={cn(
          "whitespace-nowrap font-medium",
          plan.severity === "low"
            ? "text-amber-500 dark:text-amber-400"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {plan.amount ?? "—"}
        {plan.total ? ` / ${plan.total}` : ""}
        {plan.unit ? ` ${plan.unit}` : ""}
      </span>
      {plan.percent !== null && plan.unit !== "%" ? (
        <span className="whitespace-nowrap text-muted-foreground">{plan.percent}%</span>
      ) : null}
      {plan.extra ? <span className="truncate text-muted-foreground">{plan.extra}</span> : null}
    </span>
  );
}

type ProviderDialogPanel = "general" | "request" | "usage";

type HeaderImportErrorCode = CustomHeaderImportErrorCode | "no-valid" | "failed";

type HeaderImportSummary = {
  importedCount: number;
  overwrittenCount: number;
  issues: CustomHeaderImportIssue[];
};

type ModelEditDraft = {
  model: ProviderModelConfig;
  contextWindow: string;
  maxOutputToken: string;
};

type NewModelPhase = "visible" | "fading";

type PendingModelLayout = {
  topById: Map<string, number>;
  scrollContainer: HTMLDivElement | null;
  scrollTop: number | null;
};

const NEW_MODEL_SORT_DELAY_MS = 1_200;
const NEW_MODEL_BADGE_DURATION_MS = 3_200;
const NEW_MODEL_BADGE_FADE_MS = 500;
const MODEL_FLIP_DURATION_MS = 420;

const PROVIDER_TABS: ProviderId[] = ["claude_code", "codex", "gemini", "xai"];
const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_code: "Anthropic",
  codex: "OpenAI",
  gemini: "Gemini",
  xai: "Grok",
};

const PROMPT_CACHE_HINT_LABEL_KEYS: Record<PromptCacheHintMode, string> = {
  auto: "settings.promptCacheHintMode.auto",
  "openai-key": "settings.promptCacheHintMode.openaiKey",
  "openrouter-session": "settings.promptCacheHintMode.openrouterSession",
  none: "settings.promptCacheHintMode.none",
};

function getProviderLabel(type: ProviderId) {
  return PROVIDER_LABELS[type];
}

function ProviderBrandIcon({ type }: { type: ProviderId }) {
  if (type === "claude_code") return <ClaudeIcon height="1em" />;
  if (type === "gemini") return <GeminiIcon height="1em" />;
  if (type === "xai") return <GrokIcon height="1em" />;
  return <OpenaiChatgptIcon height="1em" className="fill-current dark:text-white" />;
}

const REDACTED_API_KEY_DISPLAY = "API Key";

function parsePositiveInteger(input: string): number | null {
  const value = Number(input.trim());
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

type CustomHeaderIssue = "reserved" | "invalid-key" | "invalid-value";

function customHeaderIssueMessage(issue: CustomHeaderIssue, t: (key: string) => string): string {
  if (issue === "reserved") return t("settings.customHeaderReservedTitle");
  if (issue === "invalid-value") return t("settings.invalidCustomHeaderValue");
  return t("settings.invalidCustomHeaderKey");
}

function getCustomHeaderIssue(
  header: { key: string; value: string },
  includeEmpty = false,
): CustomHeaderIssue | null {
  if (!header.key && !includeEmpty) return null;
  if (isReservedCustomHeaderKey(header.key)) return "reserved";
  if (!isValidCustomHeaderKey(header.key)) return "invalid-key";
  // 取值含非 ASCII / CR / LF 时 fetch() 会直接抛错，整轮对话被打断成一条与请求头
  // 无关的报错——在保存前拦住，把问题指回这一行配置。
  return isValidCustomHeaderValue(header.value) ? null : "invalid-value";
}

function DialogSwitch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const { checked, onCheckedChange, ariaLabel } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        className={cn(
          "relative block h-5 w-9 rounded-full bg-muted-foreground/35 transition-colors",
          checked && "bg-primary",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
            checked && "translate-x-4",
          )}
        />
      </span>
    </button>
  );
}

function reconcileModelOrder(
  order: readonly string[] | undefined,
  models: readonly ProviderModelConfig[],
) {
  if (!order) return undefined;
  const byId = new Set(models.map((model) => model.id));
  const seen = new Set<string>();
  const next = order.filter((id) => {
    if (!byId.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const model of models) {
    if (!seen.has(model.id)) next.push(model.id);
  }
  return next;
}

function itemsByIdOrder<T extends { id: string }>(items: readonly T[], order: readonly string[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

function ProviderModal({ providerType, initialData, onSave, onClose }: ModalProps) {
  const { t } = useLocale();
  const isGatewayWebui = isGatewayWebuiRuntime();
  const initialApiKey = initialData?.apiKey ?? "";
  const initialUsesRedactedApiKey =
    isGatewayWebui && initialApiKey.trim() === "" && initialData?.apiKeyConfigured === true;
  const [name, setName] = useState(initialData?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initialData?.baseUrl ?? "");
  const [isFullUrl, setIsFullUrl] = useState(initialData?.isFullUrl ?? false);
  const [modelsUrl, setModelsUrl] = useState(
    providerType === "gemini" ? "" : (initialData?.modelsUrl ?? ""),
  );
  const [apiKey, setApiKey] = useState(
    initialUsesRedactedApiKey ? REDACTED_API_KEY_DISPLAY : initialApiKey,
  );
  const [customHeaders, setCustomHeaders] = useState(() =>
    (initialData?.customHeaders ?? []).map((header) => ({ ...header })),
  );
  const [headerImportOpen, setHeaderImportOpen] = useState(false);
  const [headerImportText, setHeaderImportText] = useState("");
  const [headerImportError, setHeaderImportError] = useState<HeaderImportErrorCode | null>(null);
  const [headerImportSummary, setHeaderImportSummary] = useState<HeaderImportSummary | null>(null);
  const [models, setModels] = useState<ProviderModelConfig[]>(() =>
    normalizeFetchedModels(initialData?.models ?? [], providerType),
  );
  const [modelOrder, setModelOrder] = useState<string[] | undefined>(() =>
    initialData?.modelOrder ? [...initialData.modelOrder] : undefined,
  );
  const [activeModels, setActiveModels] = useState<Set<string>>(
    new Set(initialData?.activeModels ?? []),
  );
  const [modelDisplayOrder, setModelDisplayOrder] = useState<string[]>(() =>
    createModelOrderSnapshot(models, initialData?.modelOrder, activeModels),
  );
  const [newModelPhases, setNewModelPhases] = useState<ReadonlyMap<string, NewModelPhase>>(
    () => new Map(),
  );
  const [requestFormat, setRequestFormat] = useState<CodexRequestFormat>(
    initialData?.requestFormat ?? "openai-responses",
  );
  const [useSystemProxy, setUseSystemProxy] = useState(initialData?.useSystemProxy ?? false);
  const [promptCachingEnabled, setPromptCachingEnabled] = useState(
    initialData?.promptCachingEnabled ?? (providerType !== "gemini" && providerType !== "xai"),
  );
  const [promptCacheHintMode, setPromptCacheHintMode] = useState<PromptCacheHintMode>(
    initialData?.promptCacheHintMode ??
      (initialData?.promptCachingEnabled === false ? "none" : "auto"),
  );
  const [promptCacheRetention, setPromptCacheRetention] = useState<"short" | "long">(
    initialData?.promptCacheRetention === "long" ? "long" : "short",
  );
  const [usageQuery, setUsageQuery] = useState(() => {
    const draft = createUsageQueryDraft(
      initialData?.usageQuery ?? getDefaultUsageQueryConfig(),
      isGatewayWebui,
    );
    // general/newapi 是可编辑脚本预设:脚本为空的存量配置打开时即在编辑器填充预设。
    return applyUsageQueryModePreset(draft, draft.mode);
  });
  const [customUsageQueryConfirmed, setCustomUsageQueryConfirmed] = useState(
    () => initialData?.usageQuery?.enabled === true && initialData.usageQuery.mode === "custom",
  );
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [addingModel, setAddingModel] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [modelBulkMode, setModelBulkMode] = useState(false);
  const [modelBulkSelection, setModelBulkSelection] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [editingModel, setEditingModel] = useState<ModelEditDraft | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [activePanel, setActivePanel] = useState<ProviderDialogPanel>("general");
  const [headerValidationSubmitted, setHeaderValidationSubmitted] = useState(false);
  const [headerSuggest, setHeaderSuggest] = useState<{
    index: number;
    rect: { left: number; top: number; width: number };
  } | null>(null);
  const [headerSuggestActive, setHeaderSuggestActive] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFetchKey = useRef("");
  const headerKeyRefs = useRef<Array<HTMLInputElement | null>>([]);
  const headerValueRefs = useRef<Array<HTMLInputElement | null>>([]);
  const modelListRef = useRef<HTMLDivElement | null>(null);
  const pendingModelLayoutRef = useRef<PendingModelLayout | null>(null);
  const modelSortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelBadgeTimersRef = useRef(new Map<string, Array<ReturnType<typeof setTimeout>>>());
  const modelsRef = useRef(models);
  const modelOrderRef = useRef(modelOrder);
  const activeModelsRef = useRef(activeModels);
  const draggingModelIdRef = useRef<string | null>(null);
  const commitModelsWithNewRowsRef = useRef<(nextModels: ProviderModelConfig[]) => void>(
    () => undefined,
  );
  modelsRef.current = models;
  modelOrderRef.current = modelOrder;
  activeModelsRef.current = activeModels;
  const apiKeyIsRedactedDisplay = initialUsesRedactedApiKey && apiKey === REDACTED_API_KEY_DISPLAY;
  const apiKeyForRequest = apiKeyIsRedactedDisplay ? "" : apiKey.trim();
  const canFetchModels =
    (modelsUrl.trim().length > 0 || baseUrl.trim().length > 0) && apiKeyForRequest.length > 0;
  const persistedUsageQueryProviderId = getPersistedUsageQueryProviderId(initialData);
  const { confirm: requestUsageQueryConfirm, dialog: usageQueryConfirmDialog } = useConfirmDialog();
  const [usageQueryTest, setUsageQueryTest] = useState<{
    status: "idle" | "running" | "success" | "error";
    data: UsageData[];
    error: string | null;
  }>({ status: "idle", data: [], error: null });
  const usageQueryTestSeqRef = useRef(0);
  // 数字输入用本地草稿字符串,blur 时 clamp 后写回 usageQuery。
  const [usageTimeoutInput, setUsageTimeoutInput] = useState(() => String(usageQuery.timeoutSecs));
  // 自定义模式的"支持的变量"面板:apiKey 打码,眼睛切换明文。
  const [showUsageVariableApiKey, setShowUsageVariableApiKey] = useState(false);
  // 变量实际生效值:查询专用覆盖优先,留空回退供应商自身配置(与 Rust
  // prepare_script_query 的解析顺序一致)。
  const usageVariableBaseUrl = usageQuery.baseUrl.trim() || baseUrl.trim();
  const usageVariableApiKey = usageQuery.apiKey.trim() || apiKey.trim();
  // Token Plan 供应商:显式选择优先,否则按 Base URL 自动检测。
  const activeCodingPlanProvider =
    usageQuery.codingPlanProvider || detectCodingPlanProvider(baseUrl);
  const matchedBalanceProviders = matchBalanceProviders(baseUrl);

  function commitUsageTimeoutInput() {
    const raw = usageTimeoutInput.trim();
    const next = clampUsageQueryTimeoutSecs(raw === "" ? Number.NaN : Number(raw));
    setUsageTimeoutInput(String(next));
    setUsageQuery((previous) => ({ ...previous, timeoutSecs: next }));
  }

  const doFetch = useCallback(
    async (url: string, key: string) => {
      setFetchingModels(true);
      setFetchError(null);
      try {
        const list = await fetchModelsFromApi(providerType, url, key, {
          useSystemProxy,
          isFullUrl,
          modelsUrl,
        });
        const mergedModels = mergeFetchedModels(list, modelsRef.current);
        commitModelsWithNewRowsRef.current(mergedModels);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      } finally {
        setFetchingModels(false);
      }
    },
    [isFullUrl, modelsUrl, providerType, useSystemProxy],
  );

  useEffect(() => {
    const trimUrl = baseUrl.trim();
    const trimModelsUrl = modelsUrl.trim();
    const trimKey = apiKeyForRequest;
    const key = buildProviderModelsFetchKey(
      trimUrl,
      trimKey,
      useSystemProxy,
      isFullUrl,
      trimModelsUrl,
    );
    if ((!trimUrl && !trimModelsUrl) || !trimKey) return;
    if (key === prevFetchKey.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      prevFetchKey.current = key;
      void doFetch(trimUrl, trimKey);
    }, 900);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [apiKeyForRequest, baseUrl, doFetch, isFullUrl, modelsUrl, useSystemProxy]);

  useEffect(() => {
    if (!modelOrder) return;
    const next = reconcileModelOrder(modelOrder, models);
    if (
      next &&
      (next.length !== modelOrder.length || next.some((id, index) => id !== modelOrder[index]))
    ) {
      setModelOrder(next);
    }
  }, [modelOrder, models]);

  useEffect(() => {
    setModelDisplayOrder((current) => {
      const next = applyModelOrderSnapshot(models, current).map((model) => model.id);
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [models]);

  useEffect(
    () => () => {
      if (modelSortTimerRef.current) clearTimeout(modelSortTimerRef.current);
      for (const timers of modelBadgeTimersRef.current.values()) {
        for (const timer of timers) clearTimeout(timer);
      }
      modelBadgeTimersRef.current.clear();
    },
    [],
  );

  function captureModelLayout() {
    const rows = modelListRef.current?.querySelectorAll<HTMLElement>("[data-model-row-id]");
    const topById = new Map<string, number>();
    for (const row of rows ?? []) {
      for (const animation of row.getAnimations()) animation.cancel();
      const id = row.dataset.modelRowId;
      if (id) topById.set(id, row.getBoundingClientRect().top);
    }
    const scrollContainer = modelScrollContainerRef.current;
    pendingModelLayoutRef.current = {
      topById,
      scrollContainer,
      scrollTop: scrollContainer?.scrollTop ?? null,
    };
  }

  function markModelAsNew(modelId: string) {
    for (const timer of modelBadgeTimersRef.current.get(modelId) ?? []) clearTimeout(timer);
    setNewModelPhases((current) => {
      const next = new Map(current);
      next.set(modelId, "visible");
      return next;
    });
    const fadeTimer = setTimeout(() => {
      setNewModelPhases((current) => {
        if (!current.has(modelId)) return current;
        const next = new Map(current);
        next.set(modelId, "fading");
        return next;
      });
    }, NEW_MODEL_BADGE_DURATION_MS);
    const removeTimer = setTimeout(() => {
      setNewModelPhases((current) => {
        if (!current.has(modelId)) return current;
        const next = new Map(current);
        next.delete(modelId);
        return next;
      });
      modelBadgeTimersRef.current.delete(modelId);
    }, NEW_MODEL_BADGE_DURATION_MS + NEW_MODEL_BADGE_FADE_MS);
    modelBadgeTimersRef.current.set(modelId, [fadeTimer, removeTimer]);
  }

  function settleNewModels() {
    if (draggingModelIdRef.current) {
      modelSortTimerRef.current = setTimeout(settleNewModels, 200);
      return;
    }
    captureModelLayout();
    setModelDisplayOrder(
      createModelOrderSnapshot(modelsRef.current, modelOrderRef.current, activeModelsRef.current),
    );
    modelSortTimerRef.current = null;
  }

  function scheduleNewModelSettlement() {
    if (modelSortTimerRef.current) clearTimeout(modelSortTimerRef.current);
    modelSortTimerRef.current = setTimeout(settleNewModels, NEW_MODEL_SORT_DELAY_MS);
  }

  function commitModelsWithNewRows(nextModels: ProviderModelConfig[]) {
    const newModelIds = findNewModelIds(modelsRef.current, nextModels);
    if (newModelIds.length === 0) {
      setModels(nextModels);
      return;
    }

    captureModelLayout();
    const nextIds = new Set(nextModels.map((model) => model.id));
    const newIdSet = new Set(newModelIds);
    setModels(nextModels);
    setModelDisplayOrder((current) => [
      ...current.filter((id) => nextIds.has(id) && !newIdSet.has(id)),
      ...newModelIds,
    ]);
    for (const modelId of newModelIds) markModelAsNew(modelId);
    scheduleNewModelSettlement();
  }
  commitModelsWithNewRowsRef.current = commitModelsWithNewRows;

  function handleRefresh() {
    const trimUrl = baseUrl.trim();
    const trimKey = apiKeyForRequest;
    if (!trimUrl || !trimKey) {
      setFetchError(t("settings.noBaseUrlApiKey"));
      return;
    }
    prevFetchKey.current = "";
    void doFetch(trimUrl, trimKey);
  }

  function toggleModel(model: string) {
    setActiveModels((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  }

  function exitModelBulkMode() {
    setModelBulkMode(false);
    setModelBulkSelection(new Set());
  }

  function toggleModelBulkMode() {
    if (modelBulkMode) {
      exitModelBulkMode();
      return;
    }
    setEditingModel(null);
    setAddingModel(false);
    setModelBulkSelection(new Set());
    setModelBulkMode(true);
  }

  function toggleModelBulkSelection(modelId: string) {
    setModelBulkSelection((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  function selectVisibleModels() {
    setModelBulkSelection((prev) => {
      const next = new Set(prev);
      for (const model of visibleModels) next.add(model.id);
      return next;
    });
  }

  function applyModelBulkState(enabled: boolean) {
    setActiveModels((prev) => applyModelBulkActiveState(prev, modelBulkSelection, enabled));
    setModelBulkSelection(new Set());
  }

  function handleAddModel() {
    const model = newModelName.trim();
    if (!model) return;
    if (!modelsRef.current.some((item) => item.id === model)) {
      commitModelsWithNewRows([...modelsRef.current, createDraftModelConfig(providerType, model)]);
    }
    setActiveModels((prev) => new Set([...prev, model]));
    setNewModelName("");
    setAddingModel(false);
  }

  function removeModel(model: string) {
    for (const timer of modelBadgeTimersRef.current.get(model) ?? []) clearTimeout(timer);
    modelBadgeTimersRef.current.delete(model);
    setNewModelPhases((current) => {
      if (!current.has(model)) return current;
      const next = new Map(current);
      next.delete(model);
      return next;
    });
    setModels((prev) => prev.filter((item) => item.id !== model));
    setActiveModels((prev) => {
      const next = new Set(prev);
      next.delete(model);
      return next;
    });
    setModelBulkSelection((prev) => {
      if (!prev.has(model)) return prev;
      const next = new Set(prev);
      next.delete(model);
      return next;
    });
    setEditingModel((prev) => (prev?.model.id === model ? null : prev));
  }

  function openModelSettings(modelId: string) {
    const target = models.find((item) => item.id === modelId);
    if (!target) return;
    setEditingModel((prev) =>
      prev?.model.id === target.id
        ? null
        : {
            model: target,
            contextWindow: String(target.contextWindow),
            maxOutputToken: String(target.maxOutputToken),
          },
    );
  }

  const editingModelContextWindow = editingModel
    ? parsePositiveInteger(editingModel.contextWindow)
    : null;
  const editingModelMaxOutputToken = editingModel
    ? parsePositiveInteger(editingModel.maxOutputToken)
    : null;
  const canSaveEditingModel =
    editingModelContextWindow !== null && editingModelMaxOutputToken !== null;

  function saveInlineModelSettings() {
    if (
      !editingModel ||
      editingModelContextWindow === null ||
      editingModelMaxOutputToken === null
    ) {
      return;
    }
    const nextModel: ProviderModelConfig = {
      ...editingModel.model,
      contextWindow: editingModelContextWindow,
      maxOutputToken: editingModelMaxOutputToken,
    };
    setModels((prev) => prev.map((item) => (item.id === nextModel.id ? nextModel : item)));
    setEditingModel(null);
  }
  function updateCustomHeader(index: number, field: "key" | "value", value: string) {
    setCustomHeaders((prev) =>
      prev.map((header, headerIndex) =>
        headerIndex === index ? { ...header, [field]: value } : header,
      ),
    );
    setHeaderValidationSubmitted(false);
  }

  function focusCustomHeader(index: number, field: "key" | "value") {
    requestAnimationFrame(() => {
      const target =
        field === "key" ? headerKeyRefs.current[index] : headerValueRefs.current[index];
      target?.focus();
    });
  }

  function addCustomHeader(key = "", focusField: "key" | "value" = "key") {
    const nextIndex = customHeaders.length;
    setCustomHeaders((prev) => [...prev, { key, value: "" }]);
    setHeaderValidationSubmitted(false);
    focusCustomHeader(nextIndex, focusField);
  }

  function removeCustomHeader(index: number) {
    setCustomHeaders((prev) => prev.filter((_, headerIndex) => headerIndex !== index));
    setHeaderValidationSubmitted(false);
  }

  function openHeaderSuggest(index: number) {
    const input = headerKeyRefs.current[index];
    if (!input) return;
    const rect = input.getBoundingClientRect();
    setHeaderSuggest({
      index,
      rect: { left: rect.left, top: rect.bottom + 4, width: rect.width },
    });
    setHeaderSuggestActive(0);
  }

  function applyHeaderSuggestion(preset: string) {
    if (!headerSuggest) return;
    updateCustomHeader(headerSuggest.index, "key", preset);
    setHeaderSuggest(null);
    focusCustomHeader(headerSuggest.index, "value");
  }

  function cancelCustomHeaderImport() {
    setHeaderImportOpen(false);
    setHeaderImportText("");
    setHeaderImportError(null);
  }

  function handleImportCustomHeaders() {
    setHeaderImportError(null);
    setHeaderImportSummary(null);
    try {
      const parsed = parseCustomHeadersImport(headerImportText);
      if (parsed.headers.length === 0) {
        setHeaderImportError("no-valid");
        setHeaderImportSummary({
          importedCount: 0,
          overwrittenCount: 0,
          issues: parsed.issues,
        });
        return;
      }
      const merged = mergeImportedCustomHeaders(customHeaders, parsed.headers);
      setCustomHeaders(merged.headers);
      setHeaderSuggest(null);
      setHeaderValidationSubmitted(false);
      setHeaderImportSummary({
        importedCount: merged.importedCount,
        overwrittenCount: merged.overwrittenCount,
        issues: parsed.issues,
      });
      setHeaderImportText("");
      setHeaderImportOpen(false);
    } catch (error) {
      setHeaderImportError(error instanceof CustomHeaderImportError ? error.code : "failed");
    }
  }
  async function handleSave() {
    if (!name.trim()) return;
    const invalidHeaderIndex = customHeaders.findIndex(
      (header) => getCustomHeaderIssue(header, true) !== null,
    );
    if (invalidHeaderIndex >= 0) {
      setHeaderValidationSubmitted(true);
      exitModelBulkMode();
      setActivePanel("request");
      // 导入视图会顶掉请求头列表,先切回列表再聚焦,否则目标输入框尚未挂载。
      setHeaderImportOpen(false);
      focusCustomHeader(
        invalidHeaderIndex,
        getCustomHeaderIssue(customHeaders[invalidHeaderIndex], true) === "invalid-value"
          ? "value"
          : "key",
      );
      return;
    }
    if (requiresCustomUsageQueryConfirmation(usageQuery, customUsageQueryConfirmed)) {
      const confirmed = await requestUsageQueryConfirm({
        title: t("settings.providerUsageCustomConfirmTitle"),
        description: t("settings.providerUsageCustomConfirmDescription"),
        detail: t("settings.providerUsageCustomConfirmDetail"),
        confirmLabel: t("settings.providerUsageCustomConfirmAction"),
        cancelLabel: t("settings.cancel"),
        tone: "warning",
      });
      if (!confirmed) return;
      setCustomUsageQueryConfirmed(true);
    }
    const nextApiKey = apiKeyIsRedactedDisplay ? "" : apiKey.trim();
    onSave({
      name: name.trim(),
      type: providerType,
      baseUrl: baseUrl.trim(),
      isFullUrl,
      modelsUrl: providerType === "gemini" ? undefined : modelsUrl.trim() || undefined,
      apiKey: nextApiKey,
      apiKeyConfigured:
        nextApiKey.length > 0 ||
        apiKeyIsRedactedDisplay ||
        (isGatewayWebui && initialData?.apiKeyConfigured === true),
      customHeaders,
      models,
      modelOrder,
      activeModels: Array.from(activeModels),
      requestFormat:
        providerType === "xai"
          ? "openai-responses"
          : providerType === "codex"
            ? requestFormat
            : undefined,
      reasoning:
        providerType === "gemini" && initialData?.reasoning === "xhigh"
          ? "high"
          : (initialData?.reasoning ?? "off"),
      promptCachingEnabled:
        providerType === "codex"
          ? promptCacheHintMode !== "none"
          : providerType === "gemini" || providerType === "xai"
            ? false
            : promptCachingEnabled,
      promptCacheHintMode: providerType === "codex" ? promptCacheHintMode : undefined,
      promptCacheRetention:
        providerType === "claude_code" && promptCachingEnabled && promptCacheRetention === "long"
          ? "long"
          : undefined,
      nativeWebSearchEnabled: initialData?.nativeWebSearchEnabled ?? true,
      useSystemProxy,
      usageQuery: serializeUsageQueryDraft(usageQuery, isGatewayWebui),
    });
    onClose();
  }

  async function handleTestUsageQuery() {
    if (!persistedUsageQueryProviderId) return;
    const seq = ++usageQueryTestSeqRef.current;
    setUsageQueryTest({ status: "running", data: [], error: null });
    try {
      // 测试永远以编辑器里的草稿为准(忽略启用开关,不落库、不进缓存);
      // 秘密占位符经 serialize 还原为空串,由桌面端按 *Configured 沿用已存密钥。
      const draft = serializeUsageQueryDraft(usageQuery, isGatewayWebui);
      const result = await testProviderUsage(persistedUsageQueryProviderId, draft);
      if (usageQueryTestSeqRef.current !== seq) return;
      if (result?.error) {
        setUsageQueryTest({ status: "error", data: result.data ?? [], error: result.error });
      } else {
        setUsageQueryTest({ status: "success", data: result?.data ?? [], error: null });
      }
    } catch (error) {
      if (usageQueryTestSeqRef.current !== seq) return;
      setUsageQueryTest({
        status: "error",
        data: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const isEditing = Boolean(initialData);
  const typeLabel = getProviderLabel(providerType);
  const orderedModels = useMemo(
    () => applyModelOrderSnapshot(models, modelDisplayOrder),
    [models, modelDisplayOrder],
  );
  useLayoutEffect(() => {
    // The rendered row order is the commit boundary for restoring scroll and running FLIP.
    void orderedModels;
    const pending = pendingModelLayoutRef.current;
    if (!pending) return;
    pendingModelLayoutRef.current = null;
    if (pending.scrollTop !== null && pending.scrollContainer) {
      pending.scrollContainer.scrollTop = pending.scrollTop;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rows = modelListRef.current?.querySelectorAll<HTMLElement>("[data-model-row-id]");
    for (const row of rows ?? []) {
      const id = row.dataset.modelRowId;
      const previousTop = id ? pending.topById.get(id) : undefined;
      if (previousTop === undefined) continue;
      const delta = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
        duration: MODEL_FLIP_DURATION_MS,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
  }, [orderedModels]);
  const modelSearchQuery = modelSearch.trim().toLowerCase();
  const visibleModels = useMemo(
    () =>
      modelSearchQuery
        ? orderedModels.filter((model) => model.id.toLowerCase().includes(modelSearchQuery))
        : orderedModels,
    [orderedModels, modelSearchQuery],
  );
  const allVisibleModelsSelected =
    visibleModels.length > 0 && visibleModels.every((model) => modelBulkSelection.has(model.id));
  const { enableCount: modelBulkEnableCount, disableCount: modelBulkDisableCount } = useMemo(
    () => getModelBulkActionCounts(modelBulkSelection, activeModels),
    [modelBulkSelection, activeModels],
  );
  const modelReorderDisabledHint = modelBulkMode
    ? t("settings.modelReorderDisabledBulk")
    : modelSearchQuery
      ? t("settings.modelReorderDisabledSearch")
      : t("settings.reorderNeedsTwoItems");
  const handleModelReorder = useCallback((nextIds: string[]) => {
    if (modelSortTimerRef.current) clearTimeout(modelSortTimerRef.current);
    modelSortTimerRef.current = null;
    setModels((current) => {
      return itemsByIdOrder(current, nextIds);
    });
    setModelOrder(nextIds);
    setModelDisplayOrder(nextIds);
  }, []);
  const {
    draggingItemId: draggingModelId,
    getItemProps: getModelReorderProps,
    renderDragHandle: renderModelDragHandle,
    scrollContainerRef: modelScrollContainerRef,
  } = useVerticalListReorder({
    itemIds: orderedModels.map((model) => model.id),
    canReorder: !modelBulkMode && !modelSearchQuery,
    reorderLabel: t("settings.reorderModel"),
    reorderHint: t("settings.reorderVerticalHint"),
    disabledHint: modelReorderDisabledHint,
    onReorder: handleModelReorder,
  });
  draggingModelIdRef.current = draggingModelId;
  const headerSuggestQuery = headerSuggest
    ? (customHeaders[headerSuggest.index]?.key ?? "").trim().toLowerCase()
    : "";
  const headerSuggestUsed = new Set(
    headerSuggest
      ? customHeaders
          .filter((_, index) => index !== headerSuggest.index)
          .map((header) => header.key.trim().toLowerCase())
          .filter(Boolean)
      : [],
  );
  const headerSuggestItems = headerSuggest
    ? headerSuggestQuery
      ? getCustomHeaderKeyPresets(providerType).filter((preset) => {
          const lower = preset.toLowerCase();
          if (headerSuggestUsed.has(lower)) return false;
          return lower.includes(headerSuggestQuery) && lower !== headerSuggestQuery;
        })
      : []
    : [];
  const headerSuggestActiveIndex = Math.min(
    headerSuggestActive,
    Math.max(0, headerSuggestItems.length - 1),
  );
  const headerImportErrorMessage = headerImportError
    ? t("settings.customHeaderImportError." + headerImportError)
    : null;
  const headerImportSummaryMessage = headerImportSummary
    ? [
        t("settings.customHeaderImportSummary.imported") + " " + headerImportSummary.importedCount,
        t("settings.customHeaderImportSummary.overwritten") +
          " " +
          headerImportSummary.overwrittenCount,
        headerImportSummary.issues.length > 0
          ? t("settings.customHeaderImportSummary.skipped") +
            " " +
            headerImportSummary.issues
              .map(
                (issue) =>
                  (issue.key ?? t("settings.customHeaderImportUnknownItem")) +
                  " (" +
                  t("settings.customHeaderImportIssue." + issue.reason) +
                  ")",
              )
              .join(", ")
          : null,
      ]
        .filter(Boolean)
        .join("; ")
    : null;
  const firstHeaderIssue =
    customHeaders
      .map((header) => getCustomHeaderIssue(header, headerValidationSubmitted))
      .find((issue) => issue !== null) ?? null;
  const headerIssueMessage = firstHeaderIssue
    ? customHeaderIssueMessage(firstHeaderIssue, t)
    : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="settings-modal-panel flex h-[600px] max-h-[calc(100dvh-2rem)] max-w-[860px] flex-col p-0 max-[720px]:h-[100dvh] max-[720px]:max-h-[100dvh] max-[720px]:max-w-none max-[720px]:rounded-none max-[720px]:border-0"
        viewportClassName="max-[720px]:p-0"
      >
        <div className="settings-modal-header flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 max-[720px]:px-3.5 max-[720px]:py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center text-xl text-foreground">
              <ProviderBrandIcon type={providerType} />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <DialogTitle className="text-sm">
                {isEditing ? t("settings.editProvider") : t("settings.addProvider")}
              </DialogTitle>
              <span className="rounded-full border bg-muted/60 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                {typeLabel} {t("settings.compatible")}
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            title={t("settings.close")}
            aria-label={t("settings.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 max-[720px]:flex-col">
          <nav
            className="flex w-[172px] shrink-0 flex-col gap-1 border-r bg-muted/30 p-2.5 max-[720px]:w-full max-[720px]:flex-row max-[720px]:overflow-x-auto max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:px-2.5 max-[720px]:py-2"
            aria-label={t("settings.providerDialogNavigation")}
          >
            <button
              type="button"
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs transition-colors hover:bg-accent/50 hover:text-foreground",
                activePanel === "general" && "bg-primary/10 font-medium text-primary",
              )}
              onClick={() => setActivePanel("general")}
              aria-current={activePanel === "general" ? "page" : undefined}
            >
              <Settings className="h-4 w-4 shrink-0 max-[720px]:h-3.5 max-[720px]:w-3.5" />
              {t("settings.providerDialogGeneral")}
            </button>
            <button
              type="button"
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs transition-colors hover:bg-accent/50 hover:text-foreground",
                activePanel === "request" && "bg-primary/10 font-medium text-primary",
              )}
              onClick={() => {
                exitModelBulkMode();
                setActivePanel("request");
              }}
              aria-current={activePanel === "request" ? "page" : undefined}
            >
              <Globe className="h-4 w-4 shrink-0 max-[720px]:h-3.5 max-[720px]:w-3.5" />
              <span className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
                {t("settings.providerDialogRequest")}
              </span>
              {customHeaders.length > 0 ? (
                <span
                  className={cn(
                    "min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] tabular-nums text-muted-foreground",
                    activePanel === "request" && "bg-primary text-primary-foreground",
                  )}
                >
                  {customHeaders.length}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs transition-colors hover:bg-accent/50 hover:text-foreground",
                activePanel === "usage" && "bg-primary/10 font-medium text-primary",
              )}
              onClick={() => {
                exitModelBulkMode();
                setActivePanel("usage");
              }}
              aria-current={activePanel === "usage" ? "page" : undefined}
            >
              <Key className="h-4 w-4 shrink-0 max-[720px]:h-3.5 max-[720px]:w-3.5" />
              {t("settings.providerUsageQuery")}
            </button>
          </nav>

          <div
            ref={modelScrollContainerRef}
            className="settings-modal-body min-w-0 flex-1 overflow-y-auto [overflow-anchor:none] px-6 py-5 max-[720px]:px-3.5 max-[720px]:pb-[calc(0.875rem+env(safe-area-inset-bottom))] max-[720px]:pt-3.5"
            onScroll={() => setHeaderSuggest(null)}
          >
            {activePanel === "general" ? (
              <section key="general" className="provider-panel-enter">
                <div className="text-sm font-semibold">{t("settings.basicInformation")}</div>

                <div className="mt-3 space-y-1.5">
                  <Label htmlFor="modal-name">{t("settings.providerName")}</Label>
                  <Input
                    id="modal-name"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Label htmlFor="modal-baseurl">{t("settings.baseUrl")}</Label>
                      <div className="flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5">
                        <Link2
                          className={cn(
                            "h-3.5 w-3.5",
                            isFullUrl ? "text-sky-500" : "text-muted-foreground",
                          )}
                        />
                        <span
                          className={cn(
                            "text-xs font-medium",
                            isFullUrl ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {t("settings.providerFullUrl")}
                        </span>
                        <Switch
                          checked={isFullUrl}
                          onCheckedChange={setIsFullUrl}
                          aria-label={t("settings.providerFullUrl")}
                          title={t("settings.providerFullUrl")}
                        />
                      </div>
                    </div>
                    <Input
                      id="modal-baseurl"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.currentTarget.value)}
                    />
                    {isFullUrl ? (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("settings.providerFullUrlHint")}
                      </p>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="modal-apikey">API Key</Label>
                    <div className="relative">
                      <Input
                        id="modal-apikey"
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        className="pr-10"
                        onChange={(event) => setApiKey(event.currentTarget.value)}
                        onFocus={(event) => {
                          if (apiKeyIsRedactedDisplay) event.currentTarget.select();
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-10 w-10 text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onClick={() => setShowApiKey((prev) => !prev)}
                        title={showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
                        aria-label={
                          showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")
                        }
                      >
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </div>

                {providerType !== "gemini" ? (
                  <div className="mt-3 space-y-1.5">
                    <Label htmlFor="modal-models-url">{t("settings.providerModelsUrl")}</Label>
                    <Input
                      id="modal-models-url"
                      value={modelsUrl}
                      placeholder={t("settings.providerModelsUrlPlaceholder")}
                      onChange={(event) => setModelsUrl(event.currentTarget.value)}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("settings.providerModelsUrlHint")}
                    </p>
                  </div>
                ) : null}

                {providerType === "codex" ? (
                  <div className="mt-4 space-y-1.5">
                    <Label>{t("settings.requestFormat")}</Label>
                    <Select
                      value={requestFormat}
                      onValueChange={(value) => setRequestFormat(value as CodexRequestFormat)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>{CODEX_REQUEST_FORMAT_LABELS[requestFormat]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(CODEX_REQUEST_FORMAT_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <div className="mt-6 text-sm font-semibold">{t("settings.models")}</div>
                <div className="mt-3 overflow-hidden rounded-xl border">
                  <div className="flex items-center gap-2 border-b bg-muted/30 p-2.5 max-[720px]:flex-wrap">
                    <div className="relative min-w-0 flex-1 max-[720px]:basis-full">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={modelSearch}
                        className="h-9 pl-9 pr-9 text-xs"
                        placeholder={t("settings.searchModels")}
                        aria-label={t("settings.searchModels")}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setModelSearch(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setModelSearch("");
                        }}
                      />
                      {modelSearch ? (
                        <button
                          type="button"
                          className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() => setModelSearch("")}
                          title={t("settings.clearModelSearch")}
                          aria-label={t("settings.clearModelSearch")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant={modelBulkMode ? "secondary" : "outline"}
                      size="sm"
                      className="h-9 gap-1.5 max-[720px]:h-10 max-[720px]:min-w-36 max-[720px]:flex-1"
                      aria-pressed={modelBulkMode}
                      title={
                        modelBulkMode
                          ? t("settings.skillsBulkDone")
                          : t("settings.skillsBulkSelect")
                      }
                      onClick={toggleModelBulkMode}
                    >
                      <List className="h-3.5 w-3.5" />
                      {modelBulkMode
                        ? t("settings.skillsBulkDone")
                        : t("settings.skillsBulkSelect")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 max-[720px]:h-10 max-[720px]:min-w-36 max-[720px]:flex-1"
                      onClick={handleRefresh}
                      disabled={fetchingModels || (isGatewayWebui && !canFetchModels)}
                    >
                      <RefreshCw className={cn("h-3.5 w-3.5", fetchingModels && "animate-spin")} />
                      {fetchingModels ? t("settings.fetching") : t("settings.refreshModels")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 max-[720px]:h-10 max-[720px]:min-w-36 max-[720px]:flex-1"
                      onClick={() => setAddingModel(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("settings.manualAddModel")}
                    </Button>
                  </div>

                  {modelBulkMode ? (
                    <div className="flex flex-wrap items-center justify-end gap-1.5 border-b bg-background px-2.5 py-2 dark:bg-popover">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={visibleModels.length === 0 || allVisibleModelsSelected}
                        onClick={selectVisibleModels}
                      >
                        {t("settings.skillsBulkSelectAll")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={modelBulkSelection.size === 0}
                        onClick={() => setModelBulkSelection(new Set())}
                      >
                        {t("settings.skillsBulkClear")}
                      </Button>
                    </div>
                  ) : null}

                  {fetchError ? (
                    <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {fetchError}
                    </div>
                  ) : null}

                  {addingModel ? (
                    <div className="settings-inline-form flex gap-2 border-b bg-muted/20 p-2.5 max-[720px]:flex-wrap">
                      <Input
                        autoFocus
                        value={newModelName}
                        className="h-9 text-sm max-[720px]:h-10 max-[720px]:basis-full"
                        placeholder={t("settings.modelName")}
                        onChange={(event) => setNewModelName(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleAddModel();
                          if (event.key === "Escape") setAddingModel(false);
                        }}
                      />
                      <Button size="sm" className="h-9" onClick={handleAddModel}>
                        {t("settings.add")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9"
                        onClick={() => setAddingModel(false)}
                      >
                        {t("settings.cancel")}
                      </Button>
                    </div>
                  ) : null}

                  <div ref={modelListRef} className="divide-y">
                    {visibleModels.length === 0 ? (
                      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                        {models.length > 0 && modelSearchQuery
                          ? t("settings.noMatchingModels")
                          : baseUrl.trim() && apiKeyForRequest
                            ? t("settings.fetchFailed")
                            : t("settings.fetchHint")}
                      </div>
                    ) : (
                      visibleModels.map((model) => {
                        const isEditingModel = editingModel?.model.id === model.id;
                        const newModelPhase = newModelPhases.get(model.id);
                        return (
                          // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: The row becomes an accessible checkbox only while bulk mode is active.
                          <div
                            key={model.id}
                            {...getModelReorderProps(model.id)}
                            data-model-row-id={model.id}
                            className={cn(
                              "settings-model-row group transition-colors duration-500 hover:bg-accent/30",
                              draggingModelId === model.id && "bg-accent shadow-lg",
                              modelBulkMode && "cursor-pointer",
                              modelBulkSelection.has(model.id) && "bg-primary/5",
                              newModelPhase === "visible" && "bg-primary/10 hover:bg-primary/15",
                              newModelPhase === "fading" && "bg-primary/[0.04]",
                            )}
                            role={modelBulkMode ? "checkbox" : undefined}
                            aria-checked={
                              modelBulkMode ? modelBulkSelection.has(model.id) : undefined
                            }
                            tabIndex={modelBulkMode ? 0 : undefined}
                            onClick={() => {
                              if (modelBulkMode) toggleModelBulkSelection(model.id);
                            }}
                            onKeyDown={(event) => {
                              if (
                                !modelBulkMode ||
                                event.target !== event.currentTarget ||
                                (event.key !== "Enter" && event.key !== " ")
                              ) {
                                return;
                              }
                              event.preventDefault();
                              toggleModelBulkSelection(model.id);
                            }}
                          >
                            <div className="flex items-center gap-2 px-3 py-2 max-[720px]:grid max-[720px]:grid-cols-[auto_minmax(0,1fr)_2.5rem_2.5rem]">
                              <div className="flex shrink-0 items-center gap-1">
                                {renderModelDragHandle(model.id, model.id)}
                                {modelBulkMode ? (
                                  <label
                                    className="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center"
                                    title={t("settings.skillsHubBulkSelectLabel")}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => event.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      className="peer sr-only"
                                      checked={modelBulkSelection.has(model.id)}
                                      aria-label={`${t("settings.skillsHubBulkSelectLabel")}: ${model.id}`}
                                      onChange={() => toggleModelBulkSelection(model.id)}
                                    />
                                    <span
                                      aria-hidden="true"
                                      className={cn(
                                        "pointer-events-none flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                                        modelBulkSelection.has(model.id)
                                          ? "border-primary bg-primary text-primary-foreground"
                                          : "border-border bg-background group-hover:border-foreground/40",
                                      )}
                                    >
                                      {modelBulkSelection.has(model.id) ? (
                                        <Check className="h-3 w-3" />
                                      ) : null}
                                    </span>
                                  </label>
                                ) : (
                                  <DialogSwitch
                                    checked={activeModels.has(model.id)}
                                    onCheckedChange={() => toggleModel(model.id)}
                                    ariaLabel={model.id}
                                  />
                                )}
                              </div>
                              <div className="min-w-0 flex-1 max-[720px]:col-[2/5] max-[720px]:row-start-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-sm font-medium">{model.id}</span>
                                  {newModelPhase ? (
                                    <span
                                      className={cn(
                                        "shrink-0 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold leading-none tracking-wide text-primary transition-all duration-500 max-[420px]:px-1.5",
                                        newModelPhase === "fading" && "scale-95 opacity-0",
                                      )}
                                    >
                                      {t("settings.newModelBadge")}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground max-[720px]:col-[1/3] max-[720px]:row-start-2 max-[720px]:min-w-0">
                                {formatTokenCount(model.contextWindow)} ctx ·{" "}
                                {formatTokenCount(model.maxOutputToken)} out
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "h-10 w-10 shrink-0 text-muted-foreground hover:text-foreground max-[720px]:col-start-3 max-[720px]:row-start-2",
                                  isEditingModel && "bg-primary/10 text-primary",
                                )}
                                disabled={modelBulkMode}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openModelSettings(model.id);
                                }}
                                title={t("settings.modelSettings")}
                                aria-label={t("settings.modelSettings")}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive max-[720px]:col-start-4 max-[720px]:row-start-2"
                                disabled={modelBulkMode}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeModel(model.id);
                                }}
                                title={t("settings.delete")}
                                aria-label={t("settings.delete")}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>

                            {isEditingModel && editingModel ? (
                              <div className="mx-3 mb-3 rounded-lg border bg-muted/20 p-3">
                                <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                                  <div className="space-y-1.5">
                                    <Label>{t("settings.contextWindow")}</Label>
                                    <Input
                                      inputMode="numeric"
                                      aria-invalid={
                                        editingModelContextWindow === null ? true : undefined
                                      }
                                      className={cn(
                                        editingModelContextWindow === null &&
                                          "ring-1 ring-inset ring-destructive focus-visible:ring-destructive",
                                      )}
                                      value={editingModel.contextWindow}
                                      onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setEditingModel((prev) =>
                                          prev ? { ...prev, contextWindow: value } : prev,
                                        );
                                      }}
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <Label>{t("settings.maxOutputToken")}</Label>
                                    <Input
                                      inputMode="numeric"
                                      aria-invalid={
                                        editingModelMaxOutputToken === null ? true : undefined
                                      }
                                      className={cn(
                                        editingModelMaxOutputToken === null &&
                                          "ring-1 ring-inset ring-destructive focus-visible:ring-destructive",
                                      )}
                                      value={editingModel.maxOutputToken}
                                      onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setEditingModel((prev) =>
                                          prev ? { ...prev, maxOutputToken: value } : prev,
                                        );
                                      }}
                                    />
                                  </div>
                                  {providerType === "codex" ? (
                                    <div className="col-span-2 space-y-1.5 max-[720px]:col-span-1">
                                      <Label>{t("settings.promptCacheHintModelOverride")}</Label>
                                      <Select
                                        value={editingModel.model.promptCacheHintMode ?? "inherit"}
                                        onValueChange={(value) =>
                                          setEditingModel((prev) =>
                                            prev
                                              ? {
                                                  ...prev,
                                                  model: {
                                                    ...prev.model,
                                                    promptCacheHintMode:
                                                      value === "inherit"
                                                        ? undefined
                                                        : (value as PromptCacheHintMode),
                                                  },
                                                }
                                              : prev,
                                          )
                                        }
                                      >
                                        <SelectTrigger>
                                          {/* value≠label：闭合态必须显式渲染本地化标签。 */}
                                          <SelectValue>
                                            {t(
                                              editingModel.model.promptCacheHintMode
                                                ? PROMPT_CACHE_HINT_LABEL_KEYS[
                                                    editingModel.model.promptCacheHintMode
                                                  ]
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
                                    </div>
                                  ) : null}
                                </div>

                                {!canSaveEditingModel ? (
                                  <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                    {t("settings.positiveIntegerRequired")}
                                  </div>
                                ) : null}

                                <div className="mt-3 flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setEditingModel(null)}
                                  >
                                    {t("settings.cancel")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={!canSaveEditingModel}
                                    onClick={saveInlineModelSettings}
                                  >
                                    {t("settings.save")}
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>
            ) : activePanel === "request" ? (
              <section key="request" className="provider-panel-enter">
                <div className="text-sm font-semibold">{t("settings.providerDialogRequest")}</div>

                <div
                  className={cn(
                    "mt-3 flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                    useSystemProxy && "border-primary/35 bg-primary/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors",
                      useSystemProxy && "bg-primary/15 text-primary",
                    )}
                  >
                    <Waypoints className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1 text-sm font-medium">
                    {t("settings.providerUseSystemProxy")}
                  </div>
                  <DialogSwitch
                    checked={useSystemProxy}
                    onCheckedChange={setUseSystemProxy}
                    ariaLabel={t("settings.providerUseSystemProxy")}
                  />
                </div>

                {providerType !== "gemini" && providerType !== "xai" ? (
                  <div
                    className={cn(
                      "mt-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                      (providerType === "codex"
                        ? promptCacheHintMode !== "none"
                        : promptCachingEnabled) && "border-primary/35 bg-primary/[0.04]",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors",
                          (providerType === "codex"
                            ? promptCacheHintMode !== "none"
                            : promptCachingEnabled) && "bg-primary/15 text-primary",
                        )}
                      >
                        <Zap className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{t("settings.promptCaching")}</div>
                        <div className="text-xs text-muted-foreground">
                          {providerType === "claude_code"
                            ? t("settings.promptCachingDescClaude")
                            : t("settings.promptCachingDescCodex")}
                        </div>
                      </div>
                      {providerType === "claude_code" ? (
                        <DialogSwitch
                          checked={promptCachingEnabled}
                          onCheckedChange={setPromptCachingEnabled}
                          ariaLabel={t("settings.promptCaching")}
                        />
                      ) : null}
                    </div>
                    {providerType === "codex" ? (
                      <div className="mt-3 border-t pt-3">
                        <Select
                          value={promptCacheHintMode}
                          onValueChange={(value) =>
                            setPromptCacheHintMode(value as PromptCacheHintMode)
                          }
                        >
                          <SelectTrigger aria-label={t("settings.promptCacheHintMode")}>
                            {/* value≠label：闭合态必须显式渲染本地化标签。 */}
                            <SelectValue>
                              {t(PROMPT_CACHE_HINT_LABEL_KEYS[promptCacheHintMode])}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {PROMPT_CACHE_HINT_MODES.map((mode) => (
                              <SelectItem key={mode} value={mode}>
                                {t(PROMPT_CACHE_HINT_LABEL_KEYS[mode])}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                    {providerType === "claude_code" && promptCachingEnabled ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                        <span className="text-xs text-muted-foreground">
                          {t("settings.promptCacheRetention")}
                        </span>
                        {(
                          [
                            ["short", "settings.promptCacheRetentionShort"],
                            ["long", "settings.promptCacheRetentionLong"],
                          ] as const
                        ).map(([value, labelKey]) => (
                          <button
                            key={value}
                            type="button"
                            className={cn(
                              "rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary",
                              promptCacheRetention === value &&
                                "border-primary bg-primary/10 text-primary",
                            )}
                            aria-pressed={promptCacheRetention === value}
                            onClick={() => setPromptCacheRetention(value)}
                          >
                            {t(labelKey)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 max-[720px]:w-full">
                    <span className="text-sm font-semibold">{t("settings.customHeaders")}</span>
                    {customHeaders.length > 0 ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                        {customHeaders.length}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2 max-[720px]:w-full">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={cn(
                        "h-8 shrink-0 gap-1.5 max-[720px]:h-11 max-[720px]:flex-1",
                        headerImportOpen && "border-primary/50 bg-primary/10 text-primary",
                      )}
                      aria-expanded={headerImportOpen}
                      onClick={() => {
                        setHeaderImportOpen((open) => !open);
                        setHeaderImportError(null);
                        setHeaderImportSummary(null);
                        setHeaderSuggest(null);
                      }}
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                      {t("settings.importCustomHeaders")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 gap-1.5 max-[720px]:h-11 max-[720px]:flex-1"
                      /* 导入视图占据了列表位置,此时新增行不可见,禁用避免静默无响应。 */
                      disabled={headerImportOpen}
                      onClick={() => addCustomHeader()}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("settings.addCustomHeader")}
                    </Button>
                  </div>
                </div>

                {headerImportOpen ? (
                  <div className="provider-panel-enter mt-3 min-w-0 rounded-xl border bg-card p-3">
                    <Label
                      htmlFor="provider-custom-header-import"
                      className="mb-2 block text-xs font-medium"
                    >
                      {t("settings.customHeaderImportLabel")}
                    </Label>
                    <Textarea
                      id="provider-custom-header-import"
                      value={headerImportText}
                      className="min-h-[120px] w-full min-w-0 resize-y font-mono text-xs leading-relaxed"
                      placeholder={t("settings.customHeaderImportPlaceholder")}
                      aria-invalid={headerImportErrorMessage ? true : undefined}
                      aria-describedby={
                        headerImportErrorMessage ? "provider-custom-header-import-error" : undefined
                      }
                      spellCheck={false}
                      autoFocus
                      onChange={(event) => {
                        setHeaderImportText(event.currentTarget.value);
                        setHeaderImportError(null);
                        setHeaderImportSummary(null);
                      }}
                    />
                    {headerImportErrorMessage ? (
                      <p
                        id="provider-custom-header-import-error"
                        className="mt-2 text-xs text-destructive"
                        role="alert"
                      >
                        {headerImportErrorMessage}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap justify-end gap-2 max-[720px]:w-full">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9 max-[720px]:h-11 max-[720px]:flex-1"
                        onClick={cancelCustomHeaderImport}
                      >
                        {t("settings.cancelCustomHeaderImport")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 max-[720px]:h-11 max-[720px]:flex-1"
                        onClick={handleImportCustomHeaders}
                      >
                        {t("settings.parseAndImportCustomHeaders")}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {headerImportSummaryMessage ? (
                  <p
                    className="mt-3 rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    {headerImportSummaryMessage}
                  </p>
                ) : null}

                {/* 导入视图与请求头列表互斥:解析成功后回到列表,直接看到增量导入的结果。 */}
                {headerImportOpen ? null : customHeaders.length === 0 ? (
                  <button
                    type="button"
                    className="mt-3 flex w-full flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/20"
                    onClick={() => addCustomHeader()}
                  >
                    <List className="h-5 w-5 text-muted-foreground/60" />
                    <span className="mt-1 text-xs font-medium text-muted-foreground">
                      {t("settings.noCustomHeaders")}
                    </span>
                    <span className="text-[11px] text-muted-foreground/75">
                      {t("settings.noCustomHeadersHint")}
                    </span>
                  </button>
                ) : (
                  <div className="mt-3 space-y-2">
                    <div
                      className="-m-0.5 max-h-[196px] space-y-2 overflow-y-auto p-0.5 max-[720px]:max-h-[360px]"
                      onScroll={() => setHeaderSuggest(null)}
                    >
                      {customHeaders.map((header, index) => {
                        const issue = getCustomHeaderIssue(header, headerValidationSubmitted);
                        const issueTitle = issue ? customHeaderIssueMessage(issue, t) : undefined;
                        const valueIssue = issue === "invalid-value";
                        const keyIssue = issue !== null && !valueIssue;
                        const suggestOpen =
                          headerSuggest?.index === index && headerSuggestItems.length > 0;

                        return (
                          <div
                            key={index}
                            className={cn(
                              "provider-panel-enter group relative flex items-stretch overflow-hidden rounded-lg border bg-card transition-all focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/10 hover:border-muted-foreground/30 max-[720px]:flex-wrap",
                              issue &&
                                "border-destructive/60 focus-within:border-destructive focus-within:ring-destructive/10",
                            )}
                          >
                            <Input
                              ref={(element) => {
                                headerKeyRefs.current[index] = element;
                              }}
                              value={header.key}
                              className={cn(
                                "h-10 w-[210px] shrink-0 rounded-none border-0 border-r bg-muted/30 px-3 font-mono text-xs shadow-none focus-visible:ring-0 max-[720px]:w-full max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:bg-muted/40",
                                keyIssue && "text-destructive",
                              )}
                              placeholder={t("settings.customHeaderKeyPlaceholder")}
                              aria-label={t("settings.customHeaderName")}
                              aria-invalid={keyIssue ? true : undefined}
                              role="combobox"
                              aria-expanded={suggestOpen}
                              aria-controls={suggestOpen ? "provider-header-suggest" : undefined}
                              aria-autocomplete="list"
                              title={issueTitle}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(event) => {
                                updateCustomHeader(index, "key", event.currentTarget.value);
                                openHeaderSuggest(index);
                              }}
                              onFocus={() => openHeaderSuggest(index)}
                              onBlur={() => setHeaderSuggest(null)}
                              onKeyDown={(event) => {
                                if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  if (suggestOpen) {
                                    setHeaderSuggestActive(
                                      (headerSuggestActiveIndex + 1) % headerSuggestItems.length,
                                    );
                                  } else {
                                    openHeaderSuggest(index);
                                  }
                                  return;
                                }
                                if (event.key === "ArrowUp" && suggestOpen) {
                                  event.preventDefault();
                                  setHeaderSuggestActive(
                                    (headerSuggestActiveIndex - 1 + headerSuggestItems.length) %
                                      headerSuggestItems.length,
                                  );
                                  return;
                                }
                                if (event.key === "Escape" && headerSuggest) {
                                  event.preventDefault();
                                  setHeaderSuggest(null);
                                  return;
                                }
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                if (suggestOpen) {
                                  applyHeaderSuggestion(
                                    headerSuggestItems[headerSuggestActiveIndex],
                                  );
                                  return;
                                }
                                focusCustomHeader(index, "value");
                              }}
                            />
                            <div className="relative min-w-0 flex-1 max-[720px]:basis-full">
                              <Input
                                ref={(element) => {
                                  headerValueRefs.current[index] = element;
                                }}
                                type="text"
                                value={header.value}
                                className={cn(
                                  "h-10 w-full rounded-none border-0 bg-transparent pl-3 pr-11 font-mono text-xs shadow-none focus-visible:ring-0",
                                  valueIssue && "text-destructive",
                                )}
                                placeholder={t("settings.customHeaderValue")}
                                aria-label={t("settings.customHeaderValue")}
                                aria-invalid={valueIssue ? true : undefined}
                                title={valueIssue ? issueTitle : undefined}
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(event) =>
                                  updateCustomHeader(index, "value", event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  if (index === customHeaders.length - 1) addCustomHeader();
                                  else focusCustomHeader(index + 1, "key");
                                }}
                              />
                              <div className="settings-hover-actions absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-[720px]:opacity-100">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => removeCustomHeader(index)}
                                  title={t("settings.removeCustomHeader")}
                                  aria-label={t("settings.removeCustomHeader")}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {headerIssueMessage && !headerImportOpen ? (
                  <p className="mt-2 text-xs leading-relaxed text-destructive" role="alert">
                    {headerIssueMessage}
                  </p>
                ) : null}

                {headerSuggest && headerSuggestItems.length > 0
                  ? createPortal(
                      <div
                        id="provider-header-suggest"
                        role="listbox"
                        className="fixed z-[70] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
                        style={{
                          left: headerSuggest.rect.left,
                          top: headerSuggest.rect.top,
                          width: headerSuggest.rect.width,
                        }}
                      >
                        {headerSuggestItems.map((preset, itemIndex) => (
                          <button
                            key={preset}
                            type="button"
                            role="option"
                            aria-selected={itemIndex === headerSuggestActiveIndex}
                            className={cn(
                              "flex w-full items-center rounded-md px-2.5 py-2 text-left font-mono text-xs text-muted-foreground transition-colors",
                              itemIndex === headerSuggestActiveIndex && "bg-accent text-foreground",
                            )}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setHeaderSuggestActive(itemIndex)}
                            onClick={() => applyHeaderSuggestion(preset)}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )
                  : null}
              </section>
            ) : (
              <section key="usage" className="provider-panel-enter">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{t("settings.providerUsageQuery")}</div>
                  </div>
                  <DialogSwitch
                    checked={usageQuery.enabled}
                    onCheckedChange={(enabled) =>
                      setUsageQuery((previous) => ({ ...previous, enabled }))
                    }
                    ariaLabel={t("settings.providerUsageEnabled")}
                  />
                </div>

                {/* 未启用时隐藏全部配置与测试入口,只留开关。 */}
                {usageQuery.enabled ? (
                  <>
                    {/* 功能出处:居中带字分隔线,项目名是带图标的主色链接。 */}
                    <div className="mt-3 flex items-center gap-2 text-xs leading-5 text-muted-foreground">
                      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
                      <span className="shrink-0">{t("settings.providerUsageCredit")}</span>
                      <a
                        href="https://github.com/farion1231/cc-switch"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex shrink-0 items-center gap-1 font-medium text-primary transition-colors hover:underline"
                        title={t("settings.providerUsageCreditOpen")}
                        aria-label={t("settings.providerUsageCreditOpen")}
                      >
                        cc-switch
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
                    </div>

                    <div className="mt-4 space-y-1.5">
                      <Label>{t("settings.providerUsageMode")}</Label>
                      <Select
                        value={usageQuery.mode}
                        onValueChange={(mode) =>
                          setUsageQuery((previous) =>
                            applyUsageQueryModePreset(previous, mode as UsageQueryMode),
                          )
                        }
                      >
                        <SelectTrigger className="w-full">
                          {/* value≠label:闭合态必须显式渲染本地化标签(coding-plan → codingPlan 键)。 */}
                          <SelectValue>
                            {t(
                              usageQuery.mode === "coding-plan"
                                ? "settings.providerUsageMode.codingPlan"
                                : `settings.providerUsageMode.${usageQuery.mode}`,
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="custom">
                            {t("settings.providerUsageMode.custom")}
                          </SelectItem>
                          <SelectItem value="general">
                            {t("settings.providerUsageMode.general")}
                          </SelectItem>
                          <SelectItem value="newapi">
                            {t("settings.providerUsageMode.newapi")}
                          </SelectItem>
                          <SelectItem value="balance">
                            {t("settings.providerUsageMode.balance")}
                          </SelectItem>
                          <SelectItem value="coding-plan">
                            {t("settings.providerUsageMode.codingPlan")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {usageQuery.mode !== "custom" ? (
                      <p className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                        {usageQuery.mode === "general"
                          ? t("settings.providerUsageTemplate.general")
                          : usageQuery.mode === "newapi"
                            ? t("settings.providerUsageTemplate.newapi")
                            : usageQuery.mode === "balance"
                              ? t("settings.providerUsageTemplate.balance")
                              : t("settings.providerUsageTemplate.codingPlan")}
                      </p>
                    ) : null}

                    {/* 官方余额:按 Base URL 匹配到的供应商徽章。 */}
                    {usageQuery.mode === "balance" && matchedBalanceProviders.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {matchedBalanceProviders.map((entry) => (
                          <span
                            key={entry.id}
                            className="inline-flex items-center rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                          >
                            {entry.label}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {/* 只有通用模板需要用户自行填写 baseUrl / apiKey 覆盖。 */}
                    {usageQuery.mode === "general" ? (
                      <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-base-url">
                            {t("settings.providerUsageBaseUrl")}
                          </Label>
                          <Input
                            id="usage-query-base-url"
                            value={usageQuery.baseUrl}
                            placeholder={baseUrl.trim() || undefined}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                baseUrl: value,
                              }));
                            }}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-api-key">
                            {t("settings.providerUsageApiKey")}
                          </Label>
                          <Input
                            id="usage-query-api-key"
                            type="password"
                            value={usageQuery.apiKey}
                            autoComplete="off"
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                apiKey: value,
                              }));
                            }}
                          />
                        </div>
                      </div>
                    ) : null}

                    {/* 自定义模式:只读展示变量的实际生效值(对齐 cc-switch 支持的变量区)。 */}
                    {usageQuery.mode === "custom" ? (
                      <div className="mt-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs leading-5">
                        <div className="font-medium text-foreground">
                          {t("settings.providerUsageVariables")}
                        </div>
                        <div className="mt-2 flex min-w-0 items-center gap-2">
                          <code className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                            {"{{baseUrl}}"}
                          </code>
                          <span className="text-muted-foreground/60">=</span>
                          {usageVariableBaseUrl ? (
                            <code className="break-all font-mono text-muted-foreground">
                              {usageVariableBaseUrl}
                            </code>
                          ) : (
                            <span className="text-muted-foreground/60 italic">
                              {t("settings.providerUsageVariableNotSet")}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-2">
                          <code className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                            {"{{apiKey}}"}
                          </code>
                          <span className="text-muted-foreground/60">=</span>
                          {usageVariableApiKey ? (
                            <>
                              <code className="break-all font-mono text-muted-foreground">
                                {!isGatewayWebui && showUsageVariableApiKey
                                  ? usageVariableApiKey
                                  : "••••••••"}
                              </code>
                              {/* WebUI 永不下发明文 apiKey,查看按钮只在桌面端提供。 */}
                              {!isGatewayWebui ? (
                                <button
                                  type="button"
                                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                                  onClick={() =>
                                    setShowUsageVariableApiKey((previous) => !previous)
                                  }
                                  title={
                                    showUsageVariableApiKey
                                      ? t("settings.hideApiKey")
                                      : t("settings.showApiKey")
                                  }
                                  aria-label={
                                    showUsageVariableApiKey
                                      ? t("settings.hideApiKey")
                                      : t("settings.showApiKey")
                                  }
                                >
                                  {showUsageVariableApiKey ? (
                                    <EyeOff className="h-3 w-3" />
                                  ) : (
                                    <Eye className="h-3 w-3" />
                                  )}
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted-foreground/60 italic">
                              {t("settings.providerUsageVariableNotSet")}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {usageQuery.mode === "newapi" ? (
                      <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-access-token">
                            {t("settings.providerUsageAccessToken")}
                          </Label>
                          <Input
                            id="usage-query-access-token"
                            type="password"
                            value={usageQuery.accessToken}
                            autoComplete="off"
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                accessToken: value,
                              }));
                            }}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-user-id">
                            {t("settings.providerUsageUserId")}
                          </Label>
                          <Input
                            id="usage-query-user-id"
                            value={usageQuery.userId}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                userId: value,
                              }));
                            }}
                          />
                        </div>
                      </div>
                    ) : null}

                    {usageQuery.mode === "coding-plan" ? (
                      <>
                        {/* 内置供应商选择(一比一复刻 cc-switch Token Plan):
                            显式选择优先,否则按 Base URL 自动检测高亮。 */}
                        <div className="mt-4 flex flex-wrap gap-2">
                          {USAGE_QUERY_CODING_PLAN_PROVIDERS.map((entry) => (
                            <Button
                              key={entry.id}
                              type="button"
                              size="sm"
                              variant={
                                activeCodingPlanProvider === entry.id ? "default" : "outline"
                              }
                              onClick={() =>
                                setUsageQuery((previous) => ({
                                  ...previous,
                                  codingPlanProvider: entry.id,
                                }))
                              }
                            >
                              {entry.label}
                            </Button>
                          ))}
                        </div>

                        {activeCodingPlanProvider === "zenmux" ? (
                          <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                            <div className="space-y-1.5">
                              <Label htmlFor="usage-query-zenmux-base-url">
                                {t("settings.providerUsageBaseUrl")}
                              </Label>
                              <Input
                                id="usage-query-zenmux-base-url"
                                value={usageQuery.baseUrl}
                                placeholder="https://api.zenmux.com/v1/..."
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setUsageQuery((previous) => ({
                                    ...previous,
                                    baseUrl: value,
                                  }));
                                }}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="usage-query-zenmux-api-key">
                                {t("settings.providerUsageApiKey")}
                              </Label>
                              <Input
                                id="usage-query-zenmux-api-key"
                                type="password"
                                value={usageQuery.apiKey}
                                autoComplete="off"
                                placeholder="sk-..."
                                onFocus={(event) => event.currentTarget.select()}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setUsageQuery((previous) => ({
                                    ...previous,
                                    apiKey: value,
                                  }));
                                }}
                              />
                            </div>
                          </div>
                        ) : null}

                        {activeCodingPlanProvider === "zhipu_team" ? (
                          <>
                            <p className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                              {t("settings.providerUsageZhipuTeamHint")}{" "}
                              {t("settings.providerUsageZhipuTeamConsoleLink")}{" "}
                              <a
                                href="https://bigmodel.cn/coding-plan/team/usage-stats"
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                              >
                                bigmodel.cn/coding-plan/team/usage-stats
                              </a>
                            </p>
                            <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-team-organization-id">
                                  {t("settings.providerUsageOrganizationId")}
                                </Label>
                                <Input
                                  id="usage-query-team-organization-id"
                                  value={usageQuery.teamOrganizationId}
                                  placeholder={t("settings.providerUsageOrganizationIdPlaceholder")}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      teamOrganizationId: value,
                                    }));
                                  }}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-team-project-id">
                                  {t("settings.providerUsageProjectId")}
                                </Label>
                                <Input
                                  id="usage-query-team-project-id"
                                  value={usageQuery.teamProjectId}
                                  placeholder={t("settings.providerUsageProjectIdPlaceholder")}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      teamProjectId: value,
                                    }));
                                  }}
                                />
                              </div>
                            </div>
                          </>
                        ) : null}

                        {activeCodingPlanProvider === "volcengine" ? (
                          <>
                            <p className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                              {t("settings.providerUsageVolcengineHint")}{" "}
                              {t("settings.providerUsageVolcengineConsoleLink")}{" "}
                              <a
                                href="https://console.volcengine.com/iam/keymanage"
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                              >
                                console.volcengine.com/iam/keymanage
                              </a>
                            </p>
                            <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-access-key-id">
                                  {t("settings.providerUsageAccessKeyId")}
                                </Label>
                                <Input
                                  id="usage-query-access-key-id"
                                  value={usageQuery.accessKeyId}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      accessKeyId: value,
                                    }));
                                  }}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-secret-access-key">
                                  {t("settings.providerUsageSecretAccessKey")}
                                </Label>
                                <Input
                                  id="usage-query-secret-access-key"
                                  type="password"
                                  value={usageQuery.secretAccessKey}
                                  autoComplete="off"
                                  onFocus={(event) => event.currentTarget.select()}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      secretAccessKey: value,
                                    }));
                                  }}
                                />
                              </div>
                            </div>
                          </>
                        ) : null}
                      </>
                    ) : null}

                    <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                      <div className="space-y-1.5">
                        <Label htmlFor="usage-query-timeout">
                          {t("settings.providerUsageTimeout")}
                        </Label>
                        <Input
                          id="usage-query-timeout"
                          inputMode="numeric"
                          value={usageTimeoutInput}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setUsageTimeoutInput(value);
                          }}
                          onBlur={commitUsageTimeoutInput}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("settings.providerUsageTimeoutHint")}
                        </p>
                      </div>
                    </div>

                    {usageQuery.mode === "custom" ||
                    usageQuery.mode === "general" ||
                    usageQuery.mode === "newapi" ? (
                      <div className="mt-4 space-y-1.5">
                        <Label htmlFor="usage-query-script">
                          {t("settings.providerUsageScript")}
                        </Label>
                        <Textarea
                          id="usage-query-script"
                          value={usageQuery.script}
                          className="min-h-36 font-mono text-xs"
                          placeholder={t("settings.providerUsageScriptPlaceholder")}
                          spellCheck={false}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            // 同步写入当前模式的独立脚本槽位,切换查询方式互不串扰。
                            setUsageQuery((previous) => setUsageQueryScript(previous, value));
                          }}
                        />
                      </div>
                    ) : null}

                    {/* 测试查询:独占一行的 card——按钮居左,结果内容就地靠左展示。 */}
                    <div className="mt-4 flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-10 shrink-0 gap-1.5"
                        disabled={
                          !persistedUsageQueryProviderId || usageQueryTest.status === "running"
                        }
                        onClick={() => void handleTestUsageQuery()}
                        title={t("settings.providerUsageTest")}
                        aria-label={t("settings.providerUsageTest")}
                      >
                        <RefreshCw
                          className={cn(
                            "h-3.5 w-3.5",
                            usageQueryTest.status === "running" && "animate-spin",
                          )}
                        />
                        {t("settings.providerUsageTest")}
                      </Button>
                      <div className="min-w-0 flex-1 text-xs" role="status" aria-live="polite">
                        {usageQueryTest.status === "running" ? (
                          <span className="text-muted-foreground">
                            {t("settings.providerUsageTestRunning")}
                          </span>
                        ) : null}
                        {usageQueryTest.status === "error" ? (
                          <span className="text-destructive">
                            {t("settings.providerUsageTestFailed")}
                            {usageQueryTest.error ? `: ${usageQueryTest.error}` : ""}
                          </span>
                        ) : null}
                        {usageQueryTest.status === "success" ? (
                          usageQueryTest.data.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {usageQueryTest.data.map((plan, index) => (
                                <UsagePlanLine
                                  key={`${plan.planName ?? ""}:${
                                    // biome-ignore lint/suspicious/noArrayIndexKey: 套餐无稳定 id,索引即位置语义
                                    index
                                  }`}
                                  plan={getUsagePlanDisplay(plan)}
                                />
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("settings.providerUsageTestEmpty")}
                            </span>
                          )
                        ) : null}
                        {usageQueryTest.status === "idle" && !persistedUsageQueryProviderId ? (
                          <span className="text-muted-foreground">
                            {t("settings.providerUsageTestSavedHint")}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {usageQuery.mode === "custom" ||
                    usageQuery.mode === "general" ||
                    usageQuery.mode === "newapi" ? (
                      <div className="mt-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                        <div className="font-medium text-foreground">
                          {t("settings.providerUsageScriptHelp")}
                        </div>
                        <div className="mt-2 font-medium">
                          {t("settings.providerUsageScriptHelpFormat")}
                        </div>
                        <pre className="mt-1 overflow-x-auto rounded-md border bg-background/60 p-2 font-mono text-[11px] leading-4">
                          {USAGE_QUERY_SCRIPT_HELP_EXAMPLE}
                        </pre>
                        <div className="mt-2 font-medium">
                          {t("settings.providerUsageScriptHelpExtractor")}
                        </div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          <li>{t("settings.providerUsageScriptHelpField.planName")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.total")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.used")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.remaining")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.unit")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.isValid")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.invalidMessage")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.extra")}</li>
                        </ul>
                        <div className="mt-2 font-medium">
                          {t("settings.providerUsageScriptHelpTips")}
                        </div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          <li>{t("settings.providerUsageScriptHelpTip.variables")}</li>
                          <li>{t("settings.providerUsageScriptHelpTip.sandbox")}</li>
                          <li>{t("settings.providerUsageScriptHelpTip.wrap")}</li>
                          <li>{t("settings.providerUsageScriptHelpTip.origin")}</li>
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
            )}
          </div>
        </div>

        {modelBulkMode && activePanel === "general" ? (
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 border-t bg-background px-4 py-2 text-xs dark:bg-popover max-[420px]:gap-1 max-[420px]:px-2.5">
            <span className="whitespace-nowrap text-foreground/85">
              {t("settings.skillsBulkSelectedCount").replace(
                "{count}",
                String(modelBulkSelection.size),
              )}
            </span>
            <span className="text-muted-foreground/50 max-[420px]:hidden" aria-hidden="true">
              ·
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs max-[420px]:px-2"
              disabled={modelBulkEnableCount === 0}
              onClick={() => applyModelBulkState(true)}
            >
              {`${t("settings.skillsBulkEnable")} (${modelBulkEnableCount})`}
            </Button>
            <span className="text-muted-foreground/50 max-[420px]:hidden" aria-hidden="true">
              ·
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs max-[420px]:px-2"
              disabled={modelBulkDisableCount === 0}
              onClick={() => applyModelBulkState(false)}
            >
              {`${t("settings.skillsBulkDisable")} (${modelBulkDisableCount})`}
            </Button>
            <span className="text-muted-foreground/50 max-[420px]:hidden" aria-hidden="true">
              ·
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 gap-1 px-2.5 text-xs max-[420px]:px-2"
              onClick={exitModelBulkMode}
            >
              <X className="h-3.5 w-3.5" />
              {t("settings.skillsBulkDone")}
            </Button>
          </div>
        ) : null}

        <div className="settings-modal-footer flex shrink-0 items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3.5 max-[720px]:px-3.5 max-[720px]:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-[720px]:pt-3">
          <Button
            variant="outline"
            onClick={onClose}
            className="max-[720px]:h-10 max-[720px]:flex-1"
          >
            {t("settings.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim()}
            className="max-[720px]:h-10 max-[720px]:flex-1"
          >
            {t("settings.save")}
          </Button>
        </div>
        {usageQueryConfirmDialog}
      </DialogContent>
    </Dialog>
  );
}

function FailoverNumberField(props: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const { label, hint, value, min, max, onCommit } = props;
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commitDraft() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-[12.5px] font-medium text-foreground/85">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitDraft();
        }}
        className="h-9 rounded-lg border-foreground/10 bg-white/70 text-[13px] shadow-sm dark:bg-background/40"
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">{hint}</p>
    </div>
  );
}

function FailoverSettingsCard(props: SettingsSectionProps & { providerType: ProviderId }) {
  const { settings, setSettings, providerType } = props;
  const { t } = useLocale();
  const failover = settings.modelFailover[providerType];
  // Same-vendor guard: only providers of this tab's vendor type are offered,
  // so a Claude queue can never contain a Codex provider (and vice versa).
  // Failover keeps the conversation's model and only switches which provider
  // serves it, so the queue holds providers, not models.
  const vendorProviders = useMemo(
    () => settings.customProviders.filter((provider) => provider.type === providerType),
    [settings.customProviders, providerType],
  );

  const queueValues = useMemo(() => new Set(failover.queue), [failover.queue]);
  const addableProviders = useMemo(
    () => vendorProviders.filter((provider) => !queueValues.has(provider.id)),
    [vendorProviders, queueValues],
  );

  function patchFailover(patch: Partial<ProviderFailoverSettings>) {
    setSettings((prev) => updateModelFailover(prev, providerType, patch));
  }

  function queueEntryLabel(providerId: string) {
    const provider = settings.customProviders.find((item) => item.id === providerId);
    return provider?.name ?? providerId;
  }

  function queueEntryDetail(providerId: string) {
    const provider = settings.customProviders.find((item) => item.id === providerId);
    return provider?.baseUrl ?? "";
  }

  function addQueueEntry(providerId: string) {
    if (!providerId || queueValues.has(providerId)) return;
    patchFailover({ queue: [...failover.queue, providerId] });
  }

  function removeQueueEntry(index: number) {
    patchFailover({ queue: failover.queue.filter((_, i) => i !== index) });
  }

  function moveQueueEntry(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= failover.queue.length) return;
    const queue = failover.queue.slice();
    const [entry] = queue.splice(index, 1);
    queue.splice(target, 0, entry);
    patchFailover({ queue });
  }

  return (
    <div className="rounded-2xl border border-foreground/[0.06] bg-white/60 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.65)] backdrop-blur-xl dark:border-foreground/[0.08] dark:bg-foreground/[0.03] dark:shadow-none">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Label className="text-[12.5px] font-medium text-foreground/85">
              {t("settings.failoverTitle")}
            </Label>
            <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[10.5px] font-medium text-foreground/60">
              <ProviderBrandIcon type={providerType} />
              {getProviderLabel(providerType)}
            </span>
            {failover.enabled ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                {t("settings.failoverEnabled")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
            {t("settings.failoverToggleHint").replaceAll(
              "{vendor}",
              getProviderLabel(providerType),
            )}
          </p>
        </div>
        <DialogSwitch
          checked={failover.enabled}
          onCheckedChange={(checked) => patchFailover({ enabled: checked })}
          ariaLabel={t("settings.failoverTitle")}
        />
      </div>

      <div className="mt-3 space-y-2">
        <Label className="text-[12px] font-medium text-foreground/80">
          {t("settings.failoverQueueTitle")}
        </Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          {t("settings.failoverQueueHint").replaceAll("{vendor}", getProviderLabel(providerType))}
        </p>
        {failover.queue.length > 0 ? (
          <div className="space-y-1.5">
            {failover.queue.map((entry, index) => (
              <div
                key={entry}
                className="flex items-center gap-2 rounded-lg border border-foreground/[0.06] bg-white/70 px-2.5 py-1.5 dark:bg-background/40"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-[10.5px] font-semibold text-foreground/70">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90">
                  {queueEntryLabel(entry)}
                  {queueEntryDetail(entry) ? (
                    <span className="ml-2 text-[11px] text-muted-foreground/70">
                      {queueEntryDetail(entry)}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
                  onClick={() => moveQueueEntry(index, -1)}
                  disabled={index === 0}
                  title={t("settings.failoverQueueMoveUp")}
                  aria-label={t("settings.failoverQueueMoveUp")}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
                  onClick={() => moveQueueEntry(index, 1)}
                  disabled={index === failover.queue.length - 1}
                  title={t("settings.failoverQueueMoveDown")}
                  aria-label={t("settings.failoverQueueMoveDown")}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-500"
                  onClick={() => removeQueueEntry(index)}
                  title={t("settings.failoverQueueRemove")}
                  aria-label={t("settings.failoverQueueRemove")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
            {t("settings.failoverQueueEmpty")}
          </div>
        )}
        {failover.queue.length < MODEL_FAILOVER_QUEUE_LIMIT && addableProviders.length > 0 ? (
          <Select value="" onValueChange={addQueueEntry}>
            <SelectTrigger
              aria-label={t("settings.failoverQueueAdd")}
              className="h-9 w-full rounded-lg border-foreground/10 bg-white/70 text-[13px] shadow-sm dark:bg-background/40"
            >
              <SelectValue>
                <span className="text-muted-foreground">{t("settings.failoverQueueAdd")}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {addableProviders.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{provider.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground/70">
                      {provider.baseUrl}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3">
        <FailoverNumberField
          label={t("settings.failoverMaxSwitches")}
          hint={t("settings.failoverMaxSwitchesHint")}
          value={failover.maxSwitches}
          min={1}
          max={10}
          onCommit={(value) => patchFailover({ maxSwitches: value })}
        />
        <FailoverNumberField
          label={t("settings.failoverFailureThreshold")}
          hint={t("settings.failoverFailureThresholdHint")}
          value={failover.failureThreshold}
          min={1}
          max={10}
          onCommit={(value) => patchFailover({ failureThreshold: value })}
        />
        <FailoverNumberField
          label={t("settings.failoverCooldownSeconds")}
          hint={t("settings.failoverCooldownSecondsHint")}
          value={failover.cooldownSeconds}
          min={5}
          max={3600}
          onCommit={(value) => patchFailover({ cooldownSeconds: value })}
        />
      </div>
    </div>
  );
}

function CustomSettingsDrawer(
  props: SettingsSectionProps & { providerType: ProviderId; onClose: () => void },
) {
  const { settings, setSettings, providerType, onClose } = props;
  const { t } = useLocale();
  const modelOptions = useMemo(() => buildModelOptions(settings), [settings]);
  const conversationTitleModel = settings.customSettings.conversationTitleModel;
  const selectedValue = conversationTitleModel
    ? toModelValue(conversationTitleModel.customProviderId, conversationTitleModel.model)
    : "";
  // A stored model that is no longer among the active options still shows as
  // selected (same fallback-entry approach as the cron prompt form).
  const titleModelOptions =
    conversationTitleModel && !modelOptions.some((option) => option.value === selectedValue)
      ? [
          ...modelOptions,
          {
            value: selectedValue,
            label: conversationTitleModel.model,
            providerName: conversationTitleModel.customProviderId,
          },
        ]
      : modelOptions;

  function handleTitleModelChange(value: string) {
    // "" comes from the picker's follow-current entry and parses to undefined.
    setSettings((prev) =>
      updateCustomSettings(prev, {
        conversationTitleModel: parseModelValue(value) ?? undefined,
      }),
    );
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="max-w-none border-white/50 bg-white/70 shadow-[-32px_0_80px_-28px_rgba(15,23,42,0.22)] backdrop-blur-[28px] backdrop-saturate-150 sm:max-w-[440px] dark:border-foreground/[0.08] dark:bg-background/60"
        backdropClassName="bg-foreground/[0.06] backdrop-blur-md dark:bg-background/40"
        closeLabel={t("settings.closeCustomSettings")}
        showCloseButton={false}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-white/10"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/35 via-transparent to-white/5 dark:from-white/[0.02] dark:via-transparent dark:to-transparent"
        />

        <div className="relative flex items-start gap-3 px-6 pb-4 pt-[22px]">
          <div className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
            <SheetTitle className="text-[17px] leading-tight tracking-tight text-foreground/95">
              {t("settings.customSettings")}
            </SheetTitle>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground"
            title={t("settings.closeCustomSettings")}
            aria-label={t("settings.closeCustomSettings")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div
          aria-hidden="true"
          className="relative mx-6 h-px bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent"
        />

        <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <section className="space-y-3">
            <div className="rounded-2xl border border-foreground/[0.06] bg-white/60 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.65)] backdrop-blur-xl dark:border-foreground/[0.08] dark:bg-foreground/[0.03] dark:shadow-none">
              <div className="space-y-2">
                <Label className="text-[12.5px] font-medium text-foreground/85">
                  {t("settings.conversationTitleModel")}
                </Label>
                <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                  {t("settings.conversationTitleModelHint")}
                </p>
                <ModelPicker
                  options={titleModelOptions}
                  value={selectedValue}
                  onChange={handleTitleModelChange}
                  placeholder={t("settings.conversationTitleModelFollowCurrent")}
                  noneLabel={t("settings.conversationTitleModelFollowCurrent")}
                  ariaLabel={t("settings.conversationTitleModel")}
                  triggerClassName="h-9 rounded-lg border-foreground/10 bg-white/70 text-[13px] shadow-sm dark:bg-background/40"
                />
                {modelOptions.length === 0 ? (
                  <div className="mt-1 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
                    {t("settings.customSettingsModelEmpty")}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="mt-4 space-y-3">
            <FailoverSettingsCard
              settings={settings}
              setSettings={setSettings}
              providerType={providerType}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ProviderList(props: {
  type: ProviderId;
  providers: CustomProvider[];
  onAdd: () => void;
  onEdit: (provider: CustomProvider) => void;
  onDelete: (id: string) => void;
  onReorder: (type: ProviderId, nextIds: string[]) => void;
  usageByProvider: ProviderUsageState;
  refreshingProviderIds: ReadonlySet<string>;
  onRefreshUsage: (providerId: string) => void;
}) {
  const { t } = useLocale();
  const {
    type,
    providers,
    onAdd,
    onEdit,
    onDelete,
    onReorder,
    usageByProvider,
    refreshingProviderIds,
    onRefreshUsage,
  } = props;
  const filtered = providers.filter((provider) => provider.type === type);
  // 30s ticker 驱动"N 分钟前"相对时间;多套餐行的展开态是纯本地 UI 状态。
  const usageNow = useUsageNowTicker(
    filtered.some((provider) => provider.usageQuery?.enabled) ||
      Object.keys(usageByProvider).length > 0,
  );
  const [expandedUsageProviderIds, setExpandedUsageProviderIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  function toggleUsageExpanded(providerId: string) {
    setExpandedUsageProviderIds((previous) => {
      const next = new Set(previous);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }
  const {
    draggingItemId: draggingProviderId,
    getItemProps: getProviderReorderProps,
    renderDragHandle: renderProviderDragHandle,
    scrollContainerRef: providerScrollContainerRef,
  } = useVerticalListReorder({
    itemIds: filtered.map((provider) => provider.id),
    canReorder: true,
    reorderLabel: t("settings.reorderProvider"),
    reorderHint: t("settings.reorderVerticalHint"),
    disabledHint: t("settings.reorderNeedsTwoItems"),
    onReorder: (nextIds) => onReorder(type, nextIds),
  });

  return (
    <div className="settings-provider-list flex h-full min-h-0 flex-col gap-4">
      <div className="settings-section-heading-row flex shrink-0 items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {filtered.length === 0
            ? t("settings.noProviders")
            : `${filtered.length} ${t("settings.navProviders")}`}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="settings-section-action gap-1.5"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("settings.addProvider")}
        </Button>
      </div>

      <div ref={providerScrollContainerRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center">
            <div className="mb-3 flex items-center justify-center text-3xl text-foreground">
              <ProviderBrandIcon type={type} />
            </div>
            <p className="text-sm font-medium">{t("settings.noProvidersHint")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("settings.noProvidersAdd")}</p>
          </div>
        ) : (
          <div className="space-y-2 pb-1">
            {filtered.map((provider) =>
              (() => {
                const usage = usageByProvider[provider.id];
                const refreshing = refreshingProviderIds.has(provider.id);
                const usageDisplay = getProviderUsageCardDisplay(
                  provider,
                  usage,
                  refreshing,
                  usageNow,
                );
                const usageExpanded = expandedUsageProviderIds.has(provider.id);
                const visibleUsagePlans =
                  usageDisplay.plans.length > 1 && !usageExpanded
                    ? usageDisplay.plans.slice(0, 1)
                    : usageDisplay.plans;
                return (
                  <div
                    key={provider.id}
                    {...getProviderReorderProps(provider.id)}
                    className={cn(
                      "settings-card-row group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent/30",
                      draggingProviderId === provider.id && "bg-accent shadow-lg",
                    )}
                  >
                    {renderProviderDragHandle(provider.id, provider.name)}
                    <div className="flex w-5 shrink-0 items-center justify-center text-lg text-foreground">
                      <ProviderBrandIcon type={type} />
                    </div>
                    <div className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{provider.name}</span>
                        {provider.useSystemProxy ? (
                          <span
                            className="shrink-0 text-blue-500 dark:text-blue-400"
                            title={t("settings.providerUseSystemProxy")}
                          >
                            <Waypoints className="h-3 w-3" />
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {provider.baseUrl || t("settings.noBaseUrl")} {" · "}
                        {provider.activeModels.length} {t("settings.activeModels")}
                      </div>
                      {usageDisplay.show ? (
                        <div className="mt-1 flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                          {visibleUsagePlans.map((plan, index) => (
                            <UsagePlanLine
                              key={`${plan.title.kind === "text" ? plan.title.text : plan.title.kind}:${
                                // biome-ignore lint/suspicious/noArrayIndexKey: 套餐无稳定 id,索引即位置语义
                                index
                              }`}
                              plan={plan}
                            />
                          ))}
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            {usageDisplay.plans.length > 1 ? (
                              <button
                                type="button"
                                className="text-primary hover:underline"
                                onClick={() => toggleUsageExpanded(provider.id)}
                              >
                                {usageExpanded
                                  ? t("settings.providerUsageCollapse")
                                  : t("settings.providerUsageMorePlans").replace(
                                      "{count}",
                                      String(usageDisplay.plans.length - 1),
                                    )}
                              </button>
                            ) : null}
                            {usageDisplay.isStale ? (
                              <span title={t("settings.providerUsageStaleTitle")}>
                                {t("settings.providerUsageStale")}
                              </span>
                            ) : null}
                            {usageDisplay.error ? (
                              <span className="text-destructive">{usageDisplay.error}</span>
                            ) : null}
                            {usageDisplay.updatedAt ? (
                              <time>{usageRelativeTimeText(t, usageDisplay.updatedAt)}</time>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="settings-card-actions settings-hover-actions flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      {usageDisplay.show ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          disabled={usageDisplay.refreshDisabled}
                          onClick={() => onRefreshUsage(provider.id)}
                          title={t("settings.providerUsageRefresh")}
                          aria-label={t("settings.providerUsageRefresh")}
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={() => onEdit(provider)}
                        title={t("settings.edit")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <ConfirmDeletePopover
                        name={provider.name}
                        onConfirm={() => onDelete(provider.id)}
                      >
                        {(open) => (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={open}
                            title={t("settings.delete")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </ConfirmDeletePopover>
                    </div>
                  </div>
                );
              })(),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProvidersSection(
  props: SettingsSectionProps & {
    initialProviderId?: string;
    onInitialProviderHandled?: () => void;
  },
) {
  const { settings, setSettings, initialProviderId, onInitialProviderHandled } = props;
  const { t } = useLocale();

  const [activeTab, setActiveTab] = useState<ProviderId>("claude_code");
  const [modalOpen, setModalOpen] = useState(false);
  const [customSettingsOpen, setCustomSettingsOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(null);
  const { usageByProvider, refreshingProviderIds, refreshProvider } = useProviderUsage(
    settings.customProviders,
  );
  const openedInitialProviderIdRef = useRef<string | null>(null);

  useEffect(() => {
    const providerId = initialProviderId?.trim();
    if (!providerId || openedInitialProviderIdRef.current === providerId) return;
    const provider = settings.customProviders.find((item) => item.id === providerId);
    if (!provider) return;
    openedInitialProviderIdRef.current = providerId;
    setActiveTab(provider.type);
    setEditingProvider(provider);
    setModalOpen(true);
    onInitialProviderHandled?.();
  }, [initialProviderId, onInitialProviderHandled, settings.customProviders]);

  function openAdd() {
    setEditingProvider(null);
    setModalOpen(true);
  }

  function openEdit(provider: CustomProvider) {
    setEditingProvider(provider);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingProvider(null);
  }

  function handleSave(data: Omit<CustomProvider, "id">) {
    setSettings((prev) => {
      if (editingProvider) {
        const updated = prev.customProviders.map((provider) =>
          provider.id === editingProvider.id ? { ...provider, ...data } : provider,
        );
        return updateCustomProviders(prev, updated);
      }

      const newProvider: CustomProvider = {
        id: createUuid(),
        ...data,
      };
      return updateCustomProviders(prev, [...prev.customProviders, newProvider]);
    });
  }

  function handleDelete(id: string) {
    setSettings((prev) =>
      updateCustomProviders(
        prev,
        prev.customProviders.filter((provider) => provider.id !== id),
      ),
    );
  }

  function handleProviderReorder(type: ProviderId, nextIds: string[]) {
    setSettings((prev) => {
      const providersOfType = prev.customProviders.filter((provider) => provider.type === type);
      const reordered = itemsByIdOrder(providersOfType, nextIds);
      const included = new Set(reordered.map((provider) => provider.id));
      for (const provider of providersOfType) {
        if (!included.has(provider.id)) reordered.push(provider);
      }
      let index = 0;
      return updateCustomProviders(
        prev,
        prev.customProviders.map((provider) =>
          provider.type === type ? (reordered[index++] ?? provider) : provider,
        ),
      );
    });
  }

  const activeTabIndex = Math.max(0, PROVIDER_TABS.indexOf(activeTab));

  return (
    <>
      <div className="settings-provider-tabs-wrap mb-4 flex shrink-0 items-center justify-between gap-3">
        <div className="settings-provider-tabs inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
          {PROVIDER_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all ${
                activeTab === tab
                  ? "bg-background text-foreground shadow"
                  : "hover:text-foreground/80"
              }`}
            >
              <ProviderBrandIcon type={tab} />
              {getProviderLabel(tab)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <ProviderSettingsExtension
            activeTab={activeTab}
            settings={settings}
            setSettings={setSettings}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setCustomSettingsOpen(true)}
            title={t("settings.openCustomSettings")}
            aria-label={t("settings.openCustomSettings")}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-in-out"
          style={{ transform: `translateX(-${activeTabIndex * 100}%)` }}
        >
          {PROVIDER_TABS.map((tab) => (
            <div
              key={tab}
              className="w-full shrink-0 overflow-hidden"
              aria-hidden={activeTab !== tab}
              inert={activeTab !== tab}
            >
              <ProviderList
                type={tab}
                providers={settings.customProviders}
                onAdd={openAdd}
                onEdit={openEdit}
                onDelete={handleDelete}
                onReorder={handleProviderReorder}
                usageByProvider={usageByProvider}
                refreshingProviderIds={refreshingProviderIds}
                onRefreshUsage={(providerId) => void refreshProvider(providerId)}
              />
            </div>
          ))}
        </div>
      </div>

      {modalOpen ? (
        <ProviderModal
          providerType={activeTab}
          initialData={editingProvider ?? undefined}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
      {customSettingsOpen ? (
        <CustomSettingsDrawer
          settings={settings}
          setSettings={setSettings}
          providerType={activeTab}
          onClose={() => setCustomSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
