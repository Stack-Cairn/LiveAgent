import type { Model } from "@earendil-works/pi-ai";
import { isRecord } from "./common";
import type { StreamOptionsEx } from "./types";

// ---------------------------------------------------------------------------
// Gemini request-shape policy (google-generative-ai payloads).
//
// API rules this module encodes (ai.google.dev/gemini-api/docs, 2026-03):
// - Mixing built-in server-side tools (googleSearch / urlContext / ...) with
//   functionDeclarations in one generateContent request is supported on
//   Gemini 3+ models only, and the Gemini Developer API additionally requires
//   `toolConfig.includeServerSideToolInvocations: true` — otherwise it fails
//   with 400 "Please enable tool_config.include_server_side_tool_invocations
//   to use Built-in tools with Function calling."
// - Gemini 2.x rejects the mix outright (400 "Built-in tools and Function
//   Calling cannot be combined"), so function tools must win and the built-in
//   tool is dropped from the request.
// - The flag only survives on the official endpoint. Third-party relays
//   (one-api/new-api style) re-serialize requests through their own structs
//   and silently drop the 2026-03 field before forwarding — verified live
//   against real relay deployments (2026-07): the mixed request still 400s
//   with the flag set. Vertex-style endpoints reject the field outright
//   ("Unknown name"). So mixing is enabled ONLY when talking directly to
//   generativelanguage.googleapis.com; everywhere else function tools win.
// - With the flag enabled, functionCallingConfig.mode AUTO is not supported;
//   the server default (VALIDATED) is the documented mode for mixed tool use.
// - Gemini 3 validates thoughtSignature echo-back on functionCall parts of
//   the current turn (400 "Function call is missing a thought_signature in
//   functionCall parts"). Signatures can be lost through model switches,
//   tool-call recovery, and compaction rebuilds; Google documents a sentinel
//   value that skips validation for exactly this situation.
// - Real signatures only verify against the serving context that minted
//   them. Relays rotate upstream channels per request, so echoing a real
//   signature through one intermittently fails with 400 "Corrupted thought
//   signature." — while the skip sentinel passed every rotation (measured
//   live, 2026-07). Hence: official endpoint echoes real signatures and only
//   fills gaps; relays always get the sentinel and never a real signature.
// ---------------------------------------------------------------------------

/** Documented by Google to bypass Gemini 3 thought-signature validation. */
export const GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

export function isGemini3PlusModelId(modelId: string): boolean {
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
  const match = normalized.match(/^gemini(?:-live)?-(\d+)/);
  if (match) return Number.parseInt(match[1], 10) >= 3;
  // Rolling aliases currently resolve to the Gemini 3 flash family.
  return normalized === "gemini-flash-latest" || normalized === "gemini-flash-lite-latest";
}

const GEMINI_BUILTIN_TOOL_KEYS = [
  "googleSearch",
  "google_search",
  "googleSearchRetrieval",
  "google_search_retrieval",
  "urlContext",
  "url_context",
  "codeExecution",
  "code_execution",
  "fileSearch",
  "file_search",
  "googleMaps",
  "google_maps",
  "computerUse",
  "computer_use",
] as const;

export function hasGeminiBuiltinServerSideTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  return GEMINI_BUILTIN_TOOL_KEYS.some((key) => Boolean(tool[key]));
}

function toolHasFunctionDeclarations(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  const declarations = tool.functionDeclarations ?? tool.function_declarations;
  return Array.isArray(declarations) && declarations.length > 0;
}

export function geminiToolsHaveFunctionDeclarations(tools: unknown): boolean {
  return Array.isArray(tools) && tools.some(toolHasFunctionDeclarations);
}

/**
 * True only for the Gemini Developer API endpoint itself. Relays and other
 * gateways cannot be trusted to forward the mixed-tools contract intact.
 */
export function isOfficialGeminiApiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    return new URL(baseUrl).hostname === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
}

/**
 * ToolConfig adjustment for a mixed built-in + function-declarations request.
 * Returns `null` when function calling is explicitly disabled (mode NONE) —
 * mixing is pointless there and the caller should skip the built-in tool.
 */
