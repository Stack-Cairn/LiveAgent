import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ccswitchLogoUrl from "../../../src-tauri/icons/custom/ccswitch.png";
import cherryStudioLogoUrl from "../../../src-tauri/icons/custom/cherrystudio.png";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ClaudeIcon,
  Download,
  Eye,
  EyeOff,
  GeminiIcon,
  Globe,
  Key,
  List,
  Loader2,
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
} from "../../components/icons";

import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useVerticalListReorder } from "../../components/ui/useVerticalListReorder";
import { useLocale } from "../../i18n";
import { buildModelOptions } from "../../lib/chat/page/chatPageHelpers";
import {
  getCustomHeaderKeyPresets,
  isReservedCustomHeaderKey,
  isValidCustomHeaderKey,
} from "../../lib/providers/customHeaders";
import { parseModelValue, toModelValue } from "../../lib/providers/llm";
import { sortModelsByActiveStateAndVendor } from "../../lib/providers/modelVendor";
import {
  CODEX_REQUEST_FORMAT_LABELS,
  type CodexRequestFormat,
  type CustomProvider,
  type ProviderId,
  type ProviderModelConfig,
  updateCustomProviders,
  updateCustomSettings,
} from "../../lib/settings";
import { createUuid } from "../../lib/shared/id";
import { cn } from "../../lib/shared/utils";
import {
  type CherryProviderImportItem,
  type CherryProvidersResponse,
  CherryStudioImportModal,
} from "./CherryStudioImportModal";
import { ModelPicker } from "./modelPicker";
import {
  applyModelBulkActiveState,
  buildProviderModelsFetchKey,
  createDraftModelConfig,
  fetchModelsFromApi,
  formatTokenCount,
  getModelBulkActionCounts,
  isGatewayWebuiRuntime,
  mergeFetchedModels,
  normalizeFetchedModels,
} from "./providerUtils";
import { ConfirmDeletePopover } from "./shared";
import type { SettingsSectionProps } from "./types";

type ModalProps = {
  providerType: ProviderId;
  initialData?: CustomProvider;
  onSave: (data: Omit<CustomProvider, "id">) => void;
  onClose: () => void;
};

type ProviderDialogPanel = "general" | "request";

type ModelEditDraft = {
  model: ProviderModelConfig;
  contextWindow: string;
  maxOutputToken: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
};
type CcsProviderImportItem = {
  sourceId: string;
  appType: string;
  providerType: ProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
  requestFormat: CodexRequestFormat;
  models?: string[];
};

type CcsProvidersResponse = {
  status: string;
  message: string;
  providers: CcsProviderImportItem[];
};

const PROVIDER_TABS: ProviderId[] = ["claude_code", "codex", "gemini"];
const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_code: "Anthropic",
  codex: "OpenAI",
  gemini: "Gemini",
};

function getProviderLabel(type: ProviderId) {
  return PROVIDER_LABELS[type];
}

function ProviderBrandIcon({ type }: { type: ProviderId }) {
  if (type === "claude_code") return <ClaudeIcon height="1em" />;
  if (type === "gemini") return <GeminiIcon height="1em" />;
  return <OpenaiChatgptIcon height="1em" className="fill-current dark:text-white" />;
}

const REDACTED_API_KEY_DISPLAY = "API Key";
const CHERRY_DATA_PATH_STORAGE_KEY = "liveagent.cherryStudioDataPath";

// A local rescan usually returns within a frame, which makes the refresh
// feedback flash for a single frame. Hold the loading state for one full
// spinner revolution so the rescan reads as motion instead of a flicker.
const THIRD_PARTY_SCAN_FEEDBACK_MS = 1000;

function withScanFeedback<T>(work: Promise<T>): Promise<T> {
  return Promise.all([
    work,
    new Promise<void>((resolve) => setTimeout(resolve, THIRD_PARTY_SCAN_FEEDBACK_MS)),
  ]).then(([result]) => result);
}

