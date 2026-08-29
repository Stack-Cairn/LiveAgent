import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type StopReason,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import type { OpenAIResponsesOptions } from "@earendil-works/pi-ai/api/openai-responses";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { installCodexWebSocketProxy } from "./codexWebSocketProxy";
import type { StreamTransportFallbackInfo, StreamTransportFallbackReason } from "./types";

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const MIN_OUTPUT_TOKENS = 16;
const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

/**
 * CPA(CLIProxyAPI) 在这两个关闭码上有明确约定，源码注释写明客户端应据此决策：
 * 1009 = 单帧超出上游体积上限；1012 + "upstream requires HTTP replay" = 需改走 HTTP。
 * 两者都必须回退 SSE，但原因不同，UI 要能区分。
 */
const WEBSOCKET_CLOSE_MESSAGE_TOO_BIG = 1009;
const WEBSOCKET_CLOSE_SERVICE_RESTART = 1012;

type WebSocketConstructor = new (
  url: string | URL,
  options?: { headers?: Record<string, string> } | string | string[],
) => WebSocket;

type TransportFailure = Error & {
  transportFailure?: boolean;
  fallbackReason?: StreamTransportFallbackReason;
};

/**
 * pi-ai 的 d.ts 从 `openai` 包引用 Responses 事件类型，但本仓库没有装 `openai`
 * （两个 tsconfig 都开了 skipLibCheck，所以 pi-ai 自身不报错，我们显式 import 才会
 * TS2307）。这里从 processResponsesStream 的形参反推，既不新增依赖，将来 `openai`
 * 类型可用时也自动跟上。
 */
type ResponsesStreamSource = Parameters<typeof processResponsesStream>[0];
type CpaResponseStreamEvent =
  ResponsesStreamSource extends AsyncIterable<infer TEvent> ? TEvent : never;

/** Responses 请求体只被 JSON.stringify 后发出，键名以 wire 格式为准。 */
type ResponseBody = Record<string, unknown> & { model: string; stream: true };

/**
 * `Model<Api>` 会把 compat 塌成四个协议 compat 的联合，Responses 专属能力位读不到。
 * CPA 通路只在 openai-responses 下进入，故收窄集中在这一处，其余调用点保持类型安全。
 */
type ResponsesCompat = NonNullable<Model<"openai-responses">["compat"]>;

function responsesCompat(model: Model<Api>): ResponsesCompat | undefined {
  return model.compat as ResponsesCompat | undefined;
}

/** done 事件只接受非终止性的 stopReason，aborted/error 必须走 error 事件。 */
type DoneStopReason = Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;

function toDoneStopReason(stopReason: StopReason): DoneStopReason | undefined {
  return stopReason === "stop" ||
    stopReason === "length" ||
    stopReason === "toolUse" ||
    stopReason === "deferred"
    ? stopReason
    : undefined;
}

type CpaResponsesWebSocketOptions = OpenAIResponsesOptions & {
  onTransportFallback?: (info: StreamTransportFallbackInfo) => void;
};

function headerValue(
  headers: Record<string, string | null> | undefined,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  const entry = Object.entries(headers ?? {}).find(
    ([key, value]) => key.toLowerCase() === expected && value !== null && value.trim().length > 0,
  );
  return entry?.[1] ?? undefined;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
  headers[name] = value;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
}

/** Resolve a local proxy URL to the explicit Responses WebSocket route. */
export function resolveCpaResponsesWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.toLowerCase().endsWith("/responses")) {
    url.pathname = `${pathname || ""}/responses`;
  } else {
    url.pathname = pathname;
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("CPA Responses WebSocket URL must use http(s) or ws(s)");
  }
  return url.toString();
}

