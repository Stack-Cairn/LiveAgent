import { Popover } from "@base-ui/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  ChevronDown,
  ClaudeIcon,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  GeminiIcon,
  Key,
  Loader2,
  MoreHorizontal,
  OpenaiChatgptIcon,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Settings2,
  Trash2,
  X,
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
import { useLocale } from "../../i18n";
import { buildModelOptions } from "../../lib/chat/page/chatPageHelpers";
import { parseModelValue, toModelValue } from "../../lib/providers/llm";
import {
  CODEX_REQUEST_FORMAT_LABELS,
  type CodexRequestFormat,
  type CustomProvider,
  type ProviderId,
  type ProviderModelConfig,
  updateCustomProviders,
  updateCustomSettings,
} from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import {
  type CherryProviderImportItem,
  type CherryProvidersResponse,
  CherryStudioImportModal,
} from "./CherryStudioImportModal";
import {
  createDraftModelConfig,
  fetchModelsFromApi,
  isGatewayWebuiRuntime,
  mergeFetchedModels,
  normalizeFetchedModels,
  sortModelsBySelection,
} from "./providerUtils";
import { ConfirmDeletePopover } from "./shared";
import type { SettingsSectionProps } from "./types";

type ModalProps = {
  providerType: ProviderId;
  initialData?: CustomProvider;
  onSave: (data: Omit<CustomProvider, "id">) => void;
  onClose: () => void;
};

