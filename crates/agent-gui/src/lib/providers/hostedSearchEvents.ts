import {
  type HostedSearchBlock,
  type HostedSearchSource,
  type HostedSearchStatus,
  mergeHostedSearchBlocks,
  normalizeHostedSearchStatus,
} from "../chat/messages/hostedSearch";
import type { ProviderId } from "../settings";
import { createUuid } from "../shared/id";

type HostedSearchUpdate = {
  id?: string;
  provider?: string;
  status?: HostedSearchStatus;
  queries?: string[];
  sources?: HostedSearchSource[];
};

type HostedSearchAggregator = {
  accept: (rawEvent: unknown) => void;
  complete: () => HostedSearchBlock[];
  fail: () => HostedSearchBlock[];
  dispose: () => HostedSearchBlock[];
  getBlocks: () => HostedSearchBlock[];
};

type FetchProbe = {
  providerId: ProviderId;
  sessionId?: string;
  requestId?: string;
  active: boolean;
  claimed: boolean;
  parseDone?: Promise<void>;
  onRawEvent: (event: unknown) => void;
};

type HostedSearchFetchProbeController = {
  finish: () => Promise<void>;
};

const activeFetchProbes = new Set<FetchProbe>();
let originalFetch: typeof globalThis.fetch | null = null;

export const HOSTED_SEARCH_PROBE_HEADER = "x-liveagent-hosted-search-probe";

export function createHostedSearchProbeId(providerId: ProviderId) {
  return `hosted-search-${providerId}-${createUuid()}`;
}

export function withHostedSearchProbeHeader(
  headers: Record<string, string> | undefined,
  requestId: string | undefined,
): Record<string, string> | undefined {
  if (!requestId) return headers;
  return {
    ...(headers ?? {}),
    [HOSTED_SEARCH_PROBE_HEADER]: requestId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function maybeParseJson(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeRequestBody(body: unknown): unknown {
  if (typeof body === "string") return maybeParseJson(body);
  if (body instanceof Uint8Array) {
    return maybeParseJson(new TextDecoder().decode(body));
  }
  return undefined;
}

function getRequestBody(input: RequestInfo | URL, init?: RequestInit): unknown {
  const initBody = normalizeRequestBody(init?.body);
  if (initBody !== undefined) return initBody;
  if (typeof Request !== "undefined" && input instanceof Request) {
    return normalizeRequestBody(input.body);
  }
  return undefined;
}

function getRequestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return "";
}

function readHeader(headers: HeadersInit | undefined, name: string) {
  if (!headers) return "";
  try {
    return new Headers(headers).get(name)?.trim() ?? "";
  } catch {
    return "";
  }
}

function getRequestHeader(input: RequestInfo | URL, init: RequestInit | undefined, name: string) {
  const initHeader = readHeader(init?.headers, name);
  if (initHeader) return initHeader;
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers.get(name)?.trim() ?? "";
  }
  return "";
}

function getProviderPath(providerId: ProviderId) {
  return `/proxy/${providerId}`;
}

function requestBodyMatchesProbe(probe: FetchProbe, body: unknown) {
  if (!probe.sessionId) return true;
  if (!isRecord(body)) return false;

  if (probe.providerId === "codex" || probe.providerId === "xai") {
    const promptCacheKey = readString(body.prompt_cache_key);
    // xAI Responses 会剥离 prompt_cache_key；有 requestId 头时已在上游匹配。
    if (!promptCacheKey && probe.providerId === "xai") return true;
    return promptCacheKey === probe.sessionId;
  }

  if (probe.providerId === "claude_code") {
    const metadata = isRecord(body.metadata) ? body.metadata : {};
    const userId = readString(metadata.user_id);
    return userId === probe.sessionId;
  }

  return false;
}

function isStreamLikeResponse(response: Response) {
  if (!response.body) return false;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    contentType.includes("event-stream") ||
    contentType.includes("stream") ||
    contentType.includes("json")
  );
}

function requestMatchesProbe(
  probe: FetchProbe,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
) {
  if (!probe.active || probe.claimed || !isStreamLikeResponse(response)) return false;
  const url = getRequestUrl(input);
  if (!url.includes(getProviderPath(probe.providerId))) return false;
  const requestId = getRequestHeader(input, init, HOSTED_SEARCH_PROBE_HEADER);
  if (probe.requestId) {
    if (requestId) return requestId === probe.requestId;
    if (probe.providerId === "gemini") return false;
  }
  return requestBodyMatchesProbe(probe, getRequestBody(input, init));
}

