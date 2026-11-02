import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useMemo, useState } from "react";

import type {
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
  KBrainSettingsProvider,
} from "./kbrainSettingsAdapter";

const SETTINGS_CHANGED_EVENT = "kbrain:settings-changed";

export function toKBrainProviderUpdate(
  provider: KBrainSettingsProvider,
  apiKey: string,
  clearApiKey = false,
) {
  return {
    id: provider.id,
    name: provider.name,
    api: provider.api,
    baseUrl: provider.baseUrl,
    ...(clearApiKey ? { clearApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    activeModels: provider.activeModels.filter((modelId) =>
      provider.models.some((model) => model.id === modelId),
    ),
    models: provider.models.map(({ provider: _provider, ...model }) => model),
  };
}

export function KBrainSettingsSection(
  props: SettingsSectionProps & { kbrain: KBrainSettingsAdapter },
) {
  const { t } = useLocale();
  const { kbrain } = props;
  const [document, setDocument] = useState<KBrainSettingsDocument | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pendingApiKeys, setPendingApiKeys] = useState<Record<string, string>>({});
  const [pendingClearKeys, setPendingClearKeys] = useState<Record<string, boolean>>({});
  const [newModel, setNewModel] = useState("");
  const [newProviderId, setNewProviderId] = useState("");
  const [newProviderName, setNewProviderName] = useState("");
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState("");
  const [newProviderApiKey, setNewProviderApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [deletedProviderIds, setDeletedProviderIds] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = useMemo(
    () => document?.providers.find((item) => item.id === selectedId) ?? document?.providers[0],
    [document, selectedId],
  );

  useEffect(() => {
    let cancelled = false;
    void kbrain
      .getSettings()
      .then((value) => {
        if (cancelled) return;
        setDocument(value);
        setSelectedId(value.providers[0]?.id ?? "");
        setPendingApiKeys({});
        setPendingClearKeys({});
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [kbrain]);

  function updateProvider(patch: Partial<KBrainSettingsProvider>) {
    if (!provider || !document) return;
    setDocument({
      ...document,
      providers: document.providers.map((item) =>
        item.id === provider.id ? { ...item, ...patch } : item,
      ),
    });
  }
  function addProvider() {
    if (!document) return;
    const id = newProviderId.trim();
    if (!id || document.providers.some((item) => item.id === id)) return;
    const next: KBrainSettingsProvider = {
      id,
      name: newProviderName.trim() || id,
      api: "openai-completions",
      baseUrl: newProviderBaseUrl.trim(),
      apiKeyConfigured: Boolean(newProviderApiKey.trim()),
      activeModels: [],
      models: [],
    };
    setDocument({ ...document, providers: [...document.providers, next] });
    setSelectedId(id);
    setApiKey(newProviderApiKey);
    setPendingApiKeys((keys) => ({ ...keys, [id]: newProviderApiKey }));
    setPendingClearKeys((keys) => ({ ...keys, [id]: false }));
    setClearKey(false);
    setNewProviderId("");
    setNewProviderName("");
    setNewProviderBaseUrl("");
    setNewProviderApiKey("");
  }
  function removeModel(modelId: string) {
    if (!provider || !document) return;
    const models = provider.models.filter((model) => model.id !== modelId);
    const activeModels = provider.activeModels.filter((id) => id !== modelId);
    const nextDefault =
      document.defaultProvider === provider.id && document.defaultModel === modelId
        ? { defaultProvider: "", defaultModel: "" }
        : {};
    updateProvider({ models, activeModels });
    setDocument((current) => (current ? { ...current, ...nextDefault } : current));
  }
  function removeProvider() {
    if (!provider || !document) return;
    const providers = document.providers.filter((item) => item.id !== provider.id);
    const next = providers[0];
    setDocument({
      ...document,
      providers,
      defaultProvider:
        document.defaultProvider === provider.id ? (next?.id ?? "") : document.defaultProvider,
      defaultModel:
        document.defaultProvider === provider.id
          ? (next?.models[0]?.id ?? "")
          : document.defaultModel,
    });
    setSelectedId(next?.id ?? "");
    setApiKey("");
    setClearKey(false);
    setDeletedProviderIds((ids) => (ids.includes(provider.id) ? ids : [...ids, provider.id]));
  }
  function addModel() {
    const id = newModel.trim();
    if (!provider || !id || provider.models.some((model) => model.id === id)) return;
    updateProvider({
      models: [
        ...provider.models,
        { provider: provider.id, id, contextWindow: 0, maxOutputTokens: 0 },
      ],
      activeModels: [...provider.activeModels, id],
    });
    setNewModel("");
  }
  async function save() {
    if (!document) return;
    setStatus(null);
    setError(null);
    try {
      const response = await kbrain.updateSettings({
        defaultModel: document.defaultModel,
        defaultProvider: document.defaultProvider,
        deleteProviders: deletedProviderIds,
        providers: document.providers.map((item) =>
          toKBrainProviderUpdate(
            item,
            item.id === provider?.id ? apiKey : "",
            item.id === provider?.id && clearKey,
          ),
        ),
      });
      setDocument(response);
      setApiKey("");
      setClearKey(false);
      setDeletedProviderIds([]);
      setStatus(t("settings.kbrainSaved"));
      window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (error && !document)
    return <div className="space-y-3 p-1 text-sm text-destructive">{error}</div>;
  if (!document)
    return <div className="p-1 text-sm text-muted-foreground">{t("settings.kbrainLoading")}</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-1">
      <div>
        <h2 className="text-base font-semibold">{t("settings.kbrainTitle")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("settings.kbrainDescription")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={t("settings.kbrainProviderId")}
          value={newProviderId}
          placeholder={t("settings.kbrainProviderId")}
          onChange={(event) => setNewProviderId(event.target.value)}
        />
        <Input
          aria-label={t("settings.kbrainProviderName")}
          value={newProviderName}
          placeholder={t("settings.kbrainProviderName")}
          onChange={(event) => setNewProviderName(event.target.value)}
        />
        <Input
          aria-label={t("settings.kbrainBaseUrl")}
          value={newProviderBaseUrl}
          placeholder={t("settings.kbrainBaseUrl")}
          onChange={(event) => setNewProviderBaseUrl(event.target.value)}
        />
        <Input
          aria-label={t("settings.kbrainApiKey")}
          type="password"
          value={newProviderApiKey}
          placeholder={t("settings.kbrainApiKey")}
          onChange={(event) => setNewProviderApiKey(event.target.value)}
        />
        <Button variant="outline" onClick={addProvider}>
          {t("settings.kbrainAddProvider")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {document.providers.map((item) => (
          <Button
            key={item.id}
            variant={item.id === provider?.id ? "secondary" : "ghost"}
            onClick={() => {
              setSelectedId(item.id);
              setApiKey(pendingApiKeys[item.id] ?? "");
              setClearKey(pendingClearKeys[item.id] ?? false);
            }}
          >
            {item.name || item.id}
          </Button>
        ))}
      </div>
      {provider ? (
        <section className="space-y-4 rounded-xl bg-settings-tile p-4">
          <label htmlFor="kbrain-provider-id" className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("settings.kbrainProviderId")}
            </span>
            <Input id="kbrain-provider-id" value={provider.id} disabled />
          </label>
          <label htmlFor="kbrain-provider-name" className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("settings.kbrainProviderName")}
            </span>
            <Input
              id="kbrain-provider-name"
              value={provider.name}
              onChange={(event) => updateProvider({ name: event.target.value })}
            />
          </label>
          <label htmlFor="kbrain-api" className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("settings.kbrainApi")}
            </span>
            <Input
              id="kbrain-api"
              value={provider.api}
              onChange={(event) => updateProvider({ api: event.target.value })}
            />
          </label>
          <label htmlFor="kbrain-base-url" className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("settings.kbrainBaseUrl")}
            </span>
            <Input
              id="kbrain-base-url"
              value={provider.baseUrl}
              onChange={(event) => updateProvider({ baseUrl: event.target.value })}
            />
          </label>
          <label htmlFor="kbrain-api-key" className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {provider.apiKeyConfigured
                ? t("settings.kbrainApiKeyReplace")
                : t("settings.kbrainApiKey")}
            </span>
            <Input
              id="kbrain-api-key"
              type="password"
              value={apiKey}
              placeholder={provider.apiKeyConfigured ? "••••••••" : "API key"}
              onChange={(event) => {
                setApiKey(event.target.value);
                setPendingApiKeys((keys) => ({ ...keys, [provider.id]: event.target.value }));
                setClearKey(false);
                setPendingClearKeys((keys) => ({ ...keys, [provider.id]: false }));
              }}
              autoComplete="new-password"
            />
          </label>
          {provider.apiKeyConfigured ? (
            <div className="flex items-center gap-2 text-xs">
              <input
                id="kbrain-clear-key"
                type="checkbox"
                checked={clearKey}
                onChange={(event) => {
                  setClearKey(event.target.checked);
                  setPendingClearKeys((keys) => ({ ...keys, [provider.id]: event.target.checked }));
                  if (event.target.checked) {
                    setApiKey("");
                    setPendingApiKeys((keys) => ({ ...keys, [provider.id]: "" }));
                  }
                }}
              />
              <label htmlFor="kbrain-clear-key">{t("settings.kbrainClearApiKey")}</label>
            </div>
          ) : null}
          <Button variant="ghost" className="text-destructive" onClick={removeProvider}>
            {t("settings.kbrainDeleteProvider")}
          </Button>
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">{t("settings.kbrainModels")}</div>
            {provider.models.map((model) => (
              <div
                key={model.id}
                className="flex items-center gap-2 rounded-lg bg-settings-tile-hover"
              >
                <Button
                  variant={
                    document.defaultProvider === provider.id && document.defaultModel === model.id
                      ? "secondary"
                      : "ghost"
                  }
                  className="min-w-0 flex-1 justify-start rounded-lg px-3 py-2 text-sm"
                  onClick={() =>
                    setDocument({
                      ...document,
                      defaultProvider: provider.id,
                      defaultModel: model.id,
                    })
                  }
                >
                  <span className="truncate">{model.id}</span>
                </Button>
                <Button
                  variant="ghost"
                  className="mr-1 px-2 text-xs text-destructive"
                  aria-label={`${t("settings.delete")} ${model.id}`}
                  onClick={() => removeModel(model.id)}
                >
                  ×
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                value={newModel}
                placeholder={t("settings.kbrainModelPlaceholder")}
                onChange={(event) => setNewModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addModel();
                }}
              />
              <Button variant="outline" onClick={addModel}>
                {t("settings.kbrainAddModel")}
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {status ??
                error ??
                (provider.apiKeyConfigured ? t("settings.kbrainKeyConfigured") : "")}
            </span>
            <Button onClick={() => void save()}>{t("settings.save")}</Button>
          </div>
        </section>
      ) : (
        <div className="rounded-xl bg-settings-tile p-4 text-sm text-muted-foreground">
          {t("settings.kbrainNoProviders")}
        </div>
      )}
      <div className="flex justify-end">
        <Button onClick={() => void save()}>{t("settings.save")}</Button>
      </div>
    </div>
  );
}
