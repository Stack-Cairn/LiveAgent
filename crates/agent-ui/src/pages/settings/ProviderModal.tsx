import { testProviderUsage, type UsageData } from "@liveagent/app/lib/providers/usageQuery";
import {
  type CodexRequestFormat,
  type CustomProvider,
  getDefaultUsageQueryConfig,
  normalizeProviderModelConfigs,
  PROVIDER_RETRY_DEFAULT_MAX_RETRIES,
  PROVIDER_RETRY_MAX_RETRIES_LIMITS,
  type PromptCacheHintMode,
  type ProviderId,
  type ProviderModelConfig,
  type ProviderRetryPolicy,
} from "@liveagent/app/lib/settings";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useVerticalListReorder } from "@liveagent/ui/components/ui/useVerticalListReorder";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  CustomHeaderImportError,
  type CustomHeaderImportErrorCode,
  type CustomHeaderImportIssue,
  getCustomHeaderKeyPresets,
  mergeImportedCustomHeaders,
  parseCustomHeadersImport,
} from "@liveagent/ui/lib/providers/customHeaders";
import {
  applyModelOrderSnapshot,
  createModelOrderSnapshot,
  findNewModelIds,
} from "@liveagent/ui/lib/providers/modelVendor";
import {
  applyModelBulkActiveState,
  applyModelInputModalitiesMode,
  applyUsageQueryModePreset,
  buildProviderModelsFetchKey,
  clampUsageQueryTimeoutSecs,
  createDraftModelConfig,
  createUsageQueryDraft,
  detectCodingPlanProvider,
  fetchModelsFromApi,
  getModelBulkActionCounts,
  getModelInputModalitiesMode,
  getPersistedUsageQueryProviderId,
  isGatewayWebuiRuntime,
  type ModelInputModalitiesMode,
  matchBalanceProviders,
  mergeFetchedModels,
  providerSupportsModelInputModalitiesOverride,
  requiresCustomUsageQueryConfirmation,
  serializeUsageQueryDraft,
} from "@liveagent/ui/pages/settings/providerUtils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProviderModalView } from "./ProviderModalView";
import {
  customHeaderIssueMessage,
  getCustomHeaderIssue,
  getProviderLabel,
  itemsByIdOrder,
} from "./ProviderPresentation";

type ModalProps = {
  providerType: ProviderId;
  initialData?: CustomProvider;
  onSave: (data: Omit<CustomProvider, "id">) => void;
  onClose: () => void;
};

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

const REDACTED_API_KEY_DISPLAY = "API Key";

