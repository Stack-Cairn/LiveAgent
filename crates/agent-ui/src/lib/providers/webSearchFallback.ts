/**
 * K-brain web search fallback (`capabilities.web_search_fallback`). When web search is on
 * and the model's API cannot search natively (Chat Completions, Gemini relays), K-brain
 * offers a `web_search` tool backed by the third-party service in `/v1/settings` webSearch.
 * The run request is unchanged (`options.search`); this module decides whether the
 * composer may turn search on and builds the settings update. The API key never leaves
 * K-brain: the document only says whether one is configured and where it came from.
 */

export const WEB_SEARCH_FALLBACK_CAPABILITY = "web_search_fallback";

export const WEB_SEARCH_SERVICES = ["tavily", "brave", "searxng", "bocha", "jina"] as const;
export type WebSearchServiceId = (typeof WEB_SEARCH_SERVICES)[number];

export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 10;

export const WEB_SEARCH_SERVICE_LABELS: Record<WebSearchServiceId, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
  searxng: "SearXNG",
  bocha: "Bocha",
  jina: "Jina",
};

/** Where to get a key (or, for SearXNG, how to enable the JSON API on an instance). */
export const WEB_SEARCH_SERVICE_KEY_URLS: Record<WebSearchServiceId, string> = {
  tavily: "https://app.tavily.com/home",
  brave: "https://api-dashboard.search.brave.com/app/keys",
  searxng: "https://docs.searxng.org/admin/settings/settings_search.html",
  bocha: "https://open.bochaai.com/",
  jina: "https://jina.ai/api-dashboard/",
};

/** `webSearch` in GET /v1/settings. Read-only fields describe the effective setting. */
export type KBrainWebSearchSettings = {
  provider: WebSearchServiceId | "";
  baseUrl: string;
  /** Stored value; 0 means K-brain's default (5). */
  maxResults: number;
  apiKeyConfigured: boolean;
  apiKeySource: "config" | "env" | "";
  available: boolean;
  reason: string;
  providers: WebSearchServiceId[];
};

/** `webSearch` in PUT /v1/settings: omitted fields keep their value. */
export type KBrainWebSearchUpdate = {
  provider?: WebSearchServiceId | "";
  apiKey?: string;
  clearApiKey?: true;
  baseUrl?: string;
  maxResults?: number;
};

export function isWebSearchServiceId(value: unknown): value is WebSearchServiceId {
  return typeof value === "string" && (WEB_SEARCH_SERVICES as readonly string[]).includes(value);
}

export function webSearchServiceLabel(id: string): string {
  return isWebSearchServiceId(id) ? WEB_SEARCH_SERVICE_LABELS[id] : id;
}

/**
 * The `webSearch` section of a K-brain settings document, or null when the backend does
 * not have one (older K-brain) or sends something that is not the documented shape.
 */
export function readWebSearchSettings(value: unknown): KBrainWebSearchSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.available !== "boolean") return null;
  const provider = typeof source.provider === "string" ? source.provider.trim().toLowerCase() : "";
  const maxResults =
    typeof source.maxResults === "number" && Number.isFinite(source.maxResults)
      ? Math.max(0, Math.min(WEB_SEARCH_MAX_RESULTS, Math.round(source.maxResults)))
      : 0;
  const providers = Array.isArray(source.providers)
    ? source.providers.filter(isWebSearchServiceId)
    : [];
  return {
    provider: isWebSearchServiceId(provider) ? provider : "",
    baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "",
    maxResults,
    apiKeyConfigured: source.apiKeyConfigured === true,
    apiKeySource:
      source.apiKeySource === "config" || source.apiKeySource === "env" ? source.apiKeySource : "",
    available: source.available,
    reason: typeof source.reason === "string" ? source.reason : "",
    providers: providers.length ? providers : [...WEB_SEARCH_SERVICES],
  };
}

/**
 * Whether the backend supports the fallback. `capabilities` comes from /v1/health when the
 * host can read it; a host that cannot relies on the settings document, which carries
 * `webSearch` exactly when the backend has the capability.
 */
export function webSearchFallbackSupported(
  document: { webSearch?: unknown } | null | undefined,
  capabilities?: Record<string, unknown> | null,
): boolean {
  if (capabilities && Number(capabilities[WEB_SEARCH_FALLBACK_CAPABILITY] ?? 0) < 1) return false;
  return readWebSearchSettings(document?.webSearch) !== null;
}

/** The fallback state the composer and the run gate use; null means unknown or unsupported. */
export type WebSearchFallbackState = {
  available: boolean;
  provider: WebSearchServiceId | "";
};

export function webSearchFallbackStateFrom(
  document: { webSearch?: unknown } | null | undefined,
  capabilities?: Record<string, unknown> | null,
): WebSearchFallbackState | null {
  if (!webSearchFallbackSupported(document, capabilities)) return null;
  const settings = readWebSearchSettings(document?.webSearch);
  if (!settings) return null;
  return { available: settings.available, provider: settings.provider };
}

export type WebSearchToggleState = {
  /** The composer switch may be turned on and runs may send `search: "enabled"`. */
  usable: boolean;
  via: "native" | "fallback" | null;
  /** The service K-brain will call when `via` is "fallback" ("" when it does not say). */
  fallbackProvider: WebSearchServiceId | "";
  /**
   * Why it is not usable: the API has no native search and the backend has no fallback
   * ("upgrade"), or the backend has one that is not configured yet ("configure").
   */
  blocked: "upgrade" | "configure" | null;
};