function installFetchProbe() {
  if (originalFetch || typeof globalThis.fetch !== "function") return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch!(input, init);
    const probe = [...activeFetchProbes].find((candidate) =>
      requestMatchesProbe(candidate, input, init, response),
    );
    if (probe) {
      probe.claimed = true;
      probe.parseDone = parseResponseClone(response, probe);
      void probe.parseDone;
    }
    return response;
  }) as typeof globalThis.fetch;
}

function uninstallFetchProbeIfIdle() {
  if (activeFetchProbes.size > 0 || !originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
}

function emitJsonCandidate(text: string, probe: FetchProbe) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "[DONE]") return;
  const parsed = maybeParseJson(trimmed);
  if (Array.isArray(parsed)) {
    parsed.forEach((item) => {
      probe.onRawEvent(item);
    });
    return;
  }
  if (parsed !== undefined) {
    probe.onRawEvent(parsed);
  }
}

function consumeTextBuffer(buffer: string, probe: FetchProbe, final = false): string {
  const lines = buffer.split(/\r?\n/g);
  const tail = final ? "" : (lines.pop() ?? "");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("data:")) {
      emitJsonCandidate(trimmed.slice(5), probe);
      continue;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      emitJsonCandidate(trimmed, probe);
    }
  }
  if (final && tail.trim()) {
    emitJsonCandidate(tail, probe);
  }
  return tail;
}

async function parseResponseClone(response: Response, probe: FetchProbe) {
  try {
    const clone = response.clone();
    const reader = clone.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeTextBuffer(buffer, probe);
    }
    buffer += decoder.decode();
    consumeTextBuffer(buffer, probe, true);
  } catch {
    // Search metadata is best-effort; never break the provider stream.
  }
}

export function startHostedSearchFetchProbe(params: {
  providerId: ProviderId;
  sessionId?: string;
  requestId?: string;
  enabled?: boolean;
  onRawEvent: (event: unknown) => void;
}): HostedSearchFetchProbeController {
  if (!params.enabled || typeof globalThis.fetch !== "function") {
    return { async finish() {} };
  }

  const probe: FetchProbe = {
    providerId: params.providerId,
    sessionId: params.sessionId,
    requestId: params.requestId,
    active: true,
    claimed: false,
    onRawEvent: params.onRawEvent,
  };
  activeFetchProbes.add(probe);
  installFetchProbe();

  return {
    async finish() {
      probe.active = false;
      activeFetchProbes.delete(probe);
      uninstallFetchProbeIfIdle();
      await probe.parseDone;
    },
  };
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Raw (untrimmed) string read, for accumulating JSON text fragments where whitespace is significant. */
function readRawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type SearchEventParser = {
  parse: (raw: unknown) => HostedSearchUpdate[];
};

// ---------------------------------------------------------------------------
// OpenAI Responses: web_search_call lifecycle events + url_citation annotations.
// Every event carries a complete, self-contained payload — no cross-event state.
// xAI (api.x.ai) reuses the same wire shape but reports server-side search via
// its own item types: x_search_call(_output) items, plus custom_tool_call items
// named x_keyword_search / x_semantic_search. Result sources arrive on
// action.sources when the request includes web_search_call.action.sources.
// ---------------------------------------------------------------------------

function mapOpenAIWebSearchCallStatus(rawStatus: string, isDoneEvent: boolean): HostedSearchStatus {
  const normalized = rawStatus.toLowerCase();
  if (/fail|error|cancel/.test(normalized)) return "failed";
  if (/complete|completed|done|succeeded|finished/.test(normalized)) return "completed";
  return isDoneEvent ? "completed" : "searching";
}

function extractResponsesSourceList(raw: unknown): HostedSearchSource[] {
  if (!Array.isArray(raw)) return [];
  const sources: HostedSearchSource[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const url = entry.trim();
      if (url && isHttpUrl(url)) sources.push({ url, sourceType: "source" });
      continue;
    }
    if (!isRecord(entry)) continue;
    const url = readString(entry.url ?? entry.uri);
    if (!url || !isHttpUrl(url)) continue;
    const title = readString(entry.title);
    sources.push({ url, ...(title ? { title } : {}), sourceType: "source" });
  }
  return sources;
}

