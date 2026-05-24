import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ClaudeIcon,
  Eye,
  EyeOff,
  FileTypeGeminiIcon,
  OpenaiChatgptIcon,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
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
import { useLocale } from "../../i18n";
import {
  CODEX_REQUEST_FORMAT_LABELS,
  type CodexRequestFormat,
  type CustomProvider,
  type ProviderId,
  type ProviderModelConfig,
  updateCustomProviders,
} from "../../lib/settings";
import {
  createDraftModelConfig,
  fetchModelsFromApi,
  isGatewayWebuiRuntime,
  mergeFetchedModels,
  normalizeFetchedModels,
  sortModelsBySelection,
} from "./providerUtils";
import { useModalMotion } from "../../lib/shared/modalMotion";
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

const PROVIDER_TABS: ProviderId[] = ["claude_code", "codex", "gemini"];
const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

function getProviderLabel(type: ProviderId) {
  return PROVIDER_LABELS[type];
}

function ProviderBrandIcon({ type }: { type: ProviderId }) {
  if (type === "claude_code") return <ClaudeIcon height="1em" />;
  if (type === "gemini") return <FileTypeGeminiIcon height="1em" />;
  return <OpenaiChatgptIcon height="1em" className="fill-current dark:text-white" />;
}

const REDACTED_API_KEY_DISPLAY = "API Key";

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
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

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
    requestClose();
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-[60] flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div className="settings-modal-panel relative z-10 w-full max-w-md rounded-2xl border bg-background shadow-2xl">
        <div className="settings-modal-header flex items-start justify-between gap-4 border-b px-6 py-4">
          <div>
            <div className="text-sm font-semibold">{t("settings.modelSettings")}</div>
            <div className="mt-1 text-xs text-muted-foreground">{model.id}</div>
          </div>
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={requestClose}>
            {t("settings.cancel")}
          </Button>
        </div>

        <div className="settings-modal-body space-y-4 px-6 py-5">
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

        <div className="settings-modal-footer flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={requestClose}>
            {t("settings.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSave || isClosing}>
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
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFetchKey = useRef("");
  const apiKeyIsRedactedDisplay =
    initialUsesRedactedApiKey && apiKey === REDACTED_API_KEY_DISPLAY;
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
    setModels((prev) =>
      prev.map((item) => (item.id === nextModel.id ? nextModel : item)),
    );
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
          : initialData?.reasoning ?? "off",
      promptCachingEnabled: initialData?.promptCachingEnabled ?? providerType === "claude_code",
      nativeWebSearchEnabled: initialData?.nativeWebSearchEnabled ?? true,
    });
    requestClose();
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
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div className="settings-modal-panel relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b px-6 py-4">
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

        <div className="settings-modal-body flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="modal-name">{t("settings.providerName")}</Label>
            <Input
              id="modal-name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
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
                  <SelectValue />
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
            <div className="settings-model-toolbar flex items-center justify-between">
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
                  {allVisibleModelsSelected
                    ? t("settings.deselectAll")
                    : t("settings.selectAll")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleRefresh}
                  disabled={fetchingModels || (isGatewayWebui && !canFetchModels)}
                  title={t("settings.refreshModels")}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${fetchingModels ? "animate-spin" : ""}`}
                  />
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
              <div className="settings-inline-form flex gap-2">
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
                      className="settings-model-row group flex items-center gap-2 px-3 py-2 hover:bg-accent/30"
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
                        className="settings-hover-action hidden h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover:flex"
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

        <div className="settings-modal-footer flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={requestClose}>
            {t("settings.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || isClosing}>
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

function ProviderList(props: {
  type: ProviderId;
  providers: CustomProvider[];
  onAdd: () => void;
  onEdit: (provider: CustomProvider) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useLocale();
  const { type, providers, onAdd, onEdit, onDelete } = props;
  const filtered = providers.filter((provider) => provider.type === type);

  return (
    <div className="settings-provider-list flex h-full min-h-0 flex-col gap-4">
      <div className="settings-section-heading-row flex shrink-0 items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {filtered.length === 0
            ? t("settings.noProviders")
            : `${filtered.length} ${t("settings.navProviders")}`}
        </div>
        <Button variant="outline" size="sm" className="settings-section-action gap-1.5" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
          {t("settings.addProvider")}
        </Button>
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
                className="settings-card-row group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent/30"
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
                <div className="settings-card-actions settings-hover-actions flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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

  const [activeTab, setActiveTab] = useState<ProviderId>("claude_code");
  const [modalOpen, setModalOpen] = useState(false);
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
        id: crypto.randomUUID(),
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

  const activeTabIndex = Math.max(0, PROVIDER_TABS.indexOf(activeTab));

  return (
    <>
      <div className="settings-provider-tabs-wrap mb-4 flex shrink-0 justify-start">
        <div className="settings-provider-tabs inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
          {PROVIDER_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all ${
                activeTab === tab ? "bg-background text-foreground shadow" : "hover:text-foreground/80"
              }`}
            >
              <ProviderBrandIcon type={tab} />
              {getProviderLabel(tab)}
            </button>
          ))}
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
    </>
  );
}
