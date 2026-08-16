import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  parseStreamingJson,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { createParser, type ParseError } from "eventsource-parser";
import { inlineDeepSeekLargePastes } from "./deepSeekAttachments";
import { resolveMaxTokens } from "./runtime/common";
import type { StreamOptionsEx, ToolChoice } from "./runtime/types";

export const DEEPSEEK_CHAT_COMPLETIONS_API = "deepseek-chat-completions";

const DEEPSEEK_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEEPSEEK_SSE_BUFFER_LIMIT = 1024 * 1024;

type DeepSeekModel = Model<Api> & {
  deepSeekThinkingAlwaysOn?: boolean;
};

type DeepSeekWireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

type DeepSeekWireToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

type DeepSeekWireRequest = {
  model: string;
  messages: DeepSeekWireMessage[];
  stream: true;
  stream_options: { include_usage: true };
  thinking: { type: "enabled" | "disabled" };
  reasoning_effort?: "high" | "max";
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: DeepSeekWireToolChoice;
  temperature?: number;
  max_tokens?: number;
};

type DeepSeekWireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

type DeepSeekWireToolCallDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type DeepSeekWireChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekWireToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: DeepSeekWireUsage | null;
};

type StreamingToolCall = ToolCall & {
  partialArguments: string;
  wireIndex: number;
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: string }).type === "image") {
      throw new Error("The DeepSeek chat-completions adapter does not support image content.");
    }
    if ((block as { type?: string }).type === "text") {
      text += String((block as { text?: unknown }).text ?? "");
    }
  }
  return text;
}

export function serializeDeepSeekMessages(context: Context): DeepSeekWireMessage[] {
  const messages: DeepSeekWireMessage[] = [];
  if (context.systemPrompt !== undefined) {
    messages.push({ role: "system", content: context.systemPrompt });
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textFromContent(message.content) });
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: textFromContent(message.content) || "(no output)",
      });
      continue;
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const reasoning = message.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");
    const toolCalls = message.content
      .filter((block) => block.type === "toolCall")
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.arguments),
        },
      }));
    messages.push({
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 && reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return messages;
}

function mapToolChoice(toolChoice: ToolChoice | undefined): DeepSeekWireToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "any") return "required";
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return { type: "function", function: { name: toolChoice.name } };
}

function resolveThinking(model: DeepSeekModel, options: StreamOptionsEx) {
  if (options.deepSeekThinking === "disabled") {
    return { thinking: { type: "disabled" as const } };
  }
  const reasoning = options.reasoning;
  if (reasoning !== undefined) {
    const reasoningEffort: "high" | "max" =
      reasoning === "max" || reasoning === "xhigh" ? "max" : "high";
    return {
      thinking: { type: "enabled" as const },
      reasoning_effort: reasoningEffort,
    };
  }
  if (model.deepSeekThinkingAlwaysOn) {
    return {
      thinking: { type: "enabled" as const },
      reasoning_effort: "high" as const,
    };
  }
  return { thinking: { type: "disabled" as const } };
}

export function serializeDeepSeekRequest(
  model: DeepSeekModel,
  context: Context,
  options: StreamOptionsEx,
): DeepSeekWireRequest {
  const tools = context.tools?.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
  const toolChoice = tools?.length ? mapToolChoice(options.toolChoice) : undefined;
  return {
    model: model.id,
    messages: serializeDeepSeekMessages(context),
    stream: true,
    stream_options: { include_usage: true },
    ...resolveThinking(model, options),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    max_tokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
  };
}