function isXaiSearchCallItemType(itemType: string) {
  return itemType === "x_search_call" || itemType === "x_search_call_output";
}

function isXaiCustomSearchToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return normalized === "x_keyword_search" || normalized === "x_semantic_search";
}

function readXaiCustomSearchQuery(item: Record<string, unknown>) {
  const raw = readRawString(item.input) || readRawString(item.arguments);
  const parsed = maybeParseJson(raw);
  return isRecord(parsed) ? readString(parsed.query) : "";
}

const RESPONSES_SEARCH_CALL_LIFECYCLE_PREFIXES = [
  "response.web_search_call.",
  "response.x_search_call.",
] as const;

function parseOpenAIResponsesSearchEvent(raw: unknown): HostedSearchUpdate[] {
  if (!isRecord(raw)) return [];
  const type = readString(raw.type);

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = isRecord(raw.item) ? raw.item : {};
    const itemType = readString(item.type);
    const isDoneEvent = type.endsWith(".done");

    if (itemType === "web_search_call" || isXaiSearchCallItemType(itemType)) {
      const action = isRecord(item.action) ? item.action : {};
      const query = readString(action.query);
      const id =
        readString(item.id) || readString(item.call_id) || readString(item.x_search_call_id);
      return [
        {
          ...(id ? { id } : {}),
          provider: "codex",
          status: mapOpenAIWebSearchCallStatus(
            readString(item.status),
            isDoneEvent || itemType.endsWith("_output"),
          ),
          queries: query ? [query] : [],
          sources: [
            ...extractResponsesSourceList(action.sources),
            ...extractResponsesSourceList(item.sources),
          ],
        },
      ];
    }

    if (itemType === "custom_tool_call" && isXaiCustomSearchToolName(readString(item.name))) {
      const query = readXaiCustomSearchQuery(item);
      const id = readString(item.id) || readString(item.call_id) || readString(item.item_id);
      return [
        {
          ...(id ? { id } : {}),
          provider: "codex",
          status: mapOpenAIWebSearchCallStatus(readString(item.status), isDoneEvent),
          queries: query ? [query] : [],
          sources: [],
        },
      ];
    }

    return [];
  }

  // Defensive coverage for the dedicated response.web_search_call.* /
  // response.x_search_call.* lifecycle events (in_progress/searching/completed)
  // some OpenAI-compatible gateways emit alongside (or instead of) output_item
  // add/done.
  const lifecyclePrefix = RESPONSES_SEARCH_CALL_LIFECYCLE_PREFIXES.find((prefix) =>
    type.startsWith(prefix),
  );
  if (lifecyclePrefix) {
    const suffix = type.slice(lifecyclePrefix.length).toLowerCase();
    const id = readString(raw.item_id) || readString(raw.output_item_id);
    return [
      {
        ...(id ? { id } : {}),
        provider: "codex",
        status: /fail|error|cancel/.test(suffix)
          ? "failed"
          : /complete|completed|done/.test(suffix)
            ? "completed"
            : "searching",
        queries: [],
        sources: [],
      },
    ];
  }

  if (type === "response.output_text.annotation.added") {
    const annotation = isRecord(raw.annotation) ? raw.annotation : {};
    if (readString(annotation.type) !== "url_citation") return [];
    const url = readString(annotation.url ?? annotation.uri);
    if (!url || !isHttpUrl(url)) return [];
    const title = readString(annotation.title);
    return [
      {
        provider: "codex",
        status: "completed",
        queries: [],
        sources: [{ url, ...(title ? { title } : {}), sourceType: "citation" }],
      },
    ];
  }

  return [];
}

function createOpenAIResponsesSearchEventParser(): SearchEventParser {
  return { parse: parseOpenAIResponsesSearchEvent };
}

// ---------------------------------------------------------------------------
// Anthropic Messages: server_tool_use (web_search) content blocks are stateful —
// the query is either given whole on content_block_start, or streamed in as
// input_json_delta.partial_json fragments keyed by content_block.index that
// only become valid JSON once fully accumulated. Web search results arrive
// whole on content_block_start; citations arrive via citations_delta on text
// blocks and are associated with the most recently active search by the
// aggregator's own last-id fallback (they carry no search id of their own).
// ---------------------------------------------------------------------------

