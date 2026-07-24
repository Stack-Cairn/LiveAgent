import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ClaudeIcon,
  Eye,
  EyeOff,
  GeminiIcon,
  Globe,
  GrokIcon,
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
} from "../../components/icons";

import { Button } from "../../components/ui/button";
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
import { buildModelOptions } from "../../lib/chat/chatPageHelpers";
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
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";
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
};
const PROVIDER_TABS: ProviderId[] = ["claude_code", "codex", "gemini", "xai"];
const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_code: "Anthropic",
  codex: "OpenAI",
  gemini: "Gemini",
  xai: "Grok",
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
    initialData?.promptCachingEnabled ?? (providerType !== "gemini" && providerType !== "xai"),
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
  const [showApiKey, setShowApiKey] = useState(false);
  const [activePanel, setActivePanel] = useState<ProviderDialogPanel>("general");
  const [visibleHeaderValues, setVisibleHeaderValues] = useState<Set<number>>(new Set());
  const [headerValidationSubmitted, setHeaderValidationSubmitted] = useState(false);
  const [headerSuggest, setHeaderSuggest] = useState<{
    index: number;
    rect: { left: number; top: number; width: number };
  } | null>(null);
  const [headerSuggestActive, setHeaderSuggestActive] = useState(0);
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

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
        providerType === "gemini" || providerType === "xai" ? false : promptCachingEnabled,
      promptCacheRetention:
        providerType === "claude_code" && promptCachingEnabled && promptCacheRetention === "long"
          ? "long"
          : undefined,
      nativeWebSearchEnabled: initialData?.nativeWebSearchEnabled ?? true,
      useSystemProxy,
    });
    requestClose();
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
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4 max-[720px]:p-0"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div className="settings-modal-panel relative z-10 flex h-[600px] max-h-[calc(100dvh-2rem)] w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl max-[720px]:h-[100dvh] max-[720px]:max-h-[100dvh] max-[720px]:max-w-none max-[720px]:rounded-none max-[720px]:border-0">
        <div className="settings-modal-header flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 max-[720px]:px-3.5 max-[720px]:py-3">
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
            onClick={requestClose}
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
            className="settings-modal-body min-w-0 flex-1 overflow-y-auto px-6 py-5 max-[720px]:px-3.5 max-[720px]:pb-[calc(0.875rem+env(safe-area-inset-bottom))] max-[720px]:pt-3.5"
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
                              "settings-model-row group hover:bg-accent/30",
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

                {providerType !== "gemini" && providerType !== "xai" ? (
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

        <div className="settings-modal-footer flex shrink-0 items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3.5 max-[720px]:px-3.5 max-[720px]:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-[720px]:pt-3">
          <Button
            variant="outline"
            onClick={requestClose}
            className="max-[720px]:h-10 max-[720px]:flex-1"
          >
            {t("settings.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || isClosing}
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

function ProviderList(props: {
  type: ProviderId;
  providers: CustomProvider[];
  onAdd: () => void;
  onEdit: (provider: CustomProvider) => void;
  onDelete: (id: string) => void;
  onReorder: (type: ProviderId, nextIds: string[]) => void;
}) {
  const { t } = useLocale();
  const { type, providers, onAdd, onEdit, onDelete, onReorder } = props;
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
            {filtered.map((provider) => (
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
                </div>
                <div className="settings-card-actions settings-hover-actions flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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
                providers={settings.customProviders}
                onAdd={openAdd}
                onEdit={openEdit}
                onDelete={handleDelete}
                onReorder={handleProviderReorder}
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
          onClose={() => setCustomSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