/**
 * Composer switch rule: native search when the model's API supports it, otherwise the
 * backend's fallback when it has the capability and `webSearch.available`.
 */
export function resolveWebSearchToggle(input: {
  nativeSupported: boolean;
  fallback: WebSearchFallbackState | null | undefined;
}): WebSearchToggleState {
  if (input.nativeSupported) {
    return { usable: true, via: "native", fallbackProvider: "", blocked: null };
  }
  if (!input.fallback) {
    return { usable: false, via: null, fallbackProvider: "", blocked: "upgrade" };
  }
  if (!input.fallback.available) {
    return { usable: false, via: null, fallbackProvider: "", blocked: "configure" };
  }
  return {
    usable: true,
    via: "fallback",
    fallbackProvider: input.fallback.provider,
    blocked: null,
  };
}

/** What the user edits in Settings → Web search. `apiKey` is only ever a new key. */
export type WebSearchDraft = {
  provider: WebSearchServiceId | "";
  apiKey: string;
  clearApiKey: boolean;
  baseUrl: string;
  maxResults: number;
};

export function webSearchDraftFrom(settings: KBrainWebSearchSettings): WebSearchDraft {
  return {
    provider: settings.provider,
    apiKey: "",
    clearApiKey: false,
    baseUrl: settings.baseUrl,
    maxResults: settings.maxResults > 0 ? settings.maxResults : WEB_SEARCH_DEFAULT_MAX_RESULTS,
  };
}

export type WebSearchDraftProblem = "baseUrlRequired" | "baseUrlInvalid" | "maxResults" | null;

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

/** Client-side check of what K-brain would reject (or what would leave search unusable). */
export function validateWebSearchDraft(draft: WebSearchDraft): WebSearchDraftProblem {
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl && !validHttpUrl(baseUrl)) return "baseUrlInvalid";
  if (draft.provider === "searxng" && !baseUrl) return "baseUrlRequired";
  if (
    !Number.isInteger(draft.maxResults) ||
    draft.maxResults < 1 ||
    draft.maxResults > WEB_SEARCH_MAX_RESULTS
  ) {
    return "maxResults";
  }
  return null;
}

/**
 * The PUT /v1/settings body for a draft: only the fields that changed, never the stored key.
 * An empty key field keeps the stored key, so it is left out; a new key replaces it and
 * `clearApiKey` removes it (never both). Returns null when nothing changed.
 */
export function buildWebSearchSettingsUpdate(
  current: KBrainWebSearchSettings,
  draft: WebSearchDraft,
): { webSearch: KBrainWebSearchUpdate } | null {
  const update: KBrainWebSearchUpdate = {};
  if (draft.provider !== current.provider) update.provider = draft.provider;
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl !== current.baseUrl.trim()) update.baseUrl = baseUrl;
  const storedMax = current.maxResults > 0 ? current.maxResults : WEB_SEARCH_DEFAULT_MAX_RESULTS;
  if (draft.maxResults !== storedMax) update.maxResults = draft.maxResults;
  const apiKey = draft.apiKey.trim();
  if (apiKey) update.apiKey = apiKey;
  else if (draft.clearApiKey && current.apiKeyConfigured) update.clearApiKey = true;
  return Object.keys(update).length ? { webSearch: update } : null;
}

/**
 * Why search cannot run, in terms the settings page can translate. `reason` from K-brain is
 * English and names config keys, so the known cases are recognised from the fields and
 * only an unknown problem falls back to the backend's text.
 */
export type WebSearchStatus =
  | { kind: "available" }
  | { kind: "noProvider" }
  | { kind: "baseUrlRequired" }
  | { kind: "apiKeyRequired" }
  | { kind: "other"; reason: string };

export function webSearchStatus(settings: KBrainWebSearchSettings): WebSearchStatus {
  if (settings.available) return { kind: "available" };
  if (!settings.provider) return { kind: "noProvider" };
  if (settings.provider === "searxng" && !settings.baseUrl.trim()) {
    return { kind: "baseUrlRequired" };
  }
  if (settings.provider !== "searxng" && !settings.apiKeyConfigured) {
    return { kind: "apiKeyRequired" };
  }
  return { kind: "other", reason: settings.reason };
}

// ---------------------------------------------------------------------------
// Last known fallback state, for the run gate (which is synchronous) and the composer.
// Hosts record it whenever they read or write the K-brain settings document.

let recorded: WebSearchFallbackState | null = null;
let version = 0;
const listeners = new Set<() => void>();

export const WEB_SEARCH_SETTINGS_CHANGED_EVENT = "kbrain:settings-changed";

export function recordWebSearchFallbackState(state: WebSearchFallbackState | null): void {
  if (
    recorded === state ||
    (recorded &&
      state &&
      recorded.available === state.available &&
      recorded.provider === state.provider)
  ) {
    return;
  }
  recorded = state;
  version += 1;
  for (const listener of listeners) listener();
}

export function getRecordedWebSearchFallbackState(): WebSearchFallbackState | null {
  return recorded;
}

/** Increases whenever the recorded state changes, for memo dependencies. */
export function getWebSearchFallbackVersion(): number {
  return version;
}

/** Whether a run may send `search: "enabled"` for a provider with the given native support. */
export function webSearchUsableForRun(nativeSupported: boolean): boolean {
  return resolveWebSearchToggle({ nativeSupported, fallback: recorded }).usable;
}

/** Calls `listener` whenever the recorded state changes; returns the unsubscribe function. */
export function subscribeWebSearchFallbackState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