type AnthropicSearchBlockState = {
  toolId: string;
  jsonBuffer: string;
  lastQuery: string;
};

function tryExtractAnthropicQuery(jsonBuffer: string): string {
  const parsed = maybeParseJson(jsonBuffer);
  return isRecord(parsed) ? readString(parsed.query) : "";
}

function extractAnthropicResultSources(content: unknown): HostedSearchSource[] {
  if (!Array.isArray(content)) return [];
  const sources: HostedSearchSource[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const url = readString(item.url);
    if (!url || !isHttpUrl(url)) continue;
    const title = readString(item.title);
    sources.push({ url, ...(title ? { title } : {}), sourceType: "source" });
  }
  return sources;
}

function createAnthropicSearchEventParser(): SearchEventParser {
  const searchBlocksByIndex = new Map<number, AnthropicSearchBlockState>();

  function parseContentBlockStart(raw: Record<string, unknown>): HostedSearchUpdate[] {
    const index = typeof raw.index === "number" ? raw.index : -1;
    const block = isRecord(raw.content_block) ? raw.content_block : {};
    const blockType = readString(block.type);
    const name = readString(block.name).toLowerCase();

    if (blockType === "server_tool_use" && name === "web_search") {
      const toolId = readString(block.id);
      const state: AnthropicSearchBlockState = { toolId, jsonBuffer: "", lastQuery: "" };
      searchBlocksByIndex.set(index, state);

      const query = isRecord(block.input) ? readString(block.input.query) : "";
      if (!query) return [];
      state.lastQuery = query;
      return [
        {
          ...(toolId ? { id: toolId } : {}),
          provider: "claude_code",
          status: "searching",
          queries: [query],
          sources: [],
        },
      ];
    }

    if (blockType === "web_search_tool_result" || blockType === "web_search_tool_result_error") {
      const toolUseId = readString(block.tool_use_id);
      return [
        {
          ...(toolUseId ? { id: toolUseId } : {}),
          provider: "claude_code",
          status: blockType === "web_search_tool_result_error" ? "failed" : "completed",
          queries: [],
          sources: extractAnthropicResultSources(block.content),
        },
      ];
    }

    return [];
  }

  function parseContentBlockDelta(raw: Record<string, unknown>): HostedSearchUpdate[] {
    const index = typeof raw.index === "number" ? raw.index : -1;
    const delta = isRecord(raw.delta) ? raw.delta : {};
    const deltaType = readString(delta.type);

    if (deltaType === "input_json_delta") {
      const state = searchBlocksByIndex.get(index);
      if (!state) return [];
      state.jsonBuffer += readRawString(delta.partial_json);
      const query = tryExtractAnthropicQuery(state.jsonBuffer);
      if (!query || query === state.lastQuery) return [];
      state.lastQuery = query;
      return [
        {
          ...(state.toolId ? { id: state.toolId } : {}),
          provider: "claude_code",
          status: "searching",
          queries: [query],
          sources: [],
        },
      ];
    }

    if (deltaType === "citations_delta") {
      const citation = isRecord(delta.citation) ? delta.citation : {};
      const url = readString(citation.url);
      if (!url || !isHttpUrl(url)) return [];
      const title = readString(citation.title);
      return [
        {
          provider: "claude_code",
          status: "completed",
          queries: [],
          sources: [{ url, ...(title ? { title } : {}), sourceType: "citation" }],
        },
      ];
    }

    return [];
  }

  function parse(raw: unknown): HostedSearchUpdate[] {
    if (!isRecord(raw)) return [];
    const type = readString(raw.type);

    if (type === "content_block_start") return parseContentBlockStart(raw);
    if (type === "content_block_delta") return parseContentBlockDelta(raw);
    if (type === "content_block_stop") {
      const index = typeof raw.index === "number" ? raw.index : -1;
      searchBlocksByIndex.delete(index);
      return [];
    }

    return [];
  }

  return { parse };
}