function normalizeGeminiMixedToolConfig(existing: unknown): Record<string, unknown> | null {
  const base = isRecord(existing) ? existing : {};
  const functionCallingConfig = isRecord(base.functionCallingConfig)
    ? base.functionCallingConfig
    : undefined;
  const mode =
    typeof functionCallingConfig?.mode === "string"
      ? functionCallingConfig.mode.toUpperCase()
      : undefined;
  if (mode === "NONE") return null;

  let nextFunctionCallingConfig = functionCallingConfig;
  if (functionCallingConfig && (mode === "AUTO" || mode === "MODE_UNSPECIFIED")) {
    const { mode: _dropped, ...rest } = functionCallingConfig;
    nextFunctionCallingConfig = Object.keys(rest).length > 0 ? rest : undefined;
  }

  const next: Record<string, unknown> = { ...base };
  delete next.functionCallingConfig;
  if (nextFunctionCallingConfig) {
    next.functionCallingConfig = nextFunctionCallingConfig;
  }
  next.includeServerSideToolInvocations = true;
  return next;
}

/**
 * Append `{ googleSearch: {} }` to a google-generative-ai payload, honoring
 * the per-model-family mixing rules above. No-op when any built-in tool is
 * already present, or when the model cannot mix it with function tools.
 */
export function appendGeminiGoogleSearchToolToPayload(
  payload: Record<string, unknown>,
  params: { modelId: string; baseUrl?: string },
): Record<string, unknown> {
  const config = isRecord(payload.config) ? payload.config : {};
  const tools = Array.isArray(config.tools) ? config.tools : [];
  if (tools.some(hasGeminiBuiltinServerSideTool)) return payload;

  if (!geminiToolsHaveFunctionDeclarations(tools)) {
    return {
      ...payload,
      config: {
        ...config,
        tools: [...tools, { googleSearch: {} }],
      },
    };
  }

  if (!isGemini3PlusModelId(params.modelId) || !isOfficialGeminiApiBaseUrl(params.baseUrl)) {
    return payload;
  }

  const toolConfig = normalizeGeminiMixedToolConfig(config.toolConfig);
  if (toolConfig === null) return payload;

  return {
    ...payload,
    config: {
      ...config,
      tools: [...tools, { googleSearch: {} }],
      toolConfig,
    },
  };
}

/**
 * Thought-signature policy for Gemini 3+ request history.
 *
 * Official endpoint: real signatures are same-infrastructure and must be
 * echoed byte-identical, so only *missing* functionCall signatures are filled
 * with the documented skip sentinel.
 *
 * Non-official endpoints (relays): signatures are minted per upstream serving
 * context, and relays rotate upstream channels per request — replaying a real
 * signature intermittently fails with 400 "Corrupted thought signature."
 * (verified live, 2026-07), while the skip sentinel passed every rotation.
 * So through relays every functionCall carries the sentinel (validation
 * demands one) and all other parts have their signature stripped.
 */
export function normalizeGeminiThoughtSignatures(
  payload: Record<string, unknown>,
  params: { modelId: string; baseUrl?: string },
): Record<string, unknown> {
  if (!isGemini3PlusModelId(params.modelId)) return payload;
  if (!Array.isArray(payload.contents)) return payload;
  const trustRealSignatures = isOfficialGeminiApiBaseUrl(params.baseUrl);

  let changed = false;
  const nextContents = payload.contents.map((item) => {
    if (!isRecord(item) || item.role !== "model" || !Array.isArray(item.parts)) return item;
    let turnChanged = false;
    const nextParts = item.parts.map((part) => {
      if (!isRecord(part)) return part;
      const signature = part.thoughtSignature;
      const hasSignature = typeof signature === "string" && signature.length > 0;

      if (isRecord(part.functionCall)) {
        if (
          hasSignature &&
          (trustRealSignatures || signature === GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL)
        ) {
          return part;
        }
        turnChanged = true;
        return { ...part, thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL };
      }

      if (!trustRealSignatures && hasSignature) {
        turnChanged = true;
        const { thoughtSignature: _stripped, ...rest } = part;
        return rest;
      }
      return part;
    });
    if (!turnChanged) return item;
    changed = true;
    return { ...item, parts: nextParts };
  });

  return changed ? { ...payload, contents: nextContents } : payload;
}

export function attachGeminiThoughtSignatureGuard(
  options: StreamOptionsEx,
  params: { providerId: string; baseUrl?: string },
): StreamOptionsEx {
  if (params.providerId !== "gemini") return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model: Model<any>) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      if (!isRecord(nextPayload) || model.api !== "google-generative-ai") {
        return nextPayload;
      }
      return normalizeGeminiThoughtSignatures(nextPayload, {
        modelId: model.id,
        baseUrl: params.baseUrl,
      });
    },
  };
}
