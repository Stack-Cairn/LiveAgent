import "@liveagent/ui/i18n/namespaces/settings";
import type { CustomHeader } from "@liveagent/ui/lib/providers/customHeaders";

/**
 * Presets for the Gemini provider's "API Platform" selector. They only fill the
 * base URL (with "full URL" off); nothing new is persisted, so the platform is
 * always derived back from the base URL.
 */
export const GEMINI_API_PLATFORM_BASE_URLS = {
  "ai-studio": "https://generativelanguage.googleapis.com/v1beta",
  vertex: "https://aiplatform.googleapis.com/v1/publishers/google",
} as const;

export type GeminiApiPlatformPreset = keyof typeof GEMINI_API_PLATFORM_BASE_URLS;
export type GeminiApiPlatform = GeminiApiPlatformPreset | "custom";

export const GEMINI_API_PLATFORM_PRESETS = Object.keys(
  GEMINI_API_PLATFORM_BASE_URLS,
) as GeminiApiPlatformPreset[];

export const GEMINI_API_PLATFORM_LABEL_KEYS: Record<GeminiApiPlatform, string> = {
  "ai-studio": "settings.geminiApiPlatform.aiStudio",
  vertex: "settings.geminiApiPlatform.vertex",
  custom: "settings.geminiApiPlatform.custom",
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/** The preset a base URL matches exactly; anything else (relays, regional Vertex hosts) is custom. */
export function detectGeminiApiPlatform(baseUrl: string, isFullUrl: boolean): GeminiApiPlatform {
  if (isFullUrl) return "custom";
  const normalized = normalizeBaseUrl(baseUrl);
  return (
    GEMINI_API_PLATFORM_PRESETS.find(
      (preset) => normalizeBaseUrl(GEMINI_API_PLATFORM_BASE_URLS[preset]) === normalized,
    ) ?? "custom"
  );
}

/**
 * Switching presets would point a saved credential (key or custom headers) at a
 * different host on the next refresh or save, so editing such a provider keeps
 * its platform, like the service type.
 */
export function geminiApiPlatformLocked(
  saved:
    | { apiKey?: string; apiKeyConfigured?: boolean; customHeaders?: CustomHeader[] }
    | undefined,
): boolean {
  if (!saved) return false;
  return (
    saved.apiKeyConfigured === true ||
    Boolean(saved.apiKey?.trim()) ||
    (saved.customHeaders?.length ?? 0) > 0
  );
}

/** Same rule as K-brain: a Vertex AI host whose path ends in /publishers/google. */
function isVertexPublisherBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl.trim().replace(/\/+$/, ""));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const vertexHost =
    host === "aiplatform.googleapis.com" || host.endsWith("-aiplatform.googleapis.com");
  return vertexHost && url.pathname.toLowerCase().endsWith("/publishers/google");
}

/**
 * Vertex AI Express Mode authenticates with an API key only and has no model
 * list endpoint. K-brain lists Vertex models only with an Authorization header
 * (an OAuth token), which is a reserved custom header here, so discovery for a
 * Vertex publisher address always hits Express Mode.
 */
export function isVertexExpressDiscovery(input: {
  providerType: string;
  baseUrl: string;
  isFullUrl: boolean;
}): boolean {
  return (
    input.providerType === "gemini" && !input.isFullUrl && isVertexPublisherBaseUrl(input.baseUrl)
  );
}

// Errors that mean "no model list here". The Gateway relays only the generic
// message, so a failure without an errorCode counts too.
const EXPRESS_DISCOVERY_ERROR_CODES = new Set([undefined, "upstream_error", "not_found"]);

/** True when a discovery failure is Vertex AI Express Mode having no model list. */
export function isVertexExpressDiscoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/express mode/i.test(message)) return true;
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return EXPRESS_DISCOVERY_ERROR_CODES.has(typeof code === "string" ? code : undefined);
}