function readCherryDataPath() {
  try {
    return localStorage.getItem(CHERRY_DATA_PATH_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parsePositiveInteger(input: string): number | null {
  const value = Number(input.trim());
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

// 单价输入：留空视为未配置（0），负数与非数字视为非法。
function parseCostRate(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function formatCostRate(value: number | undefined): string {
  return typeof value === "number" && value > 0 ? String(value) : "";
}

type CustomHeaderKeyIssue = "reserved" | "invalid";

function getCustomHeaderKeyIssue(key: string, includeEmpty = false): CustomHeaderKeyIssue | null {
  if (!key && !includeEmpty) return null;
  if (isReservedCustomHeaderKey(key)) return "reserved";
  return isValidCustomHeaderKey(key) ? null : "invalid";
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

function orderModels(
  models: readonly ProviderModelConfig[],
  order: readonly string[] | undefined,
  activeModelIds: ReadonlySet<string>,
) {
  if (!order) return sortModelsByActiveStateAndVendor(models, activeModelIds);
  const ordered = itemsByIdOrder(models, order);
  const included = new Set(ordered.map((model) => model.id));
  return [
    ...ordered,
    ...sortModelsByActiveStateAndVendor(
      models.filter((model) => !included.has(model.id)),
      activeModelIds,
    ),
  ];
}

function ProviderModal({ providerType, initialData, onSave, onClose }: ModalProps) {
  const { t } = useLocale();
  const isGatewayWebui = isGatewayWebuiRuntime();
  const initialApiKey = initialData?.apiKey ?? "";
  const initialUsesRedactedApiKey =
    isGatewayWebui && initialApiKey.trim() === "" && initialData?.apiKeyConfigured === true;
  const [name, setName] = useState(initialData?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initialData?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(
    initialUsesRedactedApiKey ? REDACTED_API_KEY_DISPLAY : initialApiKey,
  );
  const [customHeaders, setCustomHeaders] = useState(() =>
    (initialData?.customHeaders ?? []).map((header) => ({ ...header })),
  );
  const [models, setModels] = useState<ProviderModelConfig[]>(() =>
    normalizeFetchedModels(initialData?.models ?? [], providerType),
  );
  const [modelOrder, setModelOrder] = useState<string[] | undefined>(() =>
    initialData?.modelOrder ? [...initialData.modelOrder] : undefined,
  );
  const [activeModels, setActiveModels] = useState<Set<string>>(
    new Set(initialData?.activeModels ?? []),
  );
  const [requestFormat, setRequestFormat] = useState<CodexRequestFormat>(
    initialData?.requestFormat ?? "openai-responses",
  );
  const [useSystemProxy, setUseSystemProxy] = useState(initialData?.useSystemProxy ?? false);
  const [promptCachingEnabled, setPromptCachingEnabled] = useState(
    initialData?.promptCachingEnabled ?? providerType !== "gemini",
  );
  const [promptCacheRetention, setPromptCacheRetention] = useState<"short" | "long">(
    initialData?.promptCacheRetention === "long" ? "long" : "short",
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
  const [activePanel, setActivePanel] = useState<ProviderDialogPanel>("general");
  const [visibleHeaderValues, setVisibleHeaderValues] = useState<Set<number>>(new Set());
  const [headerValidationSubmitted, setHeaderValidationSubmitted] = useState(false);
  const [headerSuggest, setHeaderSuggest] = useState<{
    index: number;
    rect: { left: number; top: number; width: number };
  } | null>(null);
  const [headerSuggestActive, setHeaderSuggestActive] = useState(0);
  const [showApiKey, setShowApiKey] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFetchKey = useRef("");
  const headerKeyRefs = useRef<Array<HTMLInputElement | null>>([]);
  const headerValueRefs = useRef<Array<HTMLInputElement | null>>([]);
  const apiKeyIsRedactedDisplay = initialUsesRedactedApiKey && apiKey === REDACTED_API_KEY_DISPLAY;
  const apiKeyForRequest = apiKeyIsRedactedDisplay ? "" : apiKey.trim();
  const canFetchModels = baseUrl.trim().length > 0 && apiKeyForRequest.length > 0;

  const doFetch = useCallback(
    async (url: string, key: string) => {
      setFetchingModels(true);
      setFetchError(null);
      try {
        const list = await fetchModelsFromApi(providerType, url, key, { useSystemProxy });
        setModels((prev) => mergeFetchedModels(list, prev));
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      } finally {
        setFetchingModels(false);
      }
    },
    [providerType, useSystemProxy],
  );

  useEffect(() => {
    const trimUrl = baseUrl.trim();
    const trimKey = apiKeyForRequest;
    const key = buildProviderModelsFetchKey(trimUrl, trimKey, useSystemProxy);
    if (!trimUrl || !trimKey) return;
    if (key === prevFetchKey.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      prevFetchKey.current = key;
      void doFetch(trimUrl, trimKey);
    }, 900);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [apiKeyForRequest, baseUrl, doFetch, useSystemProxy]);

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
    if (!models.some((item) => item.id === model)) {
      setModels((prev) => [...prev, createDraftModelConfig(providerType, model)]);
    }
    setActiveModels((prev) => new Set([...prev, model]));
    setNewModelName("");
    setAddingModel(false);
  }

  function removeModel(model: string) {
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
            costInput: formatCostRate(target.cost?.input),
            costOutput: formatCostRate(target.cost?.output),
            costCacheRead: formatCostRate(target.cost?.cacheRead),
            costCacheWrite: formatCostRate(target.cost?.cacheWrite),
          },
    );
  }

  const editingModelContextWindow = editingModel
    ? parsePositiveInteger(editingModel.contextWindow)
    : null;
  const editingModelMaxOutputToken = editingModel
    ? parsePositiveInteger(editingModel.maxOutputToken)
    : null;
  const editingModelCost = editingModel
    ? {
        input: parseCostRate(editingModel.costInput),
        output: parseCostRate(editingModel.costOutput),
        cacheRead: parseCostRate(editingModel.costCacheRead),
        cacheWrite: parseCostRate(editingModel.costCacheWrite),
      }
    : null;
  const editingModelCostValid =
    editingModelCost === null ||
    (editingModelCost.input !== null &&
      editingModelCost.output !== null &&
      editingModelCost.cacheRead !== null &&
      editingModelCost.cacheWrite !== null);
  const canSaveEditingModel =
    editingModelContextWindow !== null &&
    editingModelMaxOutputToken !== null &&
    editingModelCostValid;

  function saveInlineModelSettings() {
    if (
      !editingModel ||
      editingModelContextWindow === null ||
      editingModelMaxOutputToken === null ||
      !editingModelCostValid
    ) {
      return;
    }
    const cost = editingModelCost
      ? {
          input: editingModelCost.input ?? 0,
          output: editingModelCost.output ?? 0,
          cacheRead: editingModelCost.cacheRead ?? 0,
          cacheWrite: editingModelCost.cacheWrite ?? 0,
        }
      : undefined;
    const hasCost =
      cost !== undefined &&
      (cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0);
    const nextModel: ProviderModelConfig = {
      ...editingModel.model,
      contextWindow: editingModelContextWindow,
      maxOutputToken: editingModelMaxOutputToken,
      cost: hasCost ? cost : undefined,
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
    setVisibleHeaderValues((prev) => {
      const next = new Set<number>();
      for (const visibleIndex of prev) {
        if (visibleIndex < index) next.add(visibleIndex);
        if (visibleIndex > index) next.add(visibleIndex - 1);
      }
      return next;
    });
    setHeaderValidationSubmitted(false);
  }

  function toggleCustomHeaderValue(index: number) {
    setVisibleHeaderValues((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
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

  function handleSave() {
    if (!name.trim()) return;
    const invalidHeaderIndex = customHeaders.findIndex(
      (header) => getCustomHeaderKeyIssue(header.key, true) !== null,
    );
    if (invalidHeaderIndex >= 0) {
      setHeaderValidationSubmitted(true);
      exitModelBulkMode();
      setActivePanel("request");
      focusCustomHeader(invalidHeaderIndex, "key");
      return;
    }
    const nextApiKey = apiKeyIsRedactedDisplay ? "" : apiKey.trim();
    onSave({
      name: name.trim(),
      type: providerType,
      baseUrl: baseUrl.trim(),
      apiKey: nextApiKey,
      apiKeyConfigured:
        nextApiKey.length > 0 ||
        apiKeyIsRedactedDisplay ||
        (isGatewayWebui && initialData?.apiKeyConfigured === true),
      customHeaders,
      models,
      modelOrder,
      activeModels: Array.from(activeModels),
      requestFormat: providerType === "codex" ? requestFormat : undefined,
      reasoning:
        providerType === "gemini" && initialData?.reasoning === "xhigh"
          ? "high"
          : (initialData?.reasoning ?? "off"),
      promptCachingEnabled: providerType === "gemini" ? false : promptCachingEnabled,
      promptCacheRetention:
        providerType === "claude_code" && promptCachingEnabled && promptCacheRetention === "long"
          ? "long"
          : undefined,
      nativeWebSearchEnabled: initialData?.nativeWebSearchEnabled ?? true,
      useSystemProxy,
    });
  }

  const isEditing = Boolean(initialData);
  const typeLabel = getProviderLabel(providerType);
  const orderedModels = useMemo(
    () => orderModels(models, modelOrder, activeModels),
    [models, modelOrder, activeModels],
  );
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
    setModels((current) => {
      return itemsByIdOrder(current, nextIds);
    });
    setModelOrder(nextIds);
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
  const firstHeaderIssue =
    customHeaders
      .map((header) => getCustomHeaderKeyIssue(header.key, headerValidationSubmitted))
      .find((issue) => issue !== null) ?? null;
  const headerIssueMessage =
    firstHeaderIssue === "reserved"
      ? t("settings.customHeaderReservedTitle")
      : firstHeaderIssue === "invalid"
        ? t("settings.invalidCustomHeaderKey")
        : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 max-[720px]:p-0">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 flex h-[600px] max-h-[calc(100dvh-2rem)] w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl max-[720px]:h-[100dvh] max-[720px]:max-h-[100dvh] max-[720px]:max-w-none max-[720px]:rounded-none max-[720px]:border-0">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 max-[720px]:px-3.5 max-[720px]:py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center text-xl text-foreground">
              <ProviderBrandIcon type={providerType} />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="text-sm font-semibold">
                {isEditing ? t("settings.editProvider") : t("settings.addProvider")}
              </div>
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
          </nav>

          <div
            ref={modelScrollContainerRef}
            className="min-w-0 flex-1 overflow-y-auto px-6 py-5 max-[720px]:px-3.5 max-[720px]:pb-[calc(0.875rem+env(safe-area-inset-bottom))] max-[720px]:pt-3.5"
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
                    <Label htmlFor="modal-baseurl">Base URL</Label>
                    <Input
                      id="modal-baseurl"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.currentTarget.value)}
                    />
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
                        className="h-9 pl-9 pr-9 text-sm"
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
                    <div className="flex gap-2 border-b bg-muted/20 p-2.5 max-[720px]:flex-wrap">
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

                  <div className="divide-y">
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
                        return (
                          // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: The row becomes an accessible checkbox only while bulk mode is active.
                          <div
                            key={model.id}
                            {...getModelReorderProps(model.id)}
                            className={cn(
                              "group hover:bg-accent/30",
                              draggingModelId === model.id && "bg-accent shadow-lg",
                              modelBulkMode && "cursor-pointer",
                              modelBulkSelection.has(model.id) && "bg-primary/5",
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
                                </div>

                                <div className="mt-3 text-xs font-medium text-muted-foreground">
                                  {t("settings.modelCost")}
                                </div>
                                <div className="mt-1 text-[11px] text-muted-foreground/80">
                                  {t("settings.modelCostHint")}
                                </div>
                                <div className="mt-2 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                                  {(
                                    [
                                      ["costInput", "settings.modelCostInput"],
                                      ["costOutput", "settings.modelCostOutput"],
                                      ["costCacheRead", "settings.modelCostCacheRead"],
                                      ["costCacheWrite", "settings.modelCostCacheWrite"],
                                    ] as const
                                  ).map(([field, labelKey]) => (
                                    <div key={field} className="space-y-1.5">
                                      <Label>{t(labelKey)}</Label>
                                      <Input
                                        inputMode="decimal"
                                        placeholder="0"
                                        aria-invalid={
                                          parseCostRate(editingModel[field]) === null
                                            ? true
                                            : undefined
                                        }
                                        className={cn(
                                          parseCostRate(editingModel[field]) === null &&
                                            "ring-1 ring-inset ring-destructive focus-visible:ring-destructive",
                                        )}
                                        value={editingModel[field]}
                                        onChange={(event) => {
                                          const value = event.currentTarget.value;
                                          setEditingModel((prev) =>
                                            prev ? { ...prev, [field]: value } : prev,
                                          );
                                        }}
                                      />
                                    </div>
                                  ))}
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
            ) : (
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

                {providerType !== "gemini" ? (
                  <div
                    className={cn(
                      "mt-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                      promptCachingEnabled && "border-primary/35 bg-primary/[0.04]",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors",
                          promptCachingEnabled && "bg-primary/15 text-primary",
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
                      <DialogSwitch
                        checked={promptCachingEnabled}
                        onCheckedChange={setPromptCachingEnabled}
                        ariaLabel={t("settings.promptCaching")}
                      />
                    </div>
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

                <div className="mt-6 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-sm font-semibold">{t("settings.customHeaders")}</span>
                    {customHeaders.length > 0 ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                        {customHeaders.length}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 max-[720px]:h-10"
                    onClick={() => addCustomHeader()}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("settings.addCustomHeader")}
                  </Button>
                </div>

                {customHeaders.length === 0 ? (
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
                        const issue = getCustomHeaderKeyIssue(
                          header.key,
                          headerValidationSubmitted,
                        );
                        const issueTitle =
                          issue === "reserved"
                            ? t("settings.customHeaderReservedTitle")
                            : issue === "invalid"
                              ? t("settings.invalidCustomHeaderKey")
                              : undefined;
                        const valueVisible = visibleHeaderValues.has(index);
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
                                issue && "text-destructive",
                              )}
                              placeholder={t("settings.customHeaderKeyPlaceholder")}
                              aria-label={t("settings.customHeaderName")}
                              aria-invalid={issue ? true : undefined}
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
                                type={valueVisible ? "text" : "password"}
                                value={header.value}
                                className="h-10 w-full rounded-none border-0 bg-transparent pl-3 pr-[4.5rem] font-mono text-xs shadow-none focus-visible:ring-0"
                                placeholder={t("settings.customHeaderValue")}
                                aria-label={t("settings.customHeaderValue")}
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
                                  className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                                  onClick={() => toggleCustomHeaderValue(index)}
                                  title={
                                    valueVisible
                                      ? t("settings.hideCustomHeaderValue")
                                      : t("settings.showCustomHeaderValue")
                                  }
                                  aria-label={
                                    valueVisible
                                      ? t("settings.hideCustomHeaderValue")
                                      : t("settings.showCustomHeaderValue")
                                  }
                                >
                                  {valueVisible ? (
                                    <EyeOff className="h-3.5 w-3.5" />
                                  ) : (
                                    <Eye className="h-3.5 w-3.5" />
                                  )}
                                </Button>
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

                {headerIssueMessage ? (
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

        <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3.5 max-[720px]:px-3.5 max-[720px]:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-[720px]:pt-3">
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
      </div>
    </div>,
    document.body,
  );
}

function CustomSettingsDrawer(props: SettingsSectionProps & { onClose: () => void }) {
  const { settings, setSettings, onClose } = props;
  const { t } = useLocale();
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  function requestClose() {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      onClose();
    }, 220);
  }

  function handleTitleModelChange(value: string) {
    // "" comes from the picker's follow-current entry and parses to undefined.
    setSettings((prev) =>
      updateCustomSettings(prev, {
        conversationTitleModel: parseModelValue(value) ?? undefined,
      }),
    );
  }

  return createPortal(
    <div
      className={`${
        closing ? "skills-drawer-backdrop-closing" : "skills-drawer-backdrop"
      } fixed inset-0 z-50 flex justify-end bg-foreground/[0.06] backdrop-blur-md dark:bg-background/40`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-custom-settings-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <aside
        className={`${
          closing ? "skills-drawer-panel-closing" : "skills-drawer-panel"
        } relative flex h-full w-full flex-col overflow-hidden border-l border-white/50 bg-white/70 shadow-[-32px_0_80px_-28px_rgba(15,23,42,0.22)] backdrop-blur-[28px] backdrop-saturate-150 sm:max-w-[440px] dark:border-foreground/[0.08] dark:bg-background/60`}
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
            <div
              id="provider-custom-settings-title"
              className="text-[17px] font-semibold leading-tight tracking-tight text-foreground/95"
            >
              {t("settings.customSettings")}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground/90">
              {t("settings.conversationTitleModelHint")}
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
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
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function ccsImportIdentity(provider: Pick<CustomProvider, "type" | "name" | "baseUrl">) {
  const name = provider.name
    .replace(/[（(]ccswitch[）)]/i, "")
    .trim()
    .toLowerCase();
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  return `${provider.type}\n${name}\n${baseUrl}`;
}

function providerFromCcs(item: CcsProviderImportItem, existingIds: Set<string>): CustomProvider {
  const baseId =
    `ccswitch-${item.sourceId}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ccswitch-provider";
  let id = baseId;
  for (let index = 2; existingIds.has(id); index += 1) id = `${baseId}-${index}`;
  existingIds.add(id);

  const providerType = item.providerType;
  const models = (item.models ?? []).map((model) => createDraftModelConfig(providerType, model));
  return {
    id,
    name: `${item.name.replace(/[（(]ccswitch[）)]/i, "").trim()}（ccswitch）`,
    type: providerType,
    baseUrl: item.baseUrl,
    apiKey: item.apiKey,
    apiKeyConfigured: item.apiKey.trim().length > 0,
    models,
    activeModels: models.map((model) => model.id),
    requestFormat:
      providerType === "codex"
        ? item.requestFormat === "openai-completions"
          ? "openai-completions"
          : "openai-responses"
        : undefined,
    reasoning: "off",
    promptCachingEnabled: providerType !== "gemini",
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
  };
}

function ccsProviderCanSyncModels(item: CcsProviderImportItem) {
  return item.baseUrl.trim().length > 0 && item.apiKey.trim().length > 0;
}

function ccsProviderIsTransferable(item: CcsProviderImportItem) {
  return ccsProviderCanSyncModels(item) || (item.models?.length ?? 0) > 0;
}

function cherryProviderId(item: CherryProviderImportItem) {
  const baseId = `cherry-studio-${item.sourceId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return baseId || "cherry-studio-provider";
}

function cherryProviderName(item: CherryProviderImportItem, allItems: CherryProviderImportItem[]) {
  const duplicateCount = allItems.filter(
    (candidate) =>
      candidate.name.trim().toLowerCase() === item.name.trim().toLowerCase() &&
      candidate.providerType === item.providerType &&
      candidate.baseUrl.trim().replace(/\/+$/, "").toLowerCase() ===
        item.baseUrl.trim().replace(/\/+$/, "").toLowerCase(),
  ).length;
  if (duplicateCount <= 1) return `${item.name.trim()}（Cherry Studio）`;
  const sourceId = item.sourceId.split("::", 1)[0].slice(0, 8);
  return `${item.name.trim()}（Cherry Studio · ${sourceId}）`;
}

// Re-syncing an existing provider must not silently revert an API key the
// user already configured in LiveAgent; like `name`, the existing key wins.
function cherryEffectiveApiKey(item: CherryProviderImportItem, existing?: CustomProvider) {
  return existing?.apiKey?.trim() ? existing.apiKey : item.apiKey;
}

function providerFromCherry(
  item: CherryProviderImportItem,
  allItems: CherryProviderImportItem[],
  existing?: CustomProvider,
): CustomProvider {
  const providerType = item.providerType;
  const models = existing?.models ?? [];
  const apiKey = cherryEffectiveApiKey(item, existing);
  return {
    ...(existing ?? {}),
    id: cherryProviderId(item),
    name: existing?.name ?? cherryProviderName(item, allItems),
    type: providerType,
    baseUrl: item.baseUrl,
    apiKey,
    apiKeyConfigured: apiKey.trim().length > 0,
    models,
    activeModels: existing?.activeModels ?? [],
    requestFormat:
      providerType === "codex"
        ? item.requestFormat === "openai-completions"
          ? "openai-completions"
          : "openai-responses"
        : undefined,
    reasoning: existing?.reasoning ?? "off",
    promptCachingEnabled: existing?.promptCachingEnabled ?? providerType !== "gemini",
    nativeWebSearchEnabled: existing?.nativeWebSearchEnabled ?? true,
    useSystemProxy: existing?.useSystemProxy ?? false,
  };
}

function isLikelyCherryChatModel(modelId: string) {
  const lower = modelId.toLowerCase();
  return ![
    "embedding",
    "rerank",
    "whisper",
    "realtime",
    "audio-preview",
    "audio-realtime",
    "image",
    "video",
    "banana",
    "dall-e",
    "imagen",
    "sora-",
    "veo-",
    "tts-",
  ].some((needle) => lower.includes(needle));
}

// sourceId alone can collide across ccswitch app_type buckets that map to the
// same provider tab (e.g. "claude" and "claude-code"), so key rows on both.
function ccsItemKey(item: CcsProviderImportItem) {
  return `${item.appType}:${item.sourceId}`;
}

function CcsSourceLogo({ className }: { className?: string }) {
  return (
    <img
      src={ccswitchLogoUrl}
      alt=""
      draggable={false}
      className={cn("shrink-0 select-none rounded-lg object-contain", className)}
    />
  );
}

function CherrySourceLogo({ className }: { className?: string }) {
  return (
    <img
      src={cherryStudioLogoUrl}
      alt=""
      draggable={false}
      className={cn("shrink-0 select-none rounded-lg object-contain", className)}
    />
  );
}

function CcsImportModal(props: {
  initialType: ProviderId;
  items: CcsProviderImportItem[];
  existingProviders: CustomProvider[];
  onImport: (items: CcsProviderImportItem[]) => Promise<string>;
  onClose: () => void;
}) {
  const { initialType, items, existingProviders, onImport, onClose } = props;
  const { t } = useLocale();

  const existingIdentity = useMemo(
    () => new Set(existingProviders.map(ccsImportIdentity)),
    [existingProviders],
  );
  const rows = useMemo(
    () =>
      items.map((item) => {
        const exists = existingIdentity.has(
          ccsImportIdentity({ type: item.providerType, name: item.name, baseUrl: item.baseUrl }),
        );
        const transferable = ccsProviderIsTransferable(item);
        return {
          item,
          key: ccsItemKey(item),
          exists,
          transferable,
          selectable: transferable && !exists,
        };
      }),
    [items, existingIdentity],
  );
  // All provider types in one modal, the tab the user came from leading.
  const groups = useMemo(() => {
    const order = [initialType, ...PROVIDER_TABS.filter((tab) => tab !== initialType)];
    return order
      .map((type) => ({ type, rows: rows.filter((row) => row.item.providerType === type) }))
      .filter((group) => group.rows.length > 0);
  }, [rows, initialType]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<string | null>(null);
  // Import resolves as soon as the configs are written locally; this only
  // guards the brief await against double-submit.
  const [submitting, setSubmitting] = useState(false);
  const [activeType, setActiveType] = useState<ProviderId>(initialType);

  const selectableKeys = rows.filter((row) => row.selectable).map((row) => row.key);
  const selectedCount = selectableKeys.filter((key) => selected.has(key)).length;

  // The initial tab may have no discovered configs — fall back to the first
  // group that does.
  const activeGroup = groups.find((group) => group.type === activeType) ?? groups[0];
  const activeRows = activeGroup?.rows ?? [];
  const activeSelectableKeys = activeRows.filter((row) => row.selectable).map((row) => row.key);
  const activeSelectedCount = activeSelectableKeys.filter((key) => selected.has(key)).length;
  const activeAllSelected =
    activeSelectableKeys.length > 0 && activeSelectedCount === activeSelectableKeys.length;

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllActive() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of activeSelectableKeys) {
        if (activeAllSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  async function handleImport() {
    const chosen = rows
      .filter((row) => row.selectable && selected.has(row.key))
      .map((row) => row.item);
    if (!chosen.length || submitting) return;
    setResult(null);
    setSubmitting(true);
    try {
      const summary = await onImport(chosen);
      setResult(summary);
      setSelected(new Set());
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={submitting ? undefined : onClose}
      />

      <div className="relative z-10 flex h-[min(35rem,85vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b px-6 py-4">
          <CcsSourceLogo className="h-9 w-9" />
          <div className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
            <div className="text-sm font-semibold">从 CC Switch 导入</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              左侧选择供应商类型，右侧勾选要导入的配置，导入后自动获取并激活模型
            </div>
          </div>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={onClose}
            disabled={submitting}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 max-[720px]:flex-col">
          {groups.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-muted-foreground">
              未发现可导入的供应商
            </div>
          ) : (
            <>
              <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r bg-muted/30 p-2">
                {groups.map((group) => {
                  const groupSelectable = group.rows.filter((row) => row.selectable);
                  const groupSelected = groupSelectable.filter((row) =>
                    selected.has(row.key),
                  ).length;
                  const active = group.type === activeGroup?.type;
                  return (
                    <button
                      key={group.type}
                      type="button"
                      onClick={() => setActiveType(group.type)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                        active
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <span className="flex w-5 shrink-0 items-center justify-center text-base">
                        <ProviderBrandIcon type={group.type} />
                      </span>
                      <span className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
                        <span className="block truncate text-sm font-medium">
                          {getProviderLabel(group.type)}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {group.rows.length} 项配置
                        </span>
                      </span>
                      {groupSelected > 0 ? (
                        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          {groupSelected}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-5 py-2">
                  <div className="text-xs text-muted-foreground">
                    已选 {activeSelectedCount} / {activeSelectableKeys.length} 个可导入
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={toggleAllActive}
                    disabled={!activeSelectableKeys.length || submitting}
                  >
                    {activeAllSelected ? t("settings.deselectAll") : t("settings.selectAll")}
                  </Button>
                </div>

                <div className="min-h-0 flex-1 divide-y overflow-y-auto">
                  {activeRows.map(({ item, key, exists, transferable, selectable }) => {
                    return (
                      <label
                        key={key}
                        className={cn(
                          "flex items-center gap-3 px-5 py-3 transition-colors",
                          selectable ? "cursor-pointer hover:bg-accent/40" : "opacity-55",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-primary"
                          checked={selectable && selected.has(key)}
                          disabled={!selectable || submitting}
                          onChange={() => toggleRow(key)}
                        />
                        <div className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{item.name}</span>
                            {exists ? (
                              <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                已导入
                              </span>
                            ) : !transferable ? (
                              <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                无 API 配置
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {item.baseUrl || "未配置 Base URL"}
                          </div>
                        </div>
                        {item.apiKey.trim() ? (
                          <span className="shrink-0 text-muted-foreground" title="已包含 API Key">
                            <Key className="h-3 w-3" />
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {result ? (
          <div className="border-t px-6 py-3">
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{result}</span>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
          <div className="text-xs text-muted-foreground">
            共已选 {selectedCount} / {selectableKeys.length} 个可导入
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={submitting}
              className="max-[720px]:h-10 max-[720px]:flex-1"
            >
              {result ? "关闭" : t("settings.cancel")}
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => void handleImport()}
              disabled={submitting || selectedCount === 0}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在导入…
                </>
              ) : (
                `导入 ${selectedCount} 个供应商`
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ProviderList(props: {
  type: ProviderId;
  isActive: boolean;
  providers: CustomProvider[];
  onAdd: () => void;
  onEdit: (provider: CustomProvider) => void;
  onDelete: (id: string) => void;
  onReorder: (type: ProviderId, nextIds: string[]) => void;
  ccsProviders: CcsProvidersResponse | null;
  ccsLoading: boolean;
  ccsMessage: string | null;
  cherryProviders: CherryProvidersResponse | null;
  cherryLoading: boolean;
  cherryImporting: boolean;
  cherryMessage: string | null;
  onEnsureThirdPartyScan: () => void;
  onRefreshThirdPartyProviders: () => void;
  onOpenCcsImport: () => void;
  onOpenCherryImport: () => void;
}) {
  const { t } = useLocale();
  const {
    type,
    isActive,
    providers,
    onAdd,
    onEdit,
    onDelete,
    onReorder,
    ccsProviders,
    ccsLoading,
    ccsMessage,
    cherryProviders,
    cherryLoading,
    cherryImporting,
    cherryMessage,
    onEnsureThirdPartyScan,
    onRefreshThirdPartyProviders,
    onOpenCcsImport,
    onOpenCherryImport,
  } = props;
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const filtered = providers.filter((provider) => provider.type === type);
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
  const ccsAll = ccsProviders?.providers ?? [];
  const cherryAll = cherryProviders?.providers ?? [];
  const ccsBreakdown = PROVIDER_TABS.map((tab) => ({
    type: tab,
    count: ccsAll.filter((provider) => provider.providerType === tab).length,
  })).filter((entry) => entry.count > 0);

  // The menu popup is portaled, so it would outlive its trigger when the tab
  // pane is slid away and marked inert — close it as the pane deactivates.
  useEffect(() => {
    if (!isActive) setSyncMenuOpen(false);
  }, [isActive]);

  function handleSyncMenuOpenChange(open: boolean) {
    setSyncMenuOpen(open);
    if (open) onEnsureThirdPartyScan();
  }

  const scanned = ccsProviders !== null;
  const ccsSubtitle = ccsLoading
    ? "正在扫描本地配置…"
    : ccsAll.length
      ? `发现 ${ccsBreakdown
          .map((entry) => `${getProviderLabel(entry.type)} ${entry.count}`)
          .join(" · ")}`
      : scanned
        ? ccsMessage || "未发现可导入的供应商"
        : "点击扫描本地配置";
  // The import modal shows every provider type, so the badge and fallback
  // subtitle must count across all of them — not just the current tab.
  const cherryReady = cherryAll.filter((provider) => provider.importable).length;
  const cherrySubtitle = cherryImporting
    ? "正在同步供应商、获取并激活模型…"
    : cherryLoading
      ? "正在扫描本地配置…"
      : cherryProviders
        ? cherryMessage || `发现 ${cherryReady} 个可同步配置`
        : cherryMessage || "点击扫描本地配置";
  const thirdPartyLoading = ccsLoading || cherryLoading;
  const thirdPartyImporting = cherryImporting;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {filtered.length === 0
            ? t("settings.noProviders")
            : `${filtered.length} ${t("settings.navProviders")}`}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addProvider")}
          </Button>
          <DropdownMenu open={syncMenuOpen} onOpenChange={handleSyncMenuOpenChange}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={thirdPartyImporting}
                />
              }
            >
              {thirdPartyImporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              从第三方同步
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ease-out",
                  syncMenuOpen && "rotate-180",
                )}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={8}
              collisionPadding={8}
              className="model-selector-dropdown w-80 overflow-hidden rounded-xl border-border/40 bg-popover/70 p-0 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.25)] ring-1 ring-white/10 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-popover/55"
            >
              <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                <DropdownMenuLabel className="p-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                  导入来源
                </DropdownMenuLabel>
                <DropdownMenuItem
                  closeOnClick={false}
                  className="h-7 w-7 cursor-pointer justify-center rounded-md p-0 text-muted-foreground"
                  disabled={thirdPartyLoading || thirdPartyImporting}
                  onSelect={onRefreshThirdPartyProviders}
                  aria-label="重新扫描本地配置"
                  title="重新扫描本地配置"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", thirdPartyLoading && "animate-spin")} />
                </DropdownMenuItem>
              </div>
              <DropdownMenuSeparator className="my-0 bg-border/40" />
              <div className="p-1.5">
                <DropdownMenuItem
                  className="model-selector-item cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2.5"
                  disabled={ccsLoading || !ccsAll.length}
                  onSelect={onOpenCcsImport}
                >
                  <CcsSourceLogo className="h-9 w-9" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      CC Switch
                      {ccsAll.length > 0 ? (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          {ccsAll.length}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="line-clamp-2 text-xs text-muted-foreground"
                      title={ccsSubtitle}
                    >
                      {ccsSubtitle}
                    </span>
                  </span>
                  {ccsLoading ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : null}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="model-selector-item cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2.5"
                  disabled={cherryLoading || cherryImporting || !cherryAll.length}
                  onSelect={onOpenCherryImport}
                >
                  <CherrySourceLogo className="h-9 w-9" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      Cherry Studio
                      {cherryReady > 0 ? (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          {cherryReady}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="line-clamp-2 text-xs text-muted-foreground"
                      title={cherrySubtitle}
                    >
                      {cherrySubtitle}
                    </span>
                  </span>
                  {cherryLoading || cherryImporting ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : null}
                </DropdownMenuItem>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
            {filtered.map((provider) => (
              <div
                key={provider.id}
                {...getProviderReorderProps(provider.id)}
                className={cn(
                  "group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent/30",
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
                </div>
                <div className="settings-hover-actions flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProvidersSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const [activeTab, setActiveTab] = useState<ProviderId>("claude_code");
  const [modalOpen, setModalOpen] = useState(false);
  const [customSettingsOpen, setCustomSettingsOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(null);
  const [ccsImportType, setCcsImportType] = useState<ProviderId | null>(null);
  const [cherryImportType, setCherryImportType] = useState<ProviderId | null>(null);
  const [ccsProviders, setCcsProviders] = useState<CcsProvidersResponse | null>(null);
  const [ccsLoading, setCcsLoading] = useState(false);
  const [ccsMessage, setCcsMessage] = useState<string | null>(null);
  const [cherryProviders, setCherryProviders] = useState<CherryProvidersResponse | null>(null);
  const [cherryLoading, setCherryLoading] = useState(false);
  const [cherryImporting, setCherryImporting] = useState(false);
  const [cherryMessage, setCherryMessage] = useState<string | null>(null);
  const [cherryDataPath, setCherryDataPath] = useState<string | null>(readCherryDataPath);

  async function refreshThirdPartyProviders() {
    setCcsLoading(true);
    setCherryLoading(true);
    const [ccsResult, cherryResult] = await withScanFeedback(
      Promise.allSettled([
        invoke<CcsProvidersResponse>("settings_list_ccswitch_providers"),
        cherryDataPath
          ? invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers_from_path", {
              dataPath: cherryDataPath,
            })
          : invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers"),
      ]),
    );
    if (ccsResult.status === "fulfilled") {
      setCcsProviders(ccsResult.value);
      setCcsMessage(ccsResult.value.message);
    } else {
      setCcsProviders(null);
      setCcsMessage(
        ccsResult.reason instanceof Error ? ccsResult.reason.message : String(ccsResult.reason),
      );
    }
    if (cherryResult.status === "fulfilled") {
      setCherryProviders(cherryResult.value);
      setCherryMessage(cherryResult.value.message);
    } else {
      setCherryProviders(null);
      setCherryMessage(
        cherryResult.reason instanceof Error
          ? cherryResult.reason.message
          : String(cherryResult.reason),
      );
    }
    setCcsLoading(false);
    setCherryLoading(false);
  }

  async function chooseCherryDataDirectory() {
    const selected = await invoke<string | null>("system_pick_folder", {
      initial_workdir: cherryDataPath ?? cherryProviders?.dataPath ?? undefined,
    });
    if (!selected) return;

    setCherryLoading(true);
    setCherryMessage("正在扫描选择的 Cherry Studio 数据目录…");
    try {
      const response = await withScanFeedback(
        invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers_from_path", {
          dataPath: selected,
        }),
      );
      const resolvedPath = response.dataPath || selected;
      localStorage.setItem(CHERRY_DATA_PATH_STORAGE_KEY, resolvedPath);
      setCherryDataPath(resolvedPath);
      setCherryProviders(response);
      setCherryMessage(response.message);
    } catch (error) {
      setCherryMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCherryLoading(false);
    }
  }

  function resetCherryDataDirectory() {
    localStorage.removeItem(CHERRY_DATA_PATH_STORAGE_KEY);
    setCherryDataPath(null);
    // Keep the stale provider list while rescanning: the import modal renders
    // only while cherryProviders is set, so nulling it here would unmount an
    // open modal mid-interaction.
    setCherryMessage("已恢复自动检测，正在重新扫描…");
    setCherryLoading(true);
    void withScanFeedback(invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers"))
      .then((response) => {
        setCherryProviders(response);
        setCherryMessage(response.message);
      })
      .catch((error) => {
        setCherryMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setCherryLoading(false));
  }

  function ensureThirdPartyScan() {
    if ((!ccsProviders || !cherryProviders) && !ccsLoading && !cherryLoading) {
      void refreshThirdPartyProviders();
    }
  }

  function buildCcsImportedProviders(
    existingProviders: CustomProvider[],
    items: CcsProviderImportItem[],
  ) {
    const existingIds = new Set(existingProviders.map((provider) => provider.id));
    const existingIdentity = new Set(existingProviders.map(ccsImportIdentity));
    const imported: CustomProvider[] = [];

    for (const item of items) {
      if (!ccsProviderIsTransferable(item)) continue;
      const identity = ccsImportIdentity({
        type: item.providerType,
        name: item.name,
        baseUrl: item.baseUrl,
      });
      if (existingIdentity.has(identity)) continue;
      existingIdentity.add(identity);
      imported.push(providerFromCcs(item, existingIds));
    }

    return imported;
  }

  // 后台补拉模型列表：失败只体现在 ccsMessage 里，导入的配置不受影响。
  // 恒带 useSystemProxy —— 反代按应用代理配置出网（未启用=直连）。
  async function syncCcsModelsInBackground(
    transferable: CcsProviderImportItem[],
    importedSummary: string,
  ) {
    const syncable = transferable.filter(ccsProviderCanSyncModels);
    const modelResults = await Promise.all(
      syncable.map(async (item) => {
        const identity = ccsImportIdentity({
          type: item.providerType,
          name: item.name,
          baseUrl: item.baseUrl,
        });
        try {
          const models = await fetchModelsFromApi(item.providerType, item.baseUrl, item.apiKey, {
            useSystemProxy: true,
          });
          return { identity, models, fetched: true };
        } catch {
          return { identity, models: [] as ProviderModelConfig[], fetched: false };
        }
      }),
    );

    const resultsByIdentity = new Map(
      modelResults.map((result) => [result.identity, result] as const),
    );
    setSettings((prev) => {
      let changed = false;
      const providers = prev.customProviders.map((provider) => {
        const result = resultsByIdentity.get(ccsImportIdentity(provider));
        if (!result?.fetched) return provider;
        const models = mergeFetchedModels(result.models, provider.models);
        const activeModels = models.map((model) => model.id);
        if (
          models === provider.models &&
          activeModels.length === provider.activeModels.length &&
          activeModels.every((model, index) => model === provider.activeModels[index])
        ) {
          return provider;
        }
        changed = true;
        return { ...provider, models, activeModels };
      });
      return changed ? updateCustomProviders(prev, providers) : prev;
    });

    const fetchedCount = modelResults.filter((result) => result.fetched).length;
    const failedCount = modelResults.length - fetchedCount;
    const totalModels = modelResults.reduce((total, result) => total + result.models.length, 0);
    const details = [
      importedSummary,
      fetchedCount > 0 ? `已在后台获取并激活 ${totalModels} 个模型` : "",
      failedCount > 0 ? `${failedCount} 个供应商模型获取失败（导入的配置不受影响）` : "",
    ].filter(Boolean);
    setCcsMessage(details.join("，"));
  }

  async function importCcsProviders(items: CcsProviderImportItem[]): Promise<string> {
    const transferable = items.filter(ccsProviderIsTransferable);
    if (!transferable.length) {
      const message = "所选供应商没有可导入的 API 配置";
      setCcsMessage(message);
      return message;
    }

    setSettings((prev) => {
      const nextImported = buildCcsImportedProviders(prev.customProviders, transferable);
      if (!nextImported.length) return prev;
      return updateCustomProviders(prev, [...prev.customProviders, ...nextImported]);
    });

    const importedByType = PROVIDER_TABS.map((tab) => ({
      type: tab,
      count: transferable.filter((item) => item.providerType === tab).length,
    })).filter((entry) => entry.count > 0);
    const importedSummary = `已导入 ${importedByType
      .map((entry) => `${entry.count} 个 ${getProviderLabel(entry.type)}`)
      .join("、")} 供应商`;
    const summary = transferable.some(ccsProviderCanSyncModels)
      ? `${importedSummary}，正在后台获取模型列表…`
      : `${importedSummary}，已激活供应商内的全部模型`;
    setCcsMessage(summary);
    void syncCcsModelsInBackground(transferable, importedSummary);
    return summary;
  }

  async function importCherryProviders(items: CherryProviderImportItem[]) {
    const importable = items.filter((item) => item.importable);
    if (!importable.length) {
      const message = "所选 Cherry Studio 配置没有可导入的 API 配置";
      setCherryMessage(message);
      return;
    }

    setCherryImporting(true);
    setCherryMessage("正在同步供应商、获取并激活全部模型…");

    const allItems = cherryProviders?.providers ?? importable;
    const existingById = new Map(
      settings.customProviders.map((provider) => [provider.id, provider] as const),
    );

    try {
      setSettings((prev) => {
        let changed = false;
        const providers = [...prev.customProviders];

        for (const item of importable) {
          const id = cherryProviderId(item);
          const existingIndex = providers.findIndex((provider) => provider.id === id);
          const nextProvider = providerFromCherry(
            item,
            allItems,
            existingIndex >= 0 ? providers[existingIndex] : undefined,
          );

          if (existingIndex >= 0) providers[existingIndex] = nextProvider;
          else providers.push(nextProvider);
          changed = true;
        }

        return changed ? updateCustomProviders(prev, providers) : prev;
      });

      const modelResults = await Promise.all(
        importable.map(async (item) => {
          const identity = cherryProviderId(item);
          try {
            const fetchedModels = await fetchModelsFromApi(
              item.providerType,
              item.baseUrl,
              cherryEffectiveApiKey(item, existingById.get(identity)),
            );
            const models = fetchedModels.filter((model) => isLikelyCherryChatModel(model.id));
            return { identity, models, fetched: true, failed: false };
          } catch {
            return {
              identity,
              models: [] as ProviderModelConfig[],
              fetched: false,
              failed: true,
            };
          }
        }),
      );

      // Two selected items can normalize to the same provider id; merge their
      // results instead of letting the last one win.
      const resultsByIdentity = new Map<string, (typeof modelResults)[number]>();
      for (const result of modelResults) {
        const merged = resultsByIdentity.get(result.identity);
        if (!merged) {
          resultsByIdentity.set(result.identity, result);
          continue;
        }
        resultsByIdentity.set(result.identity, {
          identity: result.identity,
          models: mergeFetchedModels(result.models, merged.models),
          fetched: merged.fetched || result.fetched,
          failed: merged.failed || result.failed,
        });
      }
      setSettings((prev) => {
        let changed = false;
        const providers = prev.customProviders.map((provider) => {
          const result = resultsByIdentity.get(provider.id);
          if (!result?.fetched) return provider;

          const models = mergeFetchedModels(result.models, provider.models);
          const activeModels = models.map((model) => model.id);
          if (
            models.length === provider.models.length &&
            models.every((model, index) => model.id === provider.models[index]?.id) &&
            activeModels.length === provider.activeModels.length &&
            activeModels.every((model, index) => model === provider.activeModels[index])
          ) {
            return provider;
          }
          changed = true;
          return { ...provider, models, activeModels };
        });
        return changed ? updateCustomProviders(prev, providers) : prev;
      });

      const fetchedCount = modelResults.filter((result) => result.fetched).length;
      const failedCount = modelResults.filter((result) => result.failed).length;
      const refreshedModelCount = modelResults.reduce(
        (total, result) => total + result.models.length,
        0,
      );
      const importedByType = PROVIDER_TABS.map((type) => ({
        type,
        count: importable.filter((item) => item.providerType === type).length,
      })).filter((entry) => entry.count > 0);
      const details = [
        `已同步 ${importedByType
          .map((entry) => `${entry.count} 个 ${getProviderLabel(entry.type)}`)
          .join("、")} 供应商`,
        fetchedCount > 0 && refreshedModelCount > 0
          ? `LiveAgent 获取并激活 ${refreshedModelCount} 个模型`
          : "LiveAgent API 未返回可用模型",
        failedCount > 0 ? `${failedCount} 个供应商模型获取失败` : "",
      ].filter(Boolean);
      setCherryMessage(details.join("，"));
      setCherryImportType(null);
    } finally {
      setCherryImporting(false);
    }
  }

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
    closeModal();
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
      <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
        <div className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
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
                isActive={activeTab === tab}
                providers={settings.customProviders}
                onAdd={openAdd}
                onEdit={openEdit}
                onDelete={handleDelete}
                onReorder={handleProviderReorder}
                ccsProviders={ccsProviders}
                ccsLoading={ccsLoading}
                ccsMessage={ccsMessage}
                cherryProviders={cherryProviders}
                cherryLoading={cherryLoading}
                cherryImporting={cherryImporting}
                cherryMessage={cherryMessage}
                onEnsureThirdPartyScan={ensureThirdPartyScan}
                onRefreshThirdPartyProviders={() => void refreshThirdPartyProviders()}
                onOpenCcsImport={() => setCcsImportType(tab)}
                onOpenCherryImport={() => setCherryImportType(tab)}
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
      {ccsImportType ? (
        <CcsImportModal
          initialType={ccsImportType}
          items={ccsProviders?.providers ?? []}
          existingProviders={settings.customProviders}
          onImport={importCcsProviders}
          onClose={() => setCcsImportType(null)}
        />
      ) : null}
      {cherryImportType && cherryProviders ? (
        <CherryStudioImportModal
          initialType={cherryImportType}
          response={cherryProviders}
          importing={cherryImporting}
          scanning={cherryLoading}
          dataPath={cherryDataPath}
          isExisting={(item) =>
            settings.customProviders.some((provider) => provider.id === cherryProviderId(item))
          }
          onChooseDataDirectory={() => void chooseCherryDataDirectory()}
          onResetDataDirectory={resetCherryDataDirectory}
          onConfirm={(items) => void importCherryProviders(items)}
          onClose={() => setCherryImportType(null)}
        />
      ) : null}
      {customSettingsOpen ? (
        <CustomSettingsDrawer
          settings={settings}
          setSettings={setSettings}
          onClose={() => setCustomSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
