import { ExternalLink } from "@liveagent/ui/components/IconSet";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@liveagent/ui/components/settings/SettingsLayout";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "@liveagent/ui/components/settings/SettingsSelect";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Select, SelectItem, SelectValue } from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n";
import {
  buildWebSearchSettingsUpdate,
  isWebSearchServiceId,
  type KBrainWebSearchSettings,
  readWebSearchSettings,
  validateWebSearchDraft,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_SERVICE_KEY_URLS,
  WEB_SEARCH_SERVICE_LABELS,
  WEB_SEARCH_SETTINGS_CHANGED_EVENT,
  type WebSearchDraft,
  type WebSearchServiceId,
  webSearchDraftFrom,
  webSearchFallbackSupported,
  webSearchStatus,
} from "@liveagent/ui/lib/providers/webSearchFallback";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KBrainSettingsAdapter } from "./kbrainSettingsAdapter";

const NO_PROVIDER = "none";

function connectionScope(kbrain: KBrainSettingsAdapter): string {
  const connection = kbrain.getConnection();
  return JSON.stringify(connection ? [connection.baseUrl, connection.token] : null);
}

/** K-brain answers a rejected write as {"error": "..."}; show the message, not the JSON. */
function errorMessage(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {}
  return text;
}

function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Settings → Intelligence → Web search: the third-party search service K-brain calls when
 * web search is on and the model's API cannot search natively (capability
 * web_search_fallback). The API key is write-only: K-brain reports only whether one is
 * configured and where it comes from.
 */
