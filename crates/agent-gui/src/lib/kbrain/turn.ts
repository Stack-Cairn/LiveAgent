import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@liveagent/app/lib/agentTypes";
import type { HostedSearchBlock } from "@liveagent/ui/lib/chat/hostedSearch";
import type { ConversationViewState } from "../chat/conversation/conversationState";
import { appendMessagesToConversation } from "../chat/conversation/conversationState";
import { createKBrainClient } from "./client";
import { getKBrainSessionId, setKBrainSessionId } from "./mapping";
import { questionResultDetails } from "./questions";
import { getConfiguredKBrainConnection } from "./runtimeConnection";
import type {
  KBrainClientToolRequest,
  KBrainClientToolResult,
  KBrainContentBlock,
  KBrainEvent,
  KBrainHostedSearch,
  KBrainMessage,
  KBrainModelRef,
  KBrainQuestionAnswer,
  KBrainQuestionRequest,
  KBrainRunOptions,
  KBrainSubagent,
  KBrainToolCall,
  KBrainToolResult,
} from "./types";

type CanonicalInputPart = {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  filename?: string;
  url?: string;
};

function imageDataUri(data: string, mimeType: string): string {
  return /^(data:|https?:\/\/)/.test(data) ? data : `data:${mimeType};base64,${data}`;
}

function canonicalContent(content: string | readonly CanonicalInputPart[]): KBrainContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const blocks: KBrainContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
    else if (part.type === "thinking" && part.thinking)
      blocks.push({ type: "thinking", text: part.thinking });
    else if (part.type === "image" && (part.data || part.url) && part.mimeType) {
      blocks.push({
        type: "image",
        image_url: part.url ?? imageDataUri(part.data ?? "", part.mimeType),
        mime_type: part.mimeType,
      });
    } else if (part.type === "file" && (part.data || part.url) && part.mimeType) {
      blocks.push({
        type: "file",
        file_url: part.url ?? imageDataUri(part.data ?? "", part.mimeType),
        ...(part.filename ? { filename: part.filename } : {}),
        mime_type: part.mimeType,
      });
    }
  }
  return blocks;
}

function isSyntheticSubagentId(id: string) {
  return id.startsWith("kbrain-subagent:");
}

function canonicalMessage(message: Message): KBrainMessage | null {
  if (message.role === "user") {
    const id = (message as Message & { id?: unknown }).id;
    return {
      role: "user",
      content: canonicalContent(message.content as readonly CanonicalInputPart[]),
      ...(typeof id === "string" && id.trim() ? { id: id.trim() } : {}),
    };
  }
  if (message.role === "assistant") {
    const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
    return {
      role: "assistant",
      content: canonicalContent(
        message.content.flatMap((part): CanonicalInputPart[] => {
          if (part.type === "text") return [{ type: "text", text: part.text }];
          if (part.type === "thinking") return [{ type: "thinking", thinking: part.thinking }];
          return [];
        }),
      ),
      tool_calls: toolCalls
        .filter((call) => !isSyntheticSubagentId(call.id) && call.name !== "subagent")
        .map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      model: message.model,
      provider: message.provider,
      stop_reason: message.stopReason,
    };
  }
  if (isSyntheticSubagentId(message.toolCallId)) return null;
  return {
    role: "tool",
    content: canonicalContent(message.content as unknown as readonly CanonicalInputPart[]),
    tool_call_id: message.toolCallId,
    name: message.toolName,
  };
}

export function contextToKBrainMessages(context: Context): KBrainMessage[] {
  const messages: KBrainMessage[] = [];
  if (context.systemPrompt?.trim())
    messages.push({
      role: "system",
      content: [{ type: "text", text: context.systemPrompt }],
    });
  for (const message of context.messages) {
    const canonical = canonicalMessage(message);
    if (canonical) messages.push(canonical);
  }
  return messages;
}