function createEmptyAssistant(model: DeepSeekModel): AssistantMessage {
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
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function mapUsage(usage: DeepSeekWireUsage): AssistantMessage["usage"] {
  const promptTokens = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const cacheRead =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const input = Math.max(0, promptTokens - cacheRead);
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning: usage.completion_tokens_details?.reasoning_tokens,
    totalTokens: input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapFinishReason(reason: string | undefined): AssistantMessage["stopReason"] {
  if (reason === undefined || reason === "stop") return "stop";
  if (reason === "tool_calls") return "toolUse";
  if (reason === "length") return "length";
  throw new Error(`DeepSeek model stopped with unsupported finish reason: ${reason}`);
}

function buildEndpoint(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.toLowerCase().endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

/**
 * DeepSeek 生态的 chat-completions 挂在 /v1 下。官方域名对裸路径有意兼容
 * （/chat/completions 与 /v1/chat/completions 都通），但 one-api/new-api 系
 * 中转只认 /v1——裸域名的 /chat/completions 会被前置 SPA 以 200+HTML 兜底，
 * SSE 解析零事件后报出误导性的 "ended without [DONE]"。与 codex 的
 * maybeAppendCodexApiVersion 同约定：已带版本段或完整端点路径的配置原样
 * 保留，其余补 /v1。
 */
export function normalizeDeepSeekBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(pathname) || /\/v\d+(?:beta)?$/i.test(pathname)) {
      return trimmed;
    }
    url.pathname = `${pathname}/v1`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

function buildHeaders(model: DeepSeekModel, options: StreamOptionsEx) {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
  for (const [key, value] of Object.entries(model.headers ?? {})) headers.set(key, value);
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return headers;
}

async function providerErrorMessage(response: Response) {
  const text = await response.text().catch(() => "");
  let detail = text.trim();
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") detail = body.error.message.trim();
  } catch {}
  return detail
    ? `DeepSeek API error (HTTP ${response.status}): ${detail}`
    : `DeepSeek API error (HTTP ${response.status})`;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function streamDeepSeekNative(
  model: DeepSeekModel,
  context: Context,
  options: StreamOptionsEx,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = createEmptyAssistant(model);

  void (async () => {
    const idleController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, idleController.signal])
      : idleController.signal;
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        idleController.abort(new Error("DeepSeek stream idle timeout"));
      }, DEEPSEEK_STREAM_IDLE_TIMEOUT_MS);
    };

    try {
      const preparedContext = await inlineDeepSeekLargePastes(context, options.workdir);
      let payload: unknown = serializeDeepSeekRequest(model, preparedContext, options);
      const replacement = await options.onPayload?.(payload, model);
      if (replacement !== undefined) payload = replacement;

      armIdleTimer();
      const response = await (options.fetch ?? globalThis.fetch)(buildEndpoint(model.baseUrl), {
        method: "POST",
        headers: buildHeaders(model, options),
        body: JSON.stringify(payload),
        signal,
      });
      armIdleTimer();
      await options.onResponse?.(
        { status: response.status, headers: responseHeaders(response.headers) },
        model,
      );
      if (!response.ok) throw new Error(await providerErrorMessage(response));
      if (!response.body) throw new Error("DeepSeek API returned no response body");
      // one-api/new-api 系中转把未命中的 API 路径交给前置 SPA 以 200+HTML 兜底；
      // HTML 喂进 SSE 解析器是零事件，最终只会报出误导性的 "ended without
      // [DONE]"。凡带明确非流 content-type 的 200 响应都在这里 fail fast，把
      // 真实载荷片段带进错误信息。
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType && !contentType.includes("event-stream")) {
        const snippet = (await response.text().catch(() => "")).trim().slice(0, 200);
        throw new Error(
          `DeepSeek endpoint returned "${contentType.split(";")[0].trim()}" instead of an SSE stream — check that the Base URL points to a DeepSeek chat-completions API${
            snippet ? `. Response: ${snippet}` : ""
          }`,
        );
      }

      stream.push({ type: "start", partial: output });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const eventQueue: string[] = [];
      let parserError: ParseError | undefined;
      const parser = createParser({
        maxBufferSize: DEEPSEEK_SSE_BUFFER_LIMIT,
        onEvent: (event) => eventQueue.push(event.data),
        onError: (error) => {
          // SSE 规范要求忽略未知字段（部分中转会夹带非标准字段行），只有缓冲
          // 超限才是必须终止流的硬错误——与 harness 的 EventSourceParserStream
          // 默认忽略语义对齐。
          if (error.type === "max-buffer-size-exceeded") parserError = error;
        },
      });
      let sawDone = false;
      let finishReason: string | undefined;
      let textBlock: Extract<AssistantMessage["content"][number], { type: "text" }> | undefined;
      let thinkingBlock:
        | Extract<AssistantMessage["content"][number], { type: "thinking" }>
        | undefined;
      const toolCalls = new Map<number, StreamingToolCall>();

      const contentIndex = (block: AssistantMessage["content"][number]) =>
        output.content.indexOf(block);
      const ensureTextBlock = () => {
        if (!textBlock) {
          textBlock = { type: "text", text: "" };
          output.content.push(textBlock);
          stream.push({
            type: "text_start",
            contentIndex: contentIndex(textBlock),
            partial: output,
          });
        }
        return textBlock;
      };
      const ensureThinkingBlock = () => {
        if (!thinkingBlock) {
          thinkingBlock = { type: "thinking", thinking: "" };
          output.content.push(thinkingBlock);
          stream.push({
            type: "thinking_start",
            contentIndex: contentIndex(thinkingBlock),
            partial: output,
          });
        }
        return thinkingBlock;
      };
      const ensureToolCall = (delta: DeepSeekWireToolCallDelta) => {
        const wireIndex = typeof delta.index === "number" ? delta.index : 0;
        let block = toolCalls.get(wireIndex);
        if (!block) {
          block = {
            type: "toolCall",
            id: delta.id ?? "",
            name: delta.function?.name ?? "",
            arguments: {},
            partialArguments: "",
            wireIndex,
          };
          toolCalls.set(wireIndex, block);
          output.content.push(block);
          stream.push({
            type: "toolcall_start",
            contentIndex: contentIndex(block),
            partial: output,
          });
        }
        if (delta.id) block.id = delta.id;
        if (delta.function?.name) block.name = delta.function.name;
        return block;
      };

      while (!sawDone) {
        armIdleTimer();
        const { value, done } = await reader.read();
        if (done) break;
        armIdleTimer();
        parser.feed(decoder.decode(value, { stream: true }));
        if (parserError) throw parserError;

        for (const data of eventQueue.splice(0)) {
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }
          let chunk: DeepSeekWireChunk;
          try {
            chunk = JSON.parse(data) as DeepSeekWireChunk;
          } catch {
            throw new Error(`Malformed DeepSeek SSE payload: ${data.slice(0, 120)}`);
          }
          output.responseId ||= chunk.id;
          if (chunk.model && chunk.model !== model.id) output.responseModel ||= chunk.model;
          if (chunk.usage) output.usage = mapUsage(chunk.usage);
          for (const choice of chunk.choices ?? []) {
            if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
            const reasoning = choice.delta?.reasoning_content;
            if (typeof reasoning === "string" && reasoning.length > 0) {
              const block = ensureThinkingBlock();
              block.thinking += reasoning;
              stream.push({
                type: "thinking_delta",
                contentIndex: contentIndex(block),
                delta: reasoning,
                partial: output,
              });
            }
            const content = choice.delta?.content;
            if (typeof content === "string" && content.length > 0) {
              const block = ensureTextBlock();
              block.text += content;
              stream.push({
                type: "text_delta",
                contentIndex: contentIndex(block),
                delta: content,
                partial: output,
              });
            }
            for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
              const block = ensureToolCall(toolCallDelta);
              const fragment = toolCallDelta.function?.arguments ?? "";
              block.partialArguments += fragment;
              block.arguments = parseStreamingJson(block.partialArguments);
              stream.push({
                type: "toolcall_delta",
                contentIndex: contentIndex(block),
                delta: fragment,
                partial: output,
              });
            }
          }
        }
      }

      if (!sawDone) throw new Error("DeepSeek SSE stream ended without [DONE]");
      await reader.cancel().catch(() => undefined);
      if (output.content.length === 0) {
        throw new Error("DeepSeek model returned a completed response with no content");
      }
      output.stopReason = mapFinishReason(finishReason);
      output.rawStopReason = finishReason;
      for (const [contentIndex, block] of output.content.entries()) {
        if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex,
            content: block.text,
            partial: output,
          });
        } else if (block.type === "toolCall") {
          delete (block as Partial<StreamingToolCall>).partialArguments;
          delete (block as Partial<StreamingToolCall>).wireIndex;
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall: block,
            partial: output,
          });
        }
      }
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end(output);
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = idleTimedOut
        ? `DeepSeek stream idle timeout after ${DEEPSEEK_STREAM_IDLE_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end(output);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      idleController.abort();
    }
  })();

  return stream;
}