function buildWebSocketHeaders(options: CpaResponsesWebSocketOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== null) headers[name] = value;
  }

  // CPA uses ordinary API-key Bearer auth. Never infer ChatGPT account semantics
  // and never place credentials in the websocket URL or handshake payload body.
  setHeader(headers, "Authorization", `Bearer ${options.apiKey ?? ""}`);
  setHeader(headers, "Originator", headerValue(options.headers, "Originator") ?? "Codex Desktop");
  const requestId =
    headerValue(options.headers, "X-Client-Request-Id") ??
    headerValue(options.headers, "Session-Id") ??
    options.sessionId ??
    crypto.randomUUID();
  setHeader(headers, "Session-Id", requestId);
  setHeader(headers, "X-Client-Request-Id", requestId);
  setHeader(headers, "OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  deleteHeader(headers, "accept");
  deleteHeader(headers, "content-type");
  return headers;
}

function buildRequestBody(
  model: Model<Api>,
  context: Context,
  options: CpaResponsesWebSocketOptions,
): ResponseBody {
  const compat = responsesCompat(model);
  const supportsStrictMode = compat?.supportsStrictMode ?? false;
  const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools ?? false;
  const grammarToolInputProperties = createGrammarToolInputProperties(
    context.tools,
    supportsOpenAIGrammarTools,
  );
  const input = convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS, {
    grammarToolInputProperties,
    toolOptions: {
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    },
  });
  const body: ResponseBody = {
    model: model.id,
    input,
    stream: true,
    store: false,
  };
  const cacheRetention = options.cacheRetention ?? "short";
  if (cacheRetention !== "none" && options.sessionId) {
    body.prompt_cache_key = options.sessionId;
  }
  if (cacheRetention === "long" && compat?.supportsLongCacheRetention !== false) {
    body.prompt_cache_retention = "24h";
  }
  if (options.maxTokens !== undefined) {
    body.max_output_tokens = Math.max(options.maxTokens, MIN_OUTPUT_TOKENS);
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
  if (context.tools?.length) {
    body.tools = convertResponsesTools(context.tools, {
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    });
  }
  if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
  if (model.reasoning && options.reasoningEffort) {
    const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    body.reasoning = {
      effort,
      summary: options.reasoningSummary ?? "auto",
    };
    body.include = ["reasoning.encrypted_content"];
  } else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
    body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
  }
  if (options.samplingParams) Object.assign(body, options.samplingParams);
  return body;
}

function createTransportFailure(
  message: string,
  transportFailure: boolean,
  fallbackReason?: StreamTransportFallbackReason,
): TransportFailure {
  const error = new Error(message) as TransportFailure;
  error.transportFailure = transportFailure;
  if (fallbackReason) error.fallbackReason = fallbackReason;
  return error;
}

function socketError(): TransportFailure {
  return createTransportFailure(
    "CPA Responses WebSocket connection failed",
    true,
    "handshake-failed",
  );
}

function protocolError(): TransportFailure {
  return createTransportFailure("CPA Responses WebSocket returned an invalid response", false);
}

/**
 * 把上游关闭码翻译为回退语义。1009/1012 是 CPA 明确定义的可回退信号，其余非正常
 * 关闭一律按「首个内容前流中断」处理；正常关闭（1000/1005）不构成 transport failure。
 */
function closeEventFailure(event: CloseEvent): TransportFailure {
  if (event.code === WEBSOCKET_CLOSE_MESSAGE_TOO_BIG) {
    return createTransportFailure(
      "CPA closed the WebSocket because a frame exceeded the upstream size limit",
      true,
      "message-too-big",
    );
  }
  if (event.code === WEBSOCKET_CLOSE_SERVICE_RESTART) {
    return createTransportFailure(
      "CPA requires replaying this turn over HTTP",
      true,
      "upstream-replay-required",
    );
  }
  return createTransportFailure(
    "CPA Responses WebSocket ended before any content arrived",
    true,
    "stream-incomplete",
  );
}

function normalizeResponseEvent(event: CpaResponseStreamEvent): CpaResponseStreamEvent {
  const candidate = event as { type?: string; response?: Record<string, unknown> };
  if (candidate.type !== "response.done" && candidate.type !== "response.incomplete") return event;
  return {
    ...candidate,
    type: "response.completed",
    response: {
      ...candidate.response,
      status:
        candidate.response?.status ??
        (candidate.type === "response.incomplete" ? "incomplete" : "completed"),
    },
  } as CpaResponseStreamEvent;
}