export type KBrainTurnParams = {
  conversationId: string;
  sessionId: string;
  cwd?: string;
  model: KBrainModelRef;
  prompt: string;
  context: Context;
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
  onThinkingDelta: (text: string) => void;
  onHostedSearch?: (search: KBrainHostedSearch) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (call: ToolCall, result: ToolResultMessage) => void;
  onSubagent?: (subagent: KBrainSubagent) => void;
  onStatus?: (status: string | null) => void;
  content?: KBrainContentBlock[];
  onQuestionRequest?: (
    request: KBrainQuestionRequest,
    signal?: AbortSignal,
  ) => Promise<KBrainQuestionAnswer[]>;
  /** Executes a desktop tool K-brain delegated to this client (see options.client_tools). */
  onClientToolRequest?: (
    request: KBrainClientToolRequest,
    signal?: AbortSignal,
  ) => Promise<KBrainClientToolResult>;
  onPermissionRequest?: (
    request: {
      permission_id: string;
      tool: string;
      command?: string;
      description?: string;
    },
    signal?: AbortSignal,
  ) => Promise<"allow_once" | "allow_always" | "reject">;
  applyConversationState?: (state: ConversationViewState) => void;
  getConversationState?: () => ConversationViewState;
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  clientRequestId?: string;
  turnId?: string;
  resumeMessageId?: string;
  options?: KBrainRunOptions;
  hook_policy?: "backend";
  hook_scope_id?: string;
};

const api = "kbrain.agent.v1" as AssistantMessage["api"];
const maxReconnects = 3;

function usage(message?: KBrainMessage): AssistantMessage["usage"] {
  const value = message?.usage;
  const input = value?.input_tokens ?? 0;
  const output = value?.output_tokens ?? 0;
  const cacheRead = value?.cached_tokens ?? 0;
  const cacheWrite = value?.cache_write_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toolCall(call: KBrainToolCall): ToolCall {
  return {
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: (call.arguments ?? {}) as Record<string, unknown>,
  };
}

function toolResult(result: KBrainToolResult): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: result.id,
    toolName: result.name ?? "tool",
    content: [{ type: "text", text: result.output }],
    details: questionResultDetails(result.name, result.output),
    isError: result.failed === true || result.cancelled === true,
    timestamp: Date.now(),
  };
}

function finalContent(
  message: KBrainMessage | undefined,
  text: string,
  thinking: string,
  calls: Map<string, ToolCall>,
): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];
  for (const block of message?.content ?? []) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    else if (block.type === "thinking" && block.text)
      content.push({ type: "thinking", thinking: block.text });
  }
  for (const search of message?.hosted_search ?? []) {
    content.push({
      type: "hostedSearch",
      id: search.id,
      provider: search.provider,
      status: search.status,
      queries: search.queries,
      sources: search.sources,
    } as HostedSearchBlock);
  }
  for (const call of message?.tool_calls ?? []) content.push(toolCall(call));
  const hasThinking = content.some(
    (block) => block.type === "thinking" && block.thinking === thinking,
  );
  const finalText = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (thinking && !hasThinking) content.unshift({ type: "thinking", thinking });
  if (text && text !== finalText) {
    const precedingText =
      finalText && text.endsWith(finalText) ? text.slice(0, -finalText.length) : text;
    content.unshift({ type: "text", text: precedingText });
  }
  const knownCalls = new Set(
    content.filter((block): block is ToolCall => block.type === "toolCall").map((call) => call.id),
  );
  for (const call of calls.values()) if (!knownCalls.has(call.id)) content.push(call);
  return content;
}

function eventPayload<T>(event: KBrainEvent): T | undefined {
  return event.payload as T | undefined;
}

function abortError(): Error {
  return new Error("K-brain turn aborted");
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function waitForReconnect(attempt: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      Math.min(1000 * 2 ** (attempt - 1), 4000),
    );
    signal.addEventListener("abort", abort, { once: true });
  });
}

function legacySessionId(
  conversationId: string,
  baseUrl: string | undefined,
  hostSessionId: string,
): string | undefined {
  const normalizedBaseUrl = (baseUrl ?? "http://127.0.0.1:47321").trim().replace(/\/+$/, "");
  const keys = [
    `kbrain-session:${conversationId}`,
    `kbrain-session:${encodeURIComponent(normalizedBaseUrl)}:${encodeURIComponent(hostSessionId)}:${encodeURIComponent(conversationId)}`,
  ];
  try {
    for (const key of keys) {
      const value = globalThis.localStorage?.getItem(key)?.trim();
      if (value) return value;
    }
  } catch {
    // Storage is optional; a missing mapping is recovered by creating a session.
  }
  return undefined;
}