export function WebSearchSection({ kbrain }: { kbrain: KBrainSettingsAdapter }) {
  const { t } = useLocale();
  const fieldId = useId();
  const [settings, setSettings] = useState<KBrainWebSearchSettings | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<WebSearchDraft | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | null>("load");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  const loadedScope = useRef<string | undefined>(undefined);

  const serviceLabel = useCallback(
    (id: WebSearchServiceId) =>
      id === "bocha" ? t("settings.webSearch.service.bocha") : WEB_SEARCH_SERVICE_LABELS[id],
    [t],
  );

  const refresh = useCallback(async () => {
    const ticket = ++epoch.current;
    const scope = connectionScope(kbrain);
    pending.current = true;
    setBusy("load");
    setError("");
    setSaved(false);
    try {
      const [document, capabilities] = await Promise.all([
        kbrain.getSettings(),
        // A host that cannot read /v1/health relies on the settings document.
        kbrain.getCapabilities?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (ticket !== epoch.current) return;
      if (scope !== connectionScope(kbrain))
        throw new Error(t("settings.webSearch.connectionChanged"));
      loadedScope.current = scope;
      const next = webSearchFallbackSupported(document, capabilities)
        ? readWebSearchSettings(document.webSearch)
        : null;
      setSupported(next !== null);
      setSettings(next);
      setDraft(next ? webSearchDraftFrom(next) : null);
    } catch (reason) {
      if (ticket === epoch.current) setError(errorMessage(reason));
    } finally {
      if (ticket === epoch.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }, [kbrain, t]);

  useEffect(() => {
    void refresh();
    return () => {
      ++epoch.current;
      pending.current = false;
    };
  }, [refresh]);

  const update = settings && draft ? buildWebSearchSettingsUpdate(settings, draft) : null;
  const dirty = update !== null;
  const problem = draft ? validateWebSearchDraft(draft) : null;

  async function save() {
    if (pending.current || !settings || !draft || !update || problem) return;
    if (loadedScope.current !== connectionScope(kbrain)) {
      setSaved(false);
      setError(t("settings.webSearch.connectionChanged"));
      return;
    }
    const ticket = ++epoch.current;
    const scope = loadedScope.current;
    pending.current = true;
    setBusy("save");
    setError("");
    setSaved(false);
    try {
      const document = await kbrain.updateSettings(update);
      if (ticket !== epoch.current) return;
      if (scope !== connectionScope(kbrain))
        throw new Error(t("settings.webSearch.connectionChanged"));
      const next = readWebSearchSettings(document.webSearch);
      if (!next) throw new Error(t("settings.webSearch.upgrade"));
      setSettings(next);
      setDraft(webSearchDraftFrom(next));
      setSaved(true);
      window.dispatchEvent(new Event(WEB_SEARCH_SETTINGS_CHANGED_EVENT));
    } catch (reason) {
      if (ticket === epoch.current) setError(errorMessage(reason));
    } finally {
      if (ticket === epoch.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  function change(patch: Partial<WebSearchDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
    setError("");
  }

  const header = {
    title: t("settings.webSearch.title"),
    description: t("settings.webSearch.description"),
  };

  if (supported === false) {
    return (
      <SettingsSection {...header} data-testid="web-search-settings">
        <SettingsNotice variant="warning" role="status">
          {t("settings.webSearch.upgrade")}
        </SettingsNotice>
        {error && (
          <p role="alert" className="break-words px-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingsSection>
    );
  }

  const controlsDisabled = !!busy || !settings || !draft;
  const provider = draft?.provider ?? "";
  const usesKey = provider !== "" && provider !== "searxng";
  const status = settings ? webSearchStatus(settings) : null;
  const providerName = (id: string) => (isWebSearchServiceId(id) ? serviceLabel(id) : id);
  const statusText =
    status?.kind === "available"
      ? settings?.provider
        ? format(t("settings.webSearch.statusAvailable"), {
            provider: providerName(settings.provider),
          })
        : t("settings.webSearch.statusAvailableEnv")
      : status?.kind === "noProvider"
        ? t("settings.webSearch.statusNoProvider")
        : status?.kind === "baseUrlRequired"
          ? t("settings.webSearch.statusBaseUrlRequired")
          : status?.kind === "apiKeyRequired"
            ? format(t("settings.webSearch.statusApiKeyRequired"), {
                provider: providerName(settings?.provider ?? ""),
              })
            : status?.kind === "other"
              ? format(t("settings.webSearch.statusOther"), { reason: status.reason })
              : "";
  const keyState = settings?.apiKeyConfigured
    ? settings.apiKeySource === "env"
      ? t("settings.webSearch.apiKeyConfiguredEnv")
      : t("settings.webSearch.apiKeyConfiguredConfig")
    : "";
  // A key from the environment cannot be cleared here; it also wins over a saved key.
  const canClearKey = !!settings?.apiKeyConfigured && settings.apiKeySource === "config";

  return (
    <SettingsSection {...header} data-testid="web-search-settings" aria-busy={!!busy}>
      <SettingsCard>
        <SettingsRow
          title={t("settings.webSearch.provider")}
          description={t("settings.webSearch.providerHint")}
          control={
            <Select
              value={provider || NO_PROVIDER}
              disabled={controlsDisabled}
              onValueChange={(value) => {
                const next = String(value);
                change({ provider: isWebSearchServiceId(next) ? next : "" });
              }}
            >
              <SettingsSelectTrigger
                aria-label={t("settings.webSearch.provider")}
                className="min-w-40 justify-between"
              >
                <SelectValue>
                  {provider ? serviceLabel(provider) : t("settings.webSearch.providerNone")}
                </SelectValue>
              </SettingsSelectTrigger>
              <SettingsSelectContent>
                <SelectItem value={NO_PROVIDER}>{t("settings.webSearch.providerNone")}</SelectItem>
                {(settings?.providers ?? []).map((id) => (
                  <SelectItem key={id} value={id}>
                    {serviceLabel(id)}
                  </SelectItem>
                ))}
              </SettingsSelectContent>
            </Select>
          }
        />
        {usesKey && (
          <SettingsRow
            title={<label htmlFor={`${fieldId}-key`}>{t("settings.webSearch.apiKey")}</label>}
            description={
              <>
                {t("settings.webSearch.apiKeyHint")}
                {settings?.apiKeySource === "env" && <> {t("settings.webSearch.apiKeyEnvNote")}</>}
              </>
            }
            control={
              <div className="flex w-72 max-w-full flex-col items-end gap-1.5">
                <div className="flex w-full items-center gap-2">
                  <Input
                    id={`${fieldId}-key`}
                    variant="plain"
                    type="password"
                    className="h-8 min-w-0 flex-1 shadow-none"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft?.apiKey ?? ""}
                    disabled={controlsDisabled}
                    placeholder={
                      draft?.clearApiKey
                        ? t("settings.webSearch.apiKeyWillClear")
                        : keyState || t("settings.webSearch.apiKeyPlaceholder")
                    }
                    onChange={(event) =>
                      change({ apiKey: event.currentTarget.value, clearApiKey: false })
                    }
                  />
                  {canClearKey && !draft?.clearApiKey && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={controlsDisabled}
                      onClick={() => change({ apiKey: "", clearApiKey: true })}
                    >
                      {t("settings.webSearch.apiKeyClear")}
                    </Button>
                  )}
                  {draft?.clearApiKey && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={controlsDisabled}
                      onClick={() => change({ clearApiKey: false })}
                    >
                      {t("settings.webSearch.apiKeyUndoClear")}
                    </Button>
                  )}
                </div>
                {keyState && !draft?.clearApiKey && (
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="web-search-key-state"
                  >
                    {keyState}
                  </span>
                )}
              </div>
            }
          />
        )}
        {provider !== "" && (
          <SettingsRow
            title={<label htmlFor={`${fieldId}-url`}>{t("settings.webSearch.baseUrl")}</label>}
            description={t(
              provider === "searxng"
                ? "settings.webSearch.baseUrlHintSearxng"
                : "settings.webSearch.baseUrlHint",
            )}
            control={
              <Input
                id={`${fieldId}-url`}
                variant="plain"
                type="url"
                inputMode="url"
                className="h-8 w-72 max-w-full shadow-none"
                autoComplete="off"
                spellCheck={false}
                placeholder={provider === "searxng" ? "http://127.0.0.1:8888" : ""}
                value={draft?.baseUrl ?? ""}
                disabled={controlsDisabled}
                aria-invalid={problem === "baseUrlInvalid" || problem === "baseUrlRequired"}
                onChange={(event) => change({ baseUrl: event.currentTarget.value })}
              />
            }
          />
        )}
        {provider !== "" && (
          <SettingsRow
            title={<label htmlFor={`${fieldId}-max`}>{t("settings.webSearch.maxResults")}</label>}
            description={t("settings.webSearch.maxResultsHint")}
            control={
              <Input
                id={`${fieldId}-max`}
                variant="plain"
                type="number"
                min={1}
                max={WEB_SEARCH_MAX_RESULTS}
                step={1}
                className="h-8 w-20 shadow-none"
                value={draft ? String(draft.maxResults) : ""}
                disabled={controlsDisabled}
                aria-invalid={problem === "maxResults"}
                onChange={(event) => {
                  const value = event.currentTarget.value.trim();
                  change({ maxResults: value === "" ? Number.NaN : Number(value) });
                }}
              />
            }
          />
        )}
      </SettingsCard>
      {problem && (
        <p role="alert" className="px-1 text-xs leading-5 text-destructive">
          {t(
            problem === "baseUrlInvalid"
              ? "settings.webSearch.baseUrlInvalid"
              : problem === "baseUrlRequired"
                ? "settings.webSearch.baseUrlRequired"
                : "settings.webSearch.maxResultsInvalid",
          )}
        </p>
      )}
      {statusText && (
        <p
          className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground"
          data-testid="web-search-status"
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              status?.kind === "available" ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
          <span className="break-words">{statusText}</span>
        </p>
      )}
      <div className="space-y-2 px-1 text-xs leading-5 text-muted-foreground">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{t("settings.webSearch.help")}</span>
          {(settings?.providers ?? []).map((id) => (
            <a
              key={id}
              href={WEB_SEARCH_SERVICE_KEY_URLS[id]}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              {id === "searxng" ? t("settings.webSearch.helpSearxng") : serviceLabel(id)}
              <ExternalLink className="size-3" />
            </a>
          ))}
        </p>
        <p>{t("settings.webSearch.privacy")}</p>
        {!kbrain.getConnection() && <p>{t("settings.webSearch.webNotice")}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button
          size="sm"
          disabled={controlsDisabled || !dirty || !!problem}
          onClick={() => void save()}
        >
          {t("settings.webSearch.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => {
            if (!dirty || window.confirm(t("settings.webSearch.discard"))) void refresh();
          }}
        >
          {t("settings.webSearch.reload")}
        </Button>
        <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {busy
            ? t(`settings.webSearch.${busy === "load" ? "loading" : "saving"}`)
            : saved
              ? t("settings.webSearch.saved")
              : dirty
                ? t("settings.webSearch.unsaved")
                : ""}
        </span>
      </div>
      {error && (
        <p role="alert" className="break-words px-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsSection>
  );
}