async function connectWebSocket(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<WebSocket> {
  installCodexWebSocketProxy();
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!WebSocketCtor) throw socketError();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket?.removeEventListener("open", onOpen);
      socket?.removeEventListener("error", onError);
      socket?.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: TransportFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket?.close();
      } catch {
        // Ignore close failures while rejecting the connection.
      }
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = () => fail(socketError());
    const onClose = () => fail(socketError());
    const onAbort = () => fail(createTransportFailure("Request was aborted", false));
    try {
      socket = new WebSocketCtor(url, { headers });
    } catch {
      fail(socketError());
      return;
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => fail(socketError()), timeoutMs);
    }
    if (signal?.aborted) onAbort();
  });
}

async function* receiveWebSocketEvents(
  socket: WebSocket,
  signal: AbortSignal | undefined,
): AsyncGenerator<CpaResponseStreamEvent> {
  const queue: CpaResponseStreamEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let completionSeen = false;
  let failure: TransportFailure | undefined;
  const onMessage = (event: MessageEvent) => {
    void (async () => {
      try {
        const data = event.data;
        const text =
          typeof data === "string"
            ? data
            : data instanceof ArrayBuffer
              ? new TextDecoder().decode(data)
              : ArrayBuffer.isView(data)
                ? new TextDecoder().decode(data)
                : data && typeof data.arrayBuffer === "function"
                  ? new TextDecoder().decode(new Uint8Array(await data.arrayBuffer()))
                  : undefined;
        if (!text) throw protocolError();
        // CPA 用 "[DONE]" 作为流终止哨兵，它不是 JSON，必须先短路掉。
        if (text.trim() === "[DONE]") {
          completionSeen = true;
          closed = true;
          wake?.();
          wake = undefined;
          return;
        }
        const parsed = JSON.parse(text) as { type?: string };
        if (parsed.type === "error" || parsed.type === "response.failed") {
          failure = createTransportFailure("CPA Responses WebSocket request failed", false);
          closed = true;
        } else {
          const normalized = normalizeResponseEvent(parsed as CpaResponseStreamEvent);
          if ((normalized as { type?: string }).type === "response.completed") {
            completionSeen = true;
          }
          queue.push(normalized);
          if (completionSeen) closed = true;
        }
      } catch (error) {
        failure =
          error instanceof Error && "transportFailure" in error
            ? (error as TransportFailure)
            : protocolError();
        closed = true;
      }
      wake?.();
      wake = undefined;
    })();
  };
  const onError = () => {
    failure ??= socketError();
    closed = true;
    wake?.();
    wake = undefined;
  };
  const onClose = (event: Event) => {
    // 关闭码带的是上游意图（1009 帧超限 / 1012 需 HTTP 重放），必须据此分类而不是
    // 一律按连接失败处理，否则 UI 无法解释为什么回退。
    if (!completionSeen) failure ??= closeEventFailure(event as CloseEvent);
    closed = true;
    wake?.();
    wake = undefined;
  };
  const onAbort = () => {
    failure ??= createTransportFailure("Request was aborted", false);
    closed = true;
    wake?.();
    wake = undefined;
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift() as CpaResponseStreamEvent;
        continue;
      }
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (failure) throw failure;
    if (!completionSeen) throw socketError();
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function buildAssistantOutput(model: Model<Api>): AssistantMessage {
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
  } as AssistantMessage;
}

async function pumpStream(
  source: AssistantMessageEventStream,
  target: AssistantMessageEventStream,
) {
  for await (const event of source) target.push(event);
  target.end(await source.result());
}

/**
 * CPA-compatible generic Responses WebSocket transport. It deliberately does
 * not use pi-ai's ChatGPT Codex adapter: CPA accepts ordinary Bearer keys and
 * serves the Responses protocol at /v1/responses rather than /codex/responses.
 */
