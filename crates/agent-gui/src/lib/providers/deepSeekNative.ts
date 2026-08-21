import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type OpenAIResponsesOptions,
  stream as streamOpenAIResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { createParser } from "eventsource-parser";
import { inlineDeepSeekLargePastes } from "./deepSeekAttachments";
import { resolveMaxTokens } from "./runtime/common";
import { clampOpenAIReasoningEffort } from "./runtime/thinkingLevels";
import type { StreamOptionsEx, ToolChoice } from "./runtime/types";

export const DEEPSEEK_RESPONSES_API = "deepseek-responses";

export type DeepSeekResponseState = {
  output: Record<string, unknown>[];
};

export type DeepSeekAssistantMessage = AssistantMessage & {
  deepSeekResponseState?: DeepSeekResponseState;
};

const OFFICIAL_DEEPSEEK_HOST = "api.deepseek.com";
const API_VERSION_SUFFIX_RE = /\/v\d+(?:beta)?$/i;

function stripEndpointSuffix(pathname: string) {
  const withoutTrailingSlash = pathname.replace(/\/+$/, "");
  return withoutTrailingSlash.replace(/\/(?:chat\/completions|responses?)$/i, "");
}

function hasApiVersionSuffix(pathname: string) {
  return API_VERSION_SUFFIX_RE.test(pathname);
}

export function isOfficialDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === OFFICIAL_DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

/**
 * Normalize a DeepSeek Responses SDK base URL.
 * Official api.deepseek.com stays at the root (no /v1). Relays without a
 * version segment get /v1 appended so one-api/new-api style gateways resolve.
 */
export function normalizeDeepSeekResponsesBaseUrl(
  baseUrl: string,
  options?: { officialHost?: boolean },
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    let pathname = stripEndpointSuffix(url.pathname);
    const official = options?.officialHost ?? url.hostname.toLowerCase() === OFFICIAL_DEEPSEEK_HOST;
    if (official) {
      pathname = pathname.replace(API_VERSION_SUFFIX_RE, "");
    } else if (!hasApiVersionSuffix(pathname)) {
      pathname = `${pathname}/v1`;
    }
    url.pathname = pathname || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

/** Convert a full endpoint URL to the corresponding DeepSeek /responses URL. */
export function normalizeDeepSeekResponsesEndpoint(endpoint: string): string {
  const normalizedBaseUrl = normalizeDeepSeekResponsesBaseUrl(endpoint);
  try {
    const url = new URL(normalizedBaseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
    return url.toString();
  } catch {
    return `${normalizedBaseUrl.replace(/\/+$/, "")}/responses`;
  }
}

function mapToolChoice(
  toolChoice: ToolChoice | undefined,
): OpenAIResponsesOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "any") return "required";
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return { type: "function", name: toolChoice.name };
}

function assertTextOnlyContext(context: Context) {
  for (const message of context.messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      if (message.content.some((block) => block.type === "image")) {
        throw new Error("DeepSeek Responses does not support image input.");
      }
    }
    if (message.role === "toolResult" && message.content.some((block) => block.type === "image")) {
      throw new Error("DeepSeek Responses does not support image tool results.");
    }
  }
}

function createErrorAssistant(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const DEEPSEEK_REPLAYABLE_OUTPUT_TYPES = new Set([
  "reasoning",
  "message",
  "function_call",
  "web_search_call",
]);

type DeepSeekResponseCapture = {
  outputByIndex: Map<number, Record<string, unknown>>;
  terminalOutput?: Record<string, unknown>[];
};

function toReplayableOutputItem(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !DEEPSEEK_REPLAYABLE_OUTPUT_TYPES.has(String(value.type))) {
    return undefined;
  }
  return value;
}

function captureDeepSeekResponseEvent(capture: DeepSeekResponseCapture, event: unknown) {
  if (!isRecord(event)) return;
  if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
    const item = toReplayableOutputItem(event.item);
    if (item && typeof event.output_index === "number") {
      capture.outputByIndex.set(event.output_index, item);
    }
  }
  if (
    (event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed") &&
    isRecord(event.response) &&
    Array.isArray(event.response.output)
  ) {
    capture.terminalOutput = event.response.output.flatMap((item) => {
      const replayable = toReplayableOutputItem(item);
      return replayable ? [replayable] : [];
    });
  }
}

async function captureDeepSeekResponse(response: Response, capture: DeepSeekResponseCapture) {
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent(event) {
      if (!event.data.trim() || event.data.trim() === "[DONE]") return;
      try {
        captureDeepSeekResponseEvent(capture, JSON.parse(event.data));
      } catch {
        // Response parsing remains owned by pi-ai; capture is best-effort state preservation.
      }
    },
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
  } catch {
    // A failed clone must not interfere with the actual provider stream.
  }
}

function capturedDeepSeekOutput(capture: DeepSeekResponseCapture) {
  return (
    capture.terminalOutput ??
    [...capture.outputByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item)
  );
}

function buildResponsesOptions(
  model: Model<Api>,
  options: StreamOptionsEx,
  fetch: typeof globalThis.fetch,
): OpenAIResponsesOptions {
  const reasoningEffort =
    options.deepSeekThinking === "disabled"
      ? undefined
      : clampOpenAIReasoningEffort(model, options.reasoning);
  return {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch,
    onPayload: options.onPayload,
    onResponse: options.onResponse,
    maxRetries: options.maxRetries,
    maxRetryDelayMs: options.maxRetryDelayMs,
    timeoutMs: options.timeoutMs,
    samplingParams: options.samplingParams,
    reasoningEffort,
    toolChoice: mapToolChoice(options.toolChoice),
  };
}

/**
 * DeepSeek's native Responses adapter. pi-ai owns OpenAI-compatible request and
 * SSE mechanics; this boundary adds DeepSeek attachment rules and preserves
 * server-side web_search_call items for stateless multi-turn replay.
 */
export function streamDeepSeekResponses(
  model: Model<Api>,
  context: Context,
  options: StreamOptionsEx,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    try {
      assertTextOnlyContext(context);
      const preparedContext = await inlineDeepSeekLargePastes(context, options.workdir);
      const responseCapture: DeepSeekResponseCapture = { outputByIndex: new Map() };
      const captureTasks: Promise<void>[] = [];
      const baseFetch = options.fetch ?? globalThis.fetch;
      const fetchWithStateCapture: typeof globalThis.fetch = async (input, init) => {
        const response = await baseFetch(input, init);
        const task = captureDeepSeekResponse(response, responseCapture);
        captureTasks.push(task);
        void task;
        return response;
      };
      const inner = streamOpenAIResponses(
        model as Model<"openai-responses">,
        preparedContext,
        buildResponsesOptions(model, options, fetchWithStateCapture),
      );

      for await (const event of inner) {
        if (event.type === "done") {
          await Promise.allSettled(captureTasks);
          const responseOutput = capturedDeepSeekOutput(responseCapture);
          if (responseOutput.some((item) => item.type === "web_search_call")) {
            (event.message as DeepSeekAssistantMessage).deepSeekResponseState = {
              output: responseOutput,
            };
          }
        }
        output.push(event as AssistantMessageEvent);
      }
    } catch (error) {
      const aborted = options.signal?.aborted === true;
      output.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: createErrorAssistant(model, error, aborted),
      });
    } finally {
      output.end();
    }
  })();

  return output;
}