// ---------------------------------------------------------------------------
// Gemini: grounding metadata arrives whole on each candidate — no lifecycle
// events, no search id. A chunk means results are in; a query alone means the
// search is still running.
// ---------------------------------------------------------------------------

function parseGeminiSearchEvent(raw: unknown): HostedSearchUpdate[] {
  if (!isRecord(raw)) return [];
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const queries: string[] = [];
  const sources: HostedSearchSource[] = [];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const grounding = isRecord(candidate.groundingMetadata) ? candidate.groundingMetadata : {};

    if (Array.isArray(grounding.webSearchQueries)) {
      for (const query of grounding.webSearchQueries) {
        const text = readString(query);
        if (text && !queries.includes(text)) queries.push(text);
      }
    }

    if (Array.isArray(grounding.groundingChunks)) {
      for (const chunk of grounding.groundingChunks) {
        if (!isRecord(chunk)) continue;
        const web = isRecord(chunk.web) ? chunk.web : {};
        const url = readString(web.uri ?? web.url);
        if (!url || !isHttpUrl(url)) continue;
        const title = readString(web.title);
        sources.push({ url, ...(title ? { title } : {}), sourceType: "source" });
      }
    }
  }

  if (queries.length === 0 && sources.length === 0) return [];
  return [
    {
      provider: "gemini",
      status: sources.length > 0 ? "completed" : "searching",
      queries,
      sources,
    },
  ];
}

function createGeminiSearchEventParser(): SearchEventParser {
  return { parse: parseGeminiSearchEvent };
}

function createHostedSearchEventParser(providerId: ProviderId): SearchEventParser {
  if (providerId === "codex" || providerId === "xai") {
    return createOpenAIResponsesSearchEventParser();
  }
  if (providerId === "claude_code") return createAnthropicSearchEventParser();
  if (providerId === "gemini") return createGeminiSearchEventParser();
  return { parse: () => [] };
}

export function createHostedSearchEventAggregator(params: {
  providerId: ProviderId;
  onHostedSearch?: (block: HostedSearchBlock) => void;
}): HostedSearchAggregator {
  const blocksById = new Map<string, HostedSearchBlock>();
  const signaturesById = new Map<string, string>();
  const fallbackId = `hosted-search-${params.providerId}`;
  let lastId = fallbackId;
  const parser = createHostedSearchEventParser(params.providerId);

  const blockSignature = (block: HostedSearchBlock) =>
    safeStringify({
      type: block.type,
      id: block.id,
      provider: block.provider,
      status: block.status,
      queries: block.queries,
      sources: block.sources,
    });

  const publish = (block: HostedSearchBlock) => {
    const signature = blockSignature(block);
    if (signaturesById.get(block.id) === signature) return block;
    blocksById.set(block.id, block);
    signaturesById.set(block.id, signature);
    params.onHostedSearch?.(block);
    return block;
  };

  const emit = (update: HostedSearchUpdate) => {
    const derivedId =
      update.id?.trim() ||
      (update.queries?.length
        ? `hosted-search-${params.providerId}-${stableHash(update.queries.join("|"))}`
        : lastId);
    lastId = derivedId;
    const incoming: HostedSearchBlock = {
      type: "hostedSearch",
      id: derivedId,
      provider: update.provider ?? params.providerId,
      status: normalizeHostedSearchStatus(update.status),
      queries: update.queries ?? [],
      sources: update.sources ?? [],
      updatedAt: Date.now(),
    };
    const merged = mergeHostedSearchBlocks(blocksById.get(derivedId), incoming);
    publish(merged);
  };

  const finalize = (status: HostedSearchStatus | null, emitUpdates: boolean) => {
    const out: HostedSearchBlock[] = [];
    for (const block of blocksById.values()) {
      const next =
        status && block.status === "searching"
          ? { ...block, status, updatedAt: Date.now() }
          : block;
      if (emitUpdates) {
        publish(next);
      } else {
        blocksById.set(next.id, next);
      }
      out.push(next);
    }
    return out;
  };

  return {
    accept(rawEvent) {
      for (const update of parser.parse(rawEvent)) emit(update);
    },
    complete() {
      return finalize("completed", true);
    },
    fail() {
      return finalize("failed", true);
    },
    dispose() {
      return finalize(null, false);
    },
    getBlocks() {
      return [...blocksById.values()];
    },
  };
}