export function streamCpaResponsesWithFallback(
  model: Model<Api>,
  context: Context,
  options: CpaResponsesWebSocketOptions,
  sseFactory: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const outputStream = createAssistantMessageEventStream();
  void (async () => {
    const output = buildAssistantOutput(model);
    let started = false;
    let socket: WebSocket | undefined;
    try {
      const body = buildRequestBody(model, context, options);
      const nextBody = await options.onPayload?.(body, model);
      const requestBody = (nextBody ?? body) as ResponseBody;
      const wsUrl = resolveCpaResponsesWebSocketUrl(model.baseUrl);
      const headers = buildWebSocketHeaders(options);
      socket = await connectWebSocket(
        wsUrl,
        headers,
        options.signal,
        options.websocketConnectTimeoutMs,
      );
      await options.onResponse?.({ status: 101, headers: {} }, model);
      socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
      const events = (async function* () {
        for await (const event of receiveWebSocketEvents(socket as WebSocket, options.signal)) {
          if (!started) {
            started = true;
            outputStream.push({ type: "start", partial: output });
          }
          yield event;
        }
      })();
      await processResponsesStream(events, output, outputStream, model, {
        serviceTier: options.serviceTier,
        grammarToolInputProperties: createGrammarToolInputProperties(
          context.tools,
          responsesCompat(model)?.supportsOpenAIGrammarTools ?? false,
        ),
      });
      if (output.stopReason === "pending") {
        throw createTransportFailure(
          "CPA Responses WebSocket ended without a completed response",
          false,
        );
      }
      // done 只承载非终止性 stopReason；aborted/error 属于失败语义，必须走 error 事件，
      // 否则下游会把一次失败当成正常收尾。
      const doneReason = toDoneStopReason(output.stopReason);
      if (doneReason) {
        outputStream.push({ type: "done", reason: doneReason, message: output });
      } else {
        outputStream.push({
          type: "error",
          reason: output.stopReason === "aborted" ? "aborted" : "error",
          error: output,
        });
      }
      outputStream.end(output);
    } catch (error) {
      const failure =
        error instanceof Error && "transportFailure" in error
          ? (error as TransportFailure)
          : createTransportFailure("CPA Responses WebSocket request failed", false);
      if (!started && failure.transportFailure && !options.signal?.aborted) {
        // 只暴露我们自己构造的分类原因，不把上游响应体或凭证带进 UI / 轨迹诊断。
        const info: StreamTransportFallbackInfo = {
          from: "websocket",
          to: "sse",
          reason: failure.fallbackReason ?? "handshake-failed",
          errorMessage: failure.message,
        };
        try {
          options.onTransportFallback?.(info);
        } catch (observerError) {
          console.warn(
            "CPA WebSocket fallback observer failed; continuing with SSE",
            observerError,
          );
        }
        await pumpStream(sseFactory(), outputStream);
        return;
      }
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = options.signal?.aborted
        ? "Request was aborted"
        : "CPA Responses WebSocket request failed";
      outputStream.push({ type: "error", reason: output.stopReason, error: output });
      outputStream.end(output);
    } finally {
      // 每轮一条连接：CPA 的会话是连接级的（passthroughSessionID per connection），
      // 成功路径若不关闭，连接会挂到 CPA 侧超时才回收，同时占着它的执行会话与上游
      // WebSocket。必须在 finally 收口，成功与失败路径一视同仁。
      try {
        socket?.close();
      } catch {
        // Ignore close failures during transport cleanup.
      }
    }
  })().catch((error) => {
    const fallback = buildAssistantOutput(model);
    fallback.stopReason = "error";
    fallback.errorMessage = "CPA Responses WebSocket request failed";
    outputStream.push({ type: "error", reason: "error", error: fallback });
    outputStream.end(fallback);
    console.warn("CPA WebSocket stream pump failed", error);
  });
  return outputStream;
}