function lastUserContent(context: Context): KBrainContentBlock[] {
  const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
  return lastUser ? (contextToKBrainMessages({ messages: [lastUser] })[0]?.content ?? []) : [];
}

function isSameContent(left: readonly KBrainContentBlock[], right: readonly KBrainContentBlock[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCurrentPromptMessage(
  message: KBrainMessage,
  prompt: string,
  content: readonly KBrainContentBlock[],
) {
  if (message.role !== "user") return false;
  const text = (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const nonText = (message.content ?? []).filter((block) => block.type !== "text");
  return text === prompt && isSameContent(nonText, content);
}

function canonicalPromptContent(params: KBrainTurnParams): KBrainContentBlock[] {
  const content = params.content ?? lastUserContent(params.context);
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  if (params.content && text !== params.prompt) return content;
  if (!params.content && text !== params.prompt) return [];
  // The textual prompt is sent separately; content carries only multimodal blocks.
  return content.filter((block) => block.type !== "text");
}

function fallbackRequestId(params: KBrainTurnParams) {
  return `liveagent-${params.sessionId}-${params.conversationId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function runKBrainTurn(params: KBrainTurnParams): Promise<AssistantMessage> {
  const runtimeConnection = getConfiguredKBrainConnection();
  const baseUrl = params.baseUrl ?? runtimeConnection?.baseUrl;
  const token = params.token ?? runtimeConnection?.token;
  const client = createKBrainClient({
    baseUrl,
    token,
    fetch: params.fetch,
  });
  const model = params.model;
  const promptContent = canonicalPromptContent(params);
  const tail = params.context.messages.at(-1) as
    | (Message & { id?: string; kbrainEditPending?: boolean })
    | undefined;
  let resumeMessageId =
    params.resumeMessageId?.trim() ||
    (tail?.role === "user" && tail.kbrainEditPending === true ? tail.id : undefined);
  let kbrainSessionId =
    getKBrainSessionId(params.conversationId, baseUrl) ??
    legacySessionId(params.conversationId, baseUrl, params.sessionId) ??
    "";
  const createSession = async () => {
    resumeMessageId = undefined;
    const history = contextToKBrainMessages(params.context);
    const last = history.at(-1);
    if (last && isCurrentPromptMessage(last, params.prompt, promptContent)) history.pop();
    const created = await client.createSession({
      cwd: params.cwd,
      model,
      messages: history,
    });
    setKBrainSessionId(params.conversationId, created.id, baseUrl);
    return created.id;
  };
  throwIfAborted(params.signal);
  if (!kbrainSessionId) kbrainSessionId = await createSession();
  throwIfAborted(params.signal);
  const clientRequestId = params.clientRequestId ?? fallbackRequestId(params);
  const startRun = () =>
    client.startRun({
      conversation_id: kbrainSessionId,
      client_request_id: clientRequestId,
      ...(params.turnId ? { turn_id: params.turnId } : {}),
      prompt: params.prompt,
      ...(promptContent.length ? { content: promptContent } : {}),
      model,
      ...(params.options ? { options: params.options } : {}),
      ...(params.hook_policy ? { hook_policy: params.hook_policy } : {}),
      ...(params.hook_scope_id ? { hook_scope_id: params.hook_scope_id } : {}),
      ...(resumeMessageId ? { resume_message_id: resumeMessageId } : {}),
    });
  let accepted: Awaited<ReturnType<typeof client.startRun>>;
  try {
    accepted = await startRun();
  } catch (error) {
    if ((error as { status?: number }).status !== 404 || !kbrainSessionId) throw error;
    kbrainSessionId = await createSession();
    accepted = await startRun();
  }
  if (params.signal.aborted) {
    await client.cancelRun(kbrainSessionId, accepted.run_id).catch(() => undefined);
    throw abortError();
  }
  if (accepted.conversation_id !== kbrainSessionId || !accepted.run_id) {
    throw new Error("K-brain returned an invalid run identity");
  }

  let text = "";
  let thinking = "";
  let finalMessage: KBrainMessage | undefined;
  const calls = new Map<string, ToolCall>();
  let afterSeq = accepted.accepted_seq;
  let terminal: "stop" | "error" | "aborted" = "stop";
  let errorMessage: string | undefined;
  let sawTerminal = false;
  let permissionFailure: Error | undefined;
  const pendingPermissions = new Set<AbortController>();
  const pendingQuestions = new Map<string, AbortController>();
  const pendingClientTools = new Map<string, AbortController>();
  // Never cleared: replayed events after a reconnect must not run the same action twice.
  const handledClientTools = new Set<string>();
  const streamAbortController = new AbortController();
  const cancelPendingPermissions = () => {
    for (const controller of pendingPermissions) controller.abort();
    pendingPermissions.clear();
    for (const controller of pendingQuestions.values()) controller.abort();
    pendingQuestions.clear();
    for (const controller of pendingClientTools.values()) controller.abort();
    pendingClientTools.clear();
  };
  const abortStream = () => streamAbortController.abort();
  params.signal.addEventListener("abort", abortStream, { once: true });

  const onEvent = (event: KBrainEvent) => {
    if (event.conversation_id !== kbrainSessionId) {
      throw new Error("K-brain event identity mismatch");
    }
    if (!Number.isInteger(event.seq) || event.seq <= afterSeq) return;
    if (event.seq !== afterSeq + 1)
      throw new Error(`K-brain event sequence gap: expected ${afterSeq + 1}, got ${event.seq}`);
    afterSeq = event.seq;
    // Session streams can include background tasks started by an earlier run.
    if (event.run_id !== accepted.run_id && !event.type.startsWith("subagent.")) return;
    switch (event.type) {
      case "assistant.text.delta": {
        const delta = eventPayload<{ text?: string }>(event)?.text ?? "";
        if (delta) {
          text += delta;
          params.onTextDelta(delta);
        }
        break;
      }
      case "assistant.thinking.delta": {
        const delta = eventPayload<{ text?: string }>(event)?.text ?? "";
        if (delta) {
          thinking += delta;
          params.onThinkingDelta(delta);
        }
        break;
      }
      case "assistant.sources": {
        const search = eventPayload<KBrainHostedSearch>(event);
        if (search?.type === "hostedSearch" && search.id) params.onHostedSearch?.(search);
        break;
      }
      case "tool.call": {
        const payload = eventPayload<{ tool_call?: KBrainToolCall }>(event);
        if (!payload?.tool_call) break;
        const call = toolCall(payload.tool_call);
        calls.set(call.id, call);
        params.onToolCall(call);
        break;
      }
      case "tool.result": {
        const payload = eventPayload<{ tool_result?: KBrainToolResult }>(event);
        if (!payload?.tool_result) break;
        const result = toolResult(payload.tool_result);
        const call = calls.get(result.toolCallId) ?? {
          type: "toolCall",
          id: result.toolCallId,
          name: result.toolName,
          arguments: {},
        };
        params.onToolResult(call, result);
        break;
      }
      case "assistant.message.created":
        finalMessage = eventPayload<KBrainMessage>(event);
        break;
      case "subagent.started":
      case "subagent.updated":
      case "subagent.completed":
      case "subagent.failed": {
        const payload = eventPayload<KBrainSubagent | { subagent?: KBrainSubagent }>(event);
        const subagent =
          payload && typeof payload === "object" && "subagent" in payload
            ? payload.subagent
            : payload;
        if (subagent && typeof subagent === "object" && "id" in subagent && "model" in subagent) {
          params.onSubagent?.(subagent as KBrainSubagent);
        }
        break;
      }
      case "tool.status": {
        const payload = eventPayload<{
          status?: string | null;
          text?: string | null;
        }>(event);
        params.onStatus?.(payload?.status ?? payload?.text ?? null);
        break;
      }
      case "question.requested": {
        const request = eventPayload<KBrainQuestionRequest>(event);
        const onQuestionRequest = params.onQuestionRequest;
        if (!request || !onQuestionRequest) {
          permissionFailure = new Error(
            "K-brain requested a question but no question callback is configured",
          );
          streamAbortController.abort();
          return;
        }
        params.onStatus?.("Waiting for your answer…");
        const questionController = new AbortController();
        if (request.run_id !== accepted.run_id || !request.question_id || !request.tool_call_id)
          throw new Error("Question identity mismatch");
        if (pendingQuestions.has(request.question_id)) break;
        const call: ToolCall = {
          type: "toolCall",
          id: request.tool_call_id,
          name: "AskUserQuestion",
          arguments: {
            questions: request.questions,
            __askUserQuestionDeadlineAt: request.deadline_at,
          },
        };
        calls.set(call.id, call);
        params.onToolCall(call);
        pendingQuestions.set(request.question_id, questionController);
        void Promise.resolve()
          .then(() => onQuestionRequest(request, questionController.signal))
          .then((answers) => {
            if (questionController.signal.aborted) return;
            return client.resolveQuestion(
              kbrainSessionId,
              request.question_id,
              accepted.run_id,
              answers,
            );
          })
          .catch((error) => {
            if (questionController.signal.aborted) return;
            permissionFailure = error instanceof Error ? error : new Error(String(error));
            params.onStatus?.(null);
            streamAbortController.abort();
          })
          .finally(() => pendingQuestions.delete(request.question_id));
        break;
      }
      case "question.resolved": {
        const resolution = eventPayload<{
          question_id: string;
          tool_call_id: string;
          run_id: string;
        }>(event);
        if (resolution) {
          if (resolution.run_id !== accepted.run_id || !resolution.tool_call_id)
            throw new Error("Question resolution identity mismatch");
          pendingQuestions.get(resolution.question_id)?.abort();
          pendingQuestions.delete(resolution.question_id);
          const call = calls.get(resolution.tool_call_id);
          if (call)
            params.onToolResult(
              call,
              toolResult({
                id: call.id,
                name: "AskUserQuestion",
                output: JSON.stringify(resolution),
              }),
            );
        }
        params.onStatus?.(null);
        break;
      }
      case "client_tool.requested": {
        const request = eventPayload<KBrainClientToolRequest>(event);
        if (!request?.call_id || request.run_id !== accepted.run_id) break;
        if (handledClientTools.has(request.call_id)) break;
        handledClientTools.add(request.call_id);
        const controller = new AbortController();
        pendingClientTools.set(request.call_id, controller);
        const execute = params.onClientToolRequest;
        void Promise.resolve()
          .then((): Promise<KBrainClientToolResult> | KBrainClientToolResult =>
            execute
              ? execute(request, controller.signal)
              : { text: `${request.tool} is not available in this client.`, is_error: true },
          )
          .catch(
            (error: unknown): KBrainClientToolResult => ({
              text: `${request.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            }),
          )
          .then((result) => {
            if (controller.signal.aborted) return;
            return client.resolveClientTool(
              kbrainSessionId,
              request.call_id,
              accepted.run_id,
              result,
            );
          })
          // A late post (call already settled by timeout or cancel) gets 409; K-brain has
          // already handed the model a result, so there is nothing left to do here.
          .catch(() => undefined)
          .finally(() => pendingClientTools.delete(request.call_id));
        break;
      }
      case "client_tool.resolved": {
        const resolution = eventPayload<{ call_id?: string }>(event);
        if (resolution?.call_id) {
          handledClientTools.add(resolution.call_id);
          pendingClientTools.get(resolution.call_id)?.abort();
          pendingClientTools.delete(resolution.call_id);
        }
        break;
      }
      case "permission.requested": {
        params.onStatus?.("Waiting for permission…");
        const request = eventPayload<{
          permission_id: string;
          tool: string;
          command?: string;
          description?: string;
        }>(event);
        if (!request || !params.onPermissionRequest) {
          permissionFailure = new Error(
            "K-brain requested permission but no permission callback is configured",
          );
          streamAbortController.abort();
          return;
        }
        const permissionController = new AbortController();
        pendingPermissions.add(permissionController);
        let decisionPromise: Promise<"allow_once" | "allow_always" | "reject">;
        try {
          decisionPromise = Promise.resolve(
            params.onPermissionRequest(request, permissionController.signal),
          );
        } catch (error) {
          decisionPromise = Promise.reject(error);
        }
        void decisionPromise
          .then((decision) => {
            if (permissionController.signal.aborted) return;
            return client.resolvePermission(
              kbrainSessionId,
              request.permission_id,
              decision,
              accepted.run_id,
            );
          })
          .catch((error) => {
            if (
              permissionController.signal.aborted &&
              (sawTerminal || streamAbortController.signal.aborted)
            )
              return;
            permissionFailure = error instanceof Error ? error : new Error(String(error));
            params.onStatus?.(null);
            streamAbortController.abort();
          })
          .finally(() => pendingPermissions.delete(permissionController));
        break;
      }
      case "permission.resolved":
        params.onStatus?.(null);
        break;
      case "run.failed":
        terminal = "error";
        errorMessage = eventPayload<{ error?: string }>(event)?.error ?? "K-brain run failed";
        sawTerminal = true;
        streamAbortController.abort();
        cancelPendingPermissions();
        break;
      case "run.cancelled":
        terminal = "aborted";
        sawTerminal = true;
        streamAbortController.abort();
        cancelPendingPermissions();
        break;
      case "run.completed":
        terminal = "stop";
        sawTerminal = true;
        streamAbortController.abort();
        cancelPendingPermissions();
        break;
    }
  };

  try {
    let reconnects = 0;
    while (!sawTerminal) {
      throwIfAborted(params.signal);
      if (reconnects > 0) {
        params.onStatus?.("Reconnecting to K-brain…");
        await waitForReconnect(reconnects, params.signal);
      }
      try {
        await client.subscribe(
          kbrainSessionId,
          afterSeq,
          { onEvent },
          streamAbortController.signal,
        );
        if (!sawTerminal) {
          if (reconnects >= maxReconnects)
            throw new Error("K-brain event stream ended before the run reached a terminal event");
          reconnects += 1;
        }
      } catch (error) {
        if (params.signal.aborted) throw error;
        if (permissionFailure) throw permissionFailure;
        if (sawTerminal) break;
        if (reconnects >= maxReconnects) throw error;
        reconnects += 1;
      }
      if (permissionFailure) throw permissionFailure;
    }
  } catch (error) {
    terminal = params.signal.aborted ? "aborted" : "error";
    errorMessage = error instanceof Error ? error.message : String(error);
    streamAbortController.abort();
    cancelPendingPermissions();
    await client.cancelRun(kbrainSessionId, accepted.run_id).catch(() => undefined);
  }
  if (sawTerminal) cancelPendingPermissions();
  params.signal.removeEventListener("abort", abortStream);

  if (!sawTerminal && terminal === "stop") {
    terminal = "error";
    errorMessage ??= "K-brain run ended without a terminal event";
  }
  if (terminal === "stop" && !finalMessage && !text && !thinking && calls.size === 0) {
    terminal = "error";
    errorMessage ??= "K-brain run completed without an assistant message";
  }

  let content = finalContent(finalMessage, text, thinking, calls);
  if (terminal === "stop" && content.length === 0) {
    terminal = "error";
    errorMessage ??= "K-brain run completed without an assistant result";
  }
  if (content.length === 0 && (terminal === "error" || terminal === "aborted")) {
    content = [
      {
        type: "text",
        text:
          errorMessage ?? (terminal === "aborted" ? "K-brain turn aborted" : "K-brain run failed"),
      },
    ];
  }

  const message: AssistantMessage = {
    role: "assistant",
    content,
    api,
    provider: finalMessage?.provider ?? params.model.provider,
    model: finalMessage?.model ?? params.model.model,
    responseId: finalMessage?.id,
    ...(finalMessage?.id ? { id: finalMessage.id } : {}),
    usage: usage(finalMessage),
    stopReason: terminal,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
  if (params.applyConversationState && params.getConversationState) {
    params.applyConversationState(
      appendMessagesToConversation(params.getConversationState(), [message]),
    );
  }
  return message;
}