type ModelSettingsModalProps = {
  model: ProviderModelConfig;
  onClose: () => void;
  onSave: (model: ProviderModelConfig) => void;
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
const TITLE_MODEL_FOLLOW_CURRENT_VALUE = "__conversation_title_follow_current__";
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

function readCherryDataPath() {
  try {
    return localStorage.getItem(CHERRY_DATA_PATH_STORAGE_KEY);
  } catch {
    return null;
  }
}

function normalizeModelDomId(modelId: string) {
  return modelId.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function parsePositiveInteger(input: string): number | null {
  const value = Number(input.trim());
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function ModelSettingsModal({ model, onClose, onSave }: ModelSettingsModalProps) {
  const { t } = useLocale();
  const [contextWindow, setContextWindow] = useState(String(model.contextWindow));
  const [maxOutputToken, setMaxOutputToken] = useState(String(model.maxOutputToken));

  const parsedContextWindow = parsePositiveInteger(contextWindow);
  const parsedMaxOutputToken = parsePositiveInteger(maxOutputToken);
  const canSave = parsedContextWindow !== null && parsedMaxOutputToken !== null;

  function handleSave() {
    if (!canSave) return;
    onSave({
      ...model,
      contextWindow: parsedContextWindow,
      maxOutputToken: parsedMaxOutputToken,
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-md rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div>
            <div className="text-sm font-semibold">{t("settings.modelSettings")}</div>
            <div className="mt-1 text-xs text-muted-foreground">{model.id}</div>
          </div>
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={onClose}>
            {t("settings.cancel")}
          </Button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="space-y-1.5">
            <Label>{t("settings.modelName")}</Label>
            <Input value={model.id} disabled />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="model-context-window">{t("settings.contextWindow")}</Label>
            <Input
              id="model-context-window"
              inputMode="numeric"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.currentTarget.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="model-max-output-token">{t("settings.maxOutputToken")}</Label>
            <Input
              id="model-max-output-token"
              inputMode="numeric"
              value={maxOutputToken}
              onChange={(e) => setMaxOutputToken(e.currentTarget.value)}
            />
          </div>

          {!canSave ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {t("settings.positiveIntegerRequired")}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {t("settings.save")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
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
  const [models, setModels] = useState<ProviderModelConfig[]>(() =>
    normalizeFetchedModels(initialData?.models ?? [], providerType),
  );
  const [activeModels, setActiveModels] = useState<Set<string>>(
    new Set(initialData?.activeModels ?? []),
  );
  const [requestFormat, setRequestFormat] = useState<CodexRequestFormat>(
    initialData?.requestFormat ?? "openai-responses",
  );
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [addingModel, setAddingModel] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [editingModel, setEditingModel] = useState<ProviderModelConfig | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFetchKey = useRef("");
  const apiKeyIsRedactedDisplay = initialUsesRedactedApiKey && apiKey === REDACTED_API_KEY_DISPLAY;
  const apiKeyForRequest = apiKeyIsRedactedDisplay ? "" : apiKey.trim();
  const canFetchModels = baseUrl.trim().length > 0 && apiKeyForRequest.length > 0;

  useEffect(() => {
    const trimUrl = baseUrl.trim();
    const trimKey = apiKeyForRequest;
    const key = `${trimUrl}||${trimKey}`;
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
  }, [baseUrl, apiKeyForRequest]);

  async function doFetch(url: string, key: string) {
    setFetchingModels(true);
    setFetchError(null);
    try {
      const list = await fetchModelsFromApi(providerType, url, key);
      setModels((prev) => mergeFetchedModels(list, prev));
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchingModels(false);
    }
  }

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

  function setVisibleModelsSelected(selected: boolean) {
    setActiveModels((prev) => {
      const visibleModels = new Set(models.map((model) => model.id));
      const next = new Set(Array.from(prev).filter((model) => !visibleModels.has(model)));
      if (selected) {
        for (const model of models) next.add(model.id);
      }
      return next;
    });
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
    setEditingModel((prev) => (prev?.id === model ? null : prev));
  }

  function openModelSettings(modelId: string) {
    const target = models.find((item) => item.id === modelId);
    if (!target) return;
    setEditingModel(target);
  }

  function saveModelSettings(nextModel: ProviderModelConfig) {
    setModels((prev) => prev.map((item) => (item.id === nextModel.id ? nextModel : item)));
    setEditingModel(null);
  }

  function handleSave() {
    if (!name.trim()) return;
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
      models,
      activeModels: Array.from(activeModels),
      requestFormat: providerType === "codex" ? requestFormat : undefined,
      reasoning:
        providerType === "gemini" && initialData?.reasoning === "xhigh"
          ? "high"
          : (initialData?.reasoning ?? "off"),
      promptCachingEnabled: initialData?.promptCachingEnabled ?? providerType === "claude_code",
      nativeWebSearchEnabled: initialData?.nativeWebSearchEnabled ?? true,
    });
  }

  const isEditing = Boolean(initialData);
  const typeLabel = getProviderLabel(providerType);
  const allVisibleModelsSelected =
    models.length > 0 && models.every((model) => activeModels.has(model.id));
  const orderedModels = useMemo(
    () => sortModelsBySelection(models, activeModels),
    [models, activeModels],
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center text-xl text-foreground">
            <ProviderBrandIcon type={providerType} />
          </div>
          <div>
            <div className="text-sm font-semibold">
              {isEditing ? t("settings.editProvider") : t("settings.addProvider")}
            </div>
            <div className="text-xs text-muted-foreground">
              {typeLabel} {t("settings.compatible")}
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="modal-name">{t("settings.providerName")}</Label>
            <Input id="modal-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="modal-baseurl">Base URL</Label>
            <Input
              id="modal-baseurl"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
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
                onChange={(e) => setApiKey(e.currentTarget.value)}
                onFocus={(e) => {
                  if (apiKeyIsRedactedDisplay) e.currentTarget.select();
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowApiKey((prev) => !prev)}
                title={showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
                aria-label={showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {providerType === "codex" ? (
            <div className="space-y-1.5">
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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("settings.models")}</Label>
              <div className="flex items-center gap-1">
                {fetchingModels ? (
                  <span className="mr-1 text-xs text-muted-foreground">
                    {t("settings.fetching")}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setVisibleModelsSelected(!allVisibleModelsSelected)}
                  disabled={models.length === 0}
                >
                  {allVisibleModelsSelected ? t("settings.deselectAll") : t("settings.selectAll")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleRefresh}
                  disabled={fetchingModels || (isGatewayWebui && !canFetchModels)}
                  title={t("settings.refreshModels")}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${fetchingModels ? "animate-spin" : ""}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setAddingModel(true)}
                  title={t("settings.addModel")}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {fetchError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {fetchError}
              </div>
            ) : null}

            {addingModel ? (
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={newModelName}
                  className="h-8 text-sm"
                  onChange={(e) => setNewModelName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddModel();
                    if (e.key === "Escape") setAddingModel(false);
                  }}
                />
                <Button size="sm" className="h-8" onClick={handleAddModel}>
                  {t("settings.add")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => setAddingModel(false)}
                >
                  {t("settings.cancel")}
                </Button>
              </div>
            ) : null}

            <div className="max-h-[220px] divide-y overflow-y-auto rounded-lg border">
              {orderedModels.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {baseUrl.trim() && apiKeyForRequest
                    ? t("settings.fetchFailed")
                    : t("settings.fetchHint")}
                </div>
              ) : (
                orderedModels.map((model) => {
                  const checkboxId = `model-${providerType}-${normalizeModelDomId(model.id)}`;
                  return (
                    <div
                      key={model.id}
                      className="group flex items-center gap-2 px-3 py-2 hover:bg-accent/30"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
                        checked={activeModels.has(model.id)}
                        onChange={() => toggleModel(model.id)}
                        id={checkboxId}
                      />
                      <label
                        htmlFor={checkboxId}
                        className="flex-1 cursor-pointer truncate text-sm"
                      >
                        {model.id}
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => openModelSettings(model.id)}
                        title={t("settings.modelSettings")}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </Button>
                      <button
                        type="button"
                        className="hidden h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover:flex"
                        onClick={() => removeModel(model.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!name.trim()}>
            {t("settings.save")}
          </Button>
        </div>

        {editingModel ? (
          <ModelSettingsModal
            model={editingModel}
            onClose={() => setEditingModel(null)}
            onSave={saveModelSettings}
          />
        ) : null}
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
    : TITLE_MODEL_FOLLOW_CURRENT_VALUE;
  const selectedOption = modelOptions.find((option) => option.value === selectedValue);
  const selectedLabel = conversationTitleModel
    ? selectedOption
      ? `${selectedOption.providerName} / ${selectedOption.label}`
      : conversationTitleModel.model
    : t("settings.conversationTitleModelFollowCurrent");

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
    setSettings((prev) =>
      updateCustomSettings(prev, {
        conversationTitleModel:
          value === TITLE_MODEL_FOLLOW_CURRENT_VALUE
            ? undefined
            : (parseModelValue(value) ?? undefined),
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
          <div className="min-w-0 flex-1">
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
                <Select value={selectedValue} onValueChange={handleTitleModelChange}>
                  <SelectTrigger className="h-9 rounded-lg border-foreground/10 bg-white/70 shadow-sm dark:bg-background/40">
                    <SelectValue>{selectedLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={TITLE_MODEL_FOLLOW_CURRENT_VALUE}>
                      {t("settings.conversationTitleModelFollowCurrent")}
                    </SelectItem>
                    {modelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.providerName} / {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
    promptCachingEnabled: providerType === "claude_code",
    nativeWebSearchEnabled: true,
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
    promptCachingEnabled: existing?.promptCachingEnabled ?? providerType === "claude_code",
    nativeWebSearchEnabled: existing?.nativeWebSearchEnabled ?? true,
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
    <span
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-500 font-bold text-white shadow-sm",
        className,
      )}
    >
      CC
    </span>
  );
}

function CherrySourceLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 font-bold text-white shadow-sm",
        className,
      )}
    >
      CS
    </span>
  );
}

function CcsImportModal(props: {
  initialType: ProviderId;
  items: CcsProviderImportItem[];
  existingProviders: CustomProvider[];
  importing: boolean;
  onImport: (items: CcsProviderImportItem[]) => Promise<string>;
  onClose: () => void;
}) {
  const { initialType, items, existingProviders, importing, onImport, onClose } = props;
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
    if (!chosen.length || importing) return;
    setResult(null);
    try {
      const summary = await onImport(chosen);
      setResult(summary);
      setSelected(new Set());
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={importing ? undefined : onClose}
      />

      <div className="relative z-10 flex h-[min(35rem,85vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b px-6 py-4">
          <CcsSourceLogo className="h-9 w-9 text-[12px]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">从 CC Switch 导入</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              左侧选择供应商类型，右侧勾选要导入的配置，导入后自动获取并激活模型
            </div>
          </div>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={onClose}
            disabled={importing}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
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
                      <span className="min-w-0 flex-1">
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
                    disabled={!activeSelectableKeys.length || importing}
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
                          disabled={!selectable || importing}
                          onChange={() => toggleRow(key)}
                        />
                        <div className="min-w-0 flex-1">
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
            <Button variant="outline" onClick={onClose} disabled={importing}>
              {result ? "关闭" : t("settings.cancel")}
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => void handleImport()}
              disabled={importing || selectedCount === 0}
            >
              {importing ? (
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
  ccsProviders: CcsProvidersResponse | null;
  ccsLoading: boolean;
  ccsImporting: boolean;
  ccsMessage: string | null;
  cherryProviders: CherryProvidersResponse | null;
  cherryLoading: boolean;
  cherryImporting: boolean;
  cherryMessage: string | null;
  cherryDataPath: string | null;
  onEnsureThirdPartyScan: () => void;
  onRefreshThirdPartyProviders: () => void;
  onOpenCcsImport: () => void;
  onOpenCherryImport: () => void;
  onChooseCherryDataDirectory: () => void;
  onResetCherryDataDirectory: () => void;
}) {
  const { t } = useLocale();
  const {
    type,
    isActive,
    providers,
    onAdd,
    onEdit,
    onDelete,
    ccsProviders,
    ccsLoading,
    ccsImporting,
    ccsMessage,
    cherryProviders,
    cherryLoading,
    cherryImporting,
    cherryMessage,
    cherryDataPath,
    onEnsureThirdPartyScan,
    onRefreshThirdPartyProviders,
    onOpenCcsImport,
    onOpenCherryImport,
    onChooseCherryDataDirectory,
    onResetCherryDataDirectory,
  } = props;
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const filtered = providers.filter((provider) => provider.type === type);
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
  const ccsSubtitle = ccsImporting
    ? "正在导入供应商、获取并激活模型…"
    : ccsLoading
      ? "正在扫描本地配置…"
      : ccsAll.length
        ? `发现 ${ccsBreakdown
            .map((entry) => `${getProviderLabel(entry.type)} ${entry.count}`)
            .join(" · ")}`
        : scanned
          ? ccsMessage || "未发现可导入的供应商"
          : "点击扫描本地配置";
  const cherryReady = cherryAll.filter(
    (provider) => provider.providerType === type && provider.importable,
  ).length;
  const cherrySubtitle = cherryImporting
    ? "正在同步供应商、获取并激活模型…"
    : cherryLoading
      ? "正在扫描本地配置…"
      : cherryProviders
        ? cherryMessage || `发现 ${cherryReady} 个可同步配置`
        : cherryMessage || "点击扫描本地配置";
  const thirdPartyLoading = ccsLoading || cherryLoading;
  const thirdPartyImporting = ccsImporting || cherryImporting;
  const cherryResolvedDataPath = cherryDataPath ?? cherryProviders?.dataPath ?? "";

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
                  disabled={ccsLoading || ccsImporting || !ccsAll.length}
                  onSelect={onOpenCcsImport}
                >
                  <CcsSourceLogo className="h-9 w-9 text-[11px]" />
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
                  {ccsLoading || ccsImporting ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : null}
                </DropdownMenuItem>
                <div className="flex items-stretch gap-1">
                  <DropdownMenuItem
                    className="model-selector-item min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2.5"
                    disabled={cherryLoading || cherryImporting || !cherryAll.length}
                    onSelect={onOpenCherryImport}
                  >
                    <CherrySourceLogo className="h-9 w-9 text-[11px]" />
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
                  <Popover.Root>
                    <Popover.Trigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-auto w-8 shrink-0 rounded-lg text-muted-foreground"
                          disabled={cherryLoading || cherryImporting}
                          aria-label="Cherry Studio 数据目录设置"
                          title="Cherry Studio 数据目录设置"
                        />
                      }
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Positioner
                        side="bottom"
                        align="end"
                        sideOffset={6}
                        collisionPadding={8}
                        className="z-[10000]"
                      >
                        <Popover.Popup className="w-80 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none">
                          <div className="space-y-3">
                            <div>
                              <div className="text-sm font-medium">Cherry Studio 数据目录</div>
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {cherryDataPath
                                  ? "正在使用手动指定的目录"
                                  : "LiveAgent 会自动读取 Cherry Studio 的数据目录设置"}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                readOnly
                                value={cherryResolvedDataPath}
                                placeholder={cherryLoading ? "正在检测…" : "未检测到数据目录"}
                                className="h-9 min-w-0 flex-1 text-xs"
                                title={cherryResolvedDataPath}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-9 w-9 shrink-0"
                                disabled={cherryLoading || cherryImporting}
                                onClick={onChooseCherryDataDirectory}
                                title="选择数据目录"
                                aria-label="选择 Cherry Studio 数据目录"
                              >
                                <FolderOpen className="h-4 w-4" />
                              </Button>
                            </div>
                            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                              <span>{cherryDataPath ? "手动指定" : "自动检测"}</span>
                              {cherryDataPath ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={onResetCherryDataDirectory}
                                >
                                  恢复自动检测
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </Popover.Popup>
                      </Popover.Positioner>
                    </Popover.Portal>
                  </Popover.Root>
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
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
                className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent/30"
              >
                <div className="flex w-5 shrink-0 items-center justify-center text-lg text-foreground">
                  <ProviderBrandIcon type={type} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{provider.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {provider.baseUrl || t("settings.noBaseUrl")} {" · "}
                    {provider.activeModels.length} {t("settings.activeModels")}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
  const [ccsImporting, setCcsImporting] = useState(false);
  const [ccsMessage, setCcsMessage] = useState<string | null>(null);
  const [cherryProviders, setCherryProviders] = useState<CherryProvidersResponse | null>(null);
  const [cherryLoading, setCherryLoading] = useState(false);
  const [cherryImporting, setCherryImporting] = useState(false);
  const [cherryMessage, setCherryMessage] = useState<string | null>(null);
  const [cherryDataPath, setCherryDataPath] = useState<string | null>(readCherryDataPath);

  async function refreshThirdPartyProviders() {
    setCcsLoading(true);
    setCherryLoading(true);
    const [ccsResult, cherryResult] = await Promise.allSettled([
      invoke<CcsProvidersResponse>("settings_list_ccswitch_providers"),
      cherryDataPath
        ? invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers_from_path", {
            dataPath: cherryDataPath,
          })
        : invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers"),
    ]);
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
      const response = await invoke<CherryProvidersResponse>(
        "settings_list_cherry_studio_providers_from_path",
        { dataPath: selected },
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
    setCherryProviders(null);
    setCherryMessage("已恢复自动检测，正在重新扫描…");
    setCherryLoading(true);
    void invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers")
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

  async function importCcsProviders(items: CcsProviderImportItem[]): Promise<string> {
    const transferable = items.filter(ccsProviderIsTransferable);
    if (!transferable.length) {
      const message = "所选供应商没有可导入的 API 配置";
      setCcsMessage(message);
      return message;
    }

    setCcsImporting(true);
    setCcsMessage("正在导入供应商、获取并激活全部模型…");

    try {
      setSettings((prev) => {
        const nextImported = buildCcsImportedProviders(prev.customProviders, transferable);
        if (!nextImported.length) return prev;
        return updateCustomProviders(prev, [...prev.customProviders, ...nextImported]);
      });

      const modelResults = await Promise.all(
        transferable.map(async (item) => {
          const identity = ccsImportIdentity({
            type: item.providerType,
            name: item.name,
            baseUrl: item.baseUrl,
          });
          if (!ccsProviderCanSyncModels(item)) {
            return { identity, models: [] as ProviderModelConfig[], fetched: false, failed: false };
          }
          try {
            const models = await fetchModelsFromApi(item.providerType, item.baseUrl, item.apiKey);
            return { identity, models, fetched: true, failed: false };
          } catch {
            return { identity, models: [] as ProviderModelConfig[], fetched: false, failed: true };
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
          if (!result) return provider;
          const models = result.fetched
            ? mergeFetchedModels(result.models, provider.models)
            : provider.models;
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
      const failedCount = modelResults.filter((result) => result.failed).length;
      const totalModels = modelResults.reduce((total, result) => total + result.models.length, 0);
      const importedByType = PROVIDER_TABS.map((tab) => ({
        type: tab,
        count: transferable.filter((item) => item.providerType === tab).length,
      })).filter((entry) => entry.count > 0);
      const details = [
        `已导入 ${importedByType
          .map((entry) => `${entry.count} 个 ${getProviderLabel(entry.type)}`)
          .join("、")} 供应商`,
        fetchedCount > 0 ? `获取并激活 ${totalModels} 个模型` : "已激活供应商内的全部模型",
        failedCount > 0 ? `${failedCount} 个供应商模型获取失败` : "",
      ].filter(Boolean);
      const summary = details.join("，");
      setCcsMessage(summary);
      return summary;
    } finally {
      setCcsImporting(false);
    }
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
        id: crypto.randomUUID(),
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
                ccsProviders={ccsProviders}
                ccsLoading={ccsLoading}
                ccsImporting={ccsImporting}
                ccsMessage={ccsMessage}
                cherryProviders={cherryProviders}
                cherryLoading={cherryLoading}
                cherryImporting={cherryImporting}
                cherryMessage={cherryMessage}
                cherryDataPath={cherryDataPath}
                onEnsureThirdPartyScan={ensureThirdPartyScan}
                onRefreshThirdPartyProviders={() => void refreshThirdPartyProviders()}
                onOpenCcsImport={() => setCcsImportType(tab)}
                onOpenCherryImport={() => setCherryImportType(tab)}
                onChooseCherryDataDirectory={() => void chooseCherryDataDirectory()}
                onResetCherryDataDirectory={resetCherryDataDirectory}
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
          importing={ccsImporting}
          onImport={importCcsProviders}
          onClose={() => setCcsImportType(null)}
        />
      ) : null}
      {cherryImportType && cherryProviders ? (
        <CherryStudioImportModal
          providerType={cherryImportType}
          response={cherryProviders}
          importing={cherryImporting}
          isExisting={(item) =>
            settings.customProviders.some((provider) => provider.id === cherryProviderId(item))
          }
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