function parsePositiveInteger(input: string): number | null {
  const value = Number(input.trim());
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
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

function useProviderModalController({ providerType, initialData, onSave, onClose }: ModalProps) {
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
    // 弹窗初始化处理的是已持久化的模型配置，必须走持久化归一化（保留
    // contextWindow/maxOutputToken/limitsSource/inputModalities 等用户字段）；
    // normalizeFetchedModels 只用于供应商 API 刷新结果（如 Gemini 的
    // inputTokenLimit 字段形状），混用会在“打开并保存”往返中重置用户配置。
    normalizeProviderModelConfigs(initialData?.models ?? [], providerType),
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
  const [streamRetryMode, setStreamRetryMode] = useState<"default" | "off" | "custom">(
    initialData?.retryPolicy?.mode ?? "default",
  );
  // 数字输入用本地草稿字符串，blur 时 clamp（与 usageTimeoutInput 同范式）。
  const [streamRetryCountInput, setStreamRetryCountInput] = useState(() =>
    String(
      initialData?.retryPolicy?.mode === "custom"
        ? initialData.retryPolicy.maxRetries
        : PROVIDER_RETRY_DEFAULT_MAX_RETRIES,
    ),
  );
  const [promptCachingEnabled, setPromptCachingEnabled] = useState(
    initialData?.promptCachingEnabled ??
      (providerType !== "gemini" && providerType !== "xai" && providerType !== "deepseek"),
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
  const [dialogOpen, setDialogOpen] = useState(true);
  const requestClose = useCallback(() => setDialogOpen(false), []);

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
  const canReuseStoredApiKey =
    isGatewayWebui &&
    apiKeyIsRedactedDisplay &&
    Boolean(initialData?.id) &&
    initialData?.apiKeyConfigured === true &&
    baseUrl.trim() === (initialData.baseUrl ?? "").trim() &&
    modelsUrl.trim() === (providerType === "gemini" ? "" : (initialData.modelsUrl ?? "").trim()) &&
    useSystemProxy === (initialData.useSystemProxy ?? false);
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

  function clampStreamRetryCount(raw: number): number {
    if (!Number.isFinite(raw)) return PROVIDER_RETRY_DEFAULT_MAX_RETRIES;
    return Math.min(
      PROVIDER_RETRY_MAX_RETRIES_LIMITS.max,
      Math.max(PROVIDER_RETRY_MAX_RETRIES_LIMITS.min, Math.round(raw)),
    );
  }

  function commitStreamRetryCountInput() {
    setStreamRetryCountInput(String(clampStreamRetryCount(Number(streamRetryCountInput.trim()))));
  }

  /** default 态不落字段：与 normalizeProviderRetryPolicy 的持久层形态一致。 */
  function serializeStreamRetryPolicy(): ProviderRetryPolicy | undefined {
    if (streamRetryMode === "off") return { mode: "off" };
    if (streamRetryMode === "custom") {
      return {
        mode: "custom",
        maxRetries: clampStreamRetryCount(Number(streamRetryCountInput.trim())),
      };
    }
    return undefined;
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
          providerId: initialData?.id,
        });
        const mergedModels = mergeFetchedModels(list, modelsRef.current);
        commitModelsWithNewRowsRef.current(mergedModels);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      } finally {
        setFetchingModels(false);
      }
    },
    [initialData?.id, isFullUrl, modelsUrl, providerType, useSystemProxy],
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
    if ((!trimUrl && !modelsUrl.trim()) || (!trimKey && !canReuseStoredApiKey)) {
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
  const canOverrideModelInputModalities =
    providerSupportsModelInputModalitiesOverride(providerType);
  const editingModelInputModalitiesMode = editingModel
    ? getModelInputModalitiesMode(editingModel.model)
    : "auto";
  const canSaveEditingModel =
    editingModelContextWindow !== null && editingModelMaxOutputToken !== null;

  function setEditingModelInputModalitiesMode(mode: ModelInputModalitiesMode) {
    setEditingModel((prev) =>
      prev
        ? {
            ...prev,
            model: applyModelInputModalitiesMode(prev.model, mode),
          }
        : prev,
    );
  }

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
      limitsSource: "user",
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
          : providerType === "gemini" || providerType === "xai" || providerType === "deepseek"
            ? false
            : promptCachingEnabled,
      promptCacheHintMode: providerType === "codex" ? promptCacheHintMode : undefined,
      promptCacheRetention:
        providerType === "claude_code" && promptCachingEnabled && promptCacheRetention === "long"
          ? "long"
          : undefined,
      nativeWebSearchEnabled: initialData?.nativeWebSearchEnabled ?? true,
      useSystemProxy,
      retryPolicy: serializeStreamRetryPolicy(),
      usageQuery: serializeUsageQueryDraft(usageQuery, isGatewayWebui),
    });
    requestClose();
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
    ? t(`settings.customHeaderImportError.${headerImportError}`)
    : null;
  const headerImportSummaryMessage = headerImportSummary
    ? [
        `${t("settings.customHeaderImportSummary.imported")} ${headerImportSummary.importedCount}`,
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
                  t(`settings.customHeaderImportIssue.${issue.reason}`) +
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
  const viewModel = {
    activeCodingPlanProvider,
    activeModels,
    activePanel,
    addCustomHeader,
    addingModel,
    allVisibleModelsSelected,
    apiKey,
    apiKeyForRequest,
    apiKeyIsRedactedDisplay,
    applyHeaderSuggestion,
    applyModelBulkState,
    baseUrl,
    canSaveEditingModel,
    canOverrideModelInputModalities,
    cancelCustomHeaderImport,
    commitUsageTimeoutInput,
    customHeaders,
    draggingModelId,
    editingModel,
    editingModelContextWindow,
    editingModelInputModalitiesMode,
    editingModelMaxOutputToken,
    exitModelBulkMode,
    fetchError,
    fetchingModels,
    focusCustomHeader,
    getModelReorderProps,
    handleAddModel,
    handleImportCustomHeaders,
    handleRefresh,
    handleSave,
    handleTestUsageQuery,
    headerImportErrorMessage,
    headerImportOpen,
    headerImportSummaryMessage,
    headerImportText,
    headerIssueMessage,
    headerKeyRefs,
    headerSuggest,
    headerSuggestActiveIndex,
    headerSuggestItems,
    headerValidationSubmitted,
    headerValueRefs,
    dialogOpen,
    isEditing,
    isFullUrl,
    isGatewayWebui,
    matchedBalanceProviders,
    modelBulkDisableCount,
    modelBulkEnableCount,
    modelBulkMode,
    modelBulkSelection,
    modelListRef,
    modelScrollContainerRef,
    modelSearch,
    modelSearchQuery,
    models,
    modelsUrl,
    name,
    newModelName,
    newModelPhases,
    onClose,
    openHeaderSuggest,
    openModelSettings,
    persistedUsageQueryProviderId,
    promptCacheHintMode,
    promptCacheRetention,
    promptCachingEnabled,
    providerType,
    removeCustomHeader,
    removeModel,
    renderModelDragHandle,
    requestClose,
    requestFormat,
    saveInlineModelSettings,
    selectVisibleModels,
    setActivePanel,
    setAddingModel,
    setApiKey,
    setBaseUrl,
    setEditingModel,
    setEditingModelInputModalitiesMode,
    setHeaderImportError,
    setHeaderImportOpen,
    setHeaderImportSummary,
    setHeaderImportText,
    setHeaderSuggest,
    setHeaderSuggestActive,
    setIsFullUrl,
    setModelBulkSelection,
    setModelSearch,
    setModelsUrl,
    setName,
    setNewModelName,
    setPromptCacheHintMode,
    setPromptCacheRetention,
    setPromptCachingEnabled,
    setRequestFormat,
    setShowApiKey,
    setShowUsageVariableApiKey,
    setStreamRetryCountInput,
    setStreamRetryMode,
    setUsageQuery,
    setUsageTimeoutInput,
    setUseSystemProxy,
    showApiKey,
    showUsageVariableApiKey,
    streamRetryCountInput,
    streamRetryMode,
    commitStreamRetryCountInput,
    t,
    toggleModel,
    toggleModelBulkMode,
    toggleModelBulkSelection,
    typeLabel,
    updateCustomHeader,
    usageQuery,
    usageQueryConfirmDialog,
    usageQueryTest,
    usageTimeoutInput,
    usageVariableApiKey,
    usageVariableBaseUrl,
    useSystemProxy,
    visibleModels,
  };
  return viewModel;
}

export type ProviderModalViewModel = ReturnType<typeof useProviderModalController>;

export function ProviderModal(props: ModalProps) {
  return <ProviderModalView viewModel={useProviderModalController(props)} />;
}
