import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@liveagent/app/lib/agentTypes";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import {
  ASK_USER_QUESTION_DEADLINE_ARG,
  ASK_USER_QUESTION_TOOL_NAME,
  KBRAIN_QUESTION_TOOL_NAME,
  TOOL_QUESTION_ARG,
} from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  type HostedSearchBlock,
  normalizeHostedSearchBlock,
} from "@liveagent/ui/lib/chat/hostedSearch";
import {
  MCP_ELICITATION_SYNTHETIC_ARG_PREFIX,
  type McpElicitationAction,
  type McpElicitationContent,
  type McpElicitationRecord,
  type McpElicitationRequest,
  type McpElicitationSubmitOutcome,
  parseMcpElicitationRecord,
  parseMcpElicitationRequest,
  withMcpElicitationDetails,
} from "@liveagent/ui/lib/chat/mcpElicitation";
import {
  encodeRunProgress,
  parseRunProgress,
  type RunProgress,
} from "@liveagent/ui/lib/chat/runProgress";
import { taskResultDetails } from "@liveagent/ui/lib/chat/taskProgress";
import { withToolRunInfo } from "@liveagent/ui/lib/chat/toolRunInfo";
import type { Locale } from "../../i18n/config";
import type { ConversationViewState } from "../chat/conversation/conversationState";
import { appendMessagesToConversation } from "../chat/conversation/conversationState";
import { createKBrainClient } from "./client";
import { hookWarningNotice, parseHookWarning } from "./hookWarning";
import { getKBrainSessionId, setKBrainSessionId } from "./mapping";
import {
  KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG,
  kbrainToolResultName,
  normalizeKBrainQuestionToolCall,
  originalKBrainToolCall,
  questionResultDetails,
} from "./questions";
import { aiReviewTitle, localizeAIReviewReason } from "./reviewNotice";
import { isSubagentEventType } from "./subagentEvents";
import { displayImageResultDetails, kbrainToolImages } from "./toolImages";
import type {
  KBrainClientToolRequest,
  KBrainClientToolResult,
  KBrainContentBlock,
  KBrainEvent,
  KBrainGoalState,
  KBrainHostedSearch,
  KBrainMessage,
  KBrainModelRef,
  KBrainQuestionAnswer,
  KBrainQuestionRequest,
  KBrainRunOptions,
  KBrainSubagent,
  KBrainToolCall,
  KBrainToolResult,
  KBrainUsage,
} from "./types";
import { hasKBrainUsage, kbrainUsage } from "./usage";

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

// The live transcript shows MCP forms through synthetic arguments; they are not the
// model's and never go back to K-brain.
function withoutElicitationArgs(args: ToolCall["arguments"]): ToolCall["arguments"] {
  if (
    !args ||
    !Object.keys(args).some((key) => key.startsWith(MCP_ELICITATION_SYNTHETIC_ARG_PREFIX))
  ) {
    return args;
  }
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !key.startsWith(MCP_ELICITATION_SYNTHETIC_ARG_PREFIX)),
  );
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
          arguments: withoutElicitationArgs(call.arguments),
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
  // K-brain `question` calls show as AskUserQuestion; send them back under their own name.
  const renamed = new Set<string>();
  for (const message of context.messages) {
    const canonical = canonicalMessage(message);
    if (!canonical) continue;
    for (const call of canonical.tool_calls ?? []) {
      const original = originalKBrainToolCall(call as Pick<ToolCall, "name" | "arguments">);
      if (original.name === call.name) continue;
      call.name = original.name;
      call.arguments = original.arguments;
      renamed.add(call.id);
    }
    if (canonical.role === "tool" && renamed.has(canonical.tool_call_id ?? "")) {
      canonical.name = KBRAIN_QUESTION_TOOL_NAME;
    }
    messages.push(canonical);
  }
  return messages;
}

/** How many times a prompt K-brain kept waiting after a refused answer is asked again. */
const PERMISSION_ANSWER_RETRIES = 3;

/** permission.requested payload. `rule` scopes an allow_always answer, which K-brain only
 *  remembers when it lists that option; older backends offer allow_once/reject only. */
export type KBrainPermissionRequest = {
  permission_id: string;
  tool: string;
  command?: string;
  rule?: string;
  description?: string;
  options?: { id: string; label?: string; kind?: string }[];
  /** "session": approving also allows this kind of action for the rest of the session. */
  scope?: string;
  /** The model tool call waiting on this decision, when K-brain knows it. */
  tool_call_id?: string;
  /** Shell the command runs in (bash, pwsh, cmd); empty for non-shell tools. */
  shell?: string;
  /** What allow_always would remember, from backends with permission_rules. */
  suggestion?: { rules: string[]; default_scope?: string };
  /** The change a file tool will make; diff rows are "<line> <mark> <text>". */
  preview?: { path: string; diff?: string; new_file?: boolean; truncated?: boolean };
};

/** The answer to a permission request: a bare decision, or one with the remember
 *  scope (allow_always) or the reason given to the model (reject). */
export type KBrainPermissionAnswer =
  | KBrainPermissionDecision
  | { decision: KBrainPermissionDecision; scope?: string; reason?: string };

export type KBrainPermissionDecision = "allow_once" | "allow_always" | "reject";

/** permission.auto_resolved: the backend allowed a call without asking. */
export type KBrainPermissionAutoResolved = {
  toolCallId: string;
  source: "rule" | "read_only";
  rule?: string;
  scope?: string;
};

/** Posts the answer to an MCP elicitation; resolves with K-brain's verdict (400 keeps it open). */
export type KBrainElicitationAnswer = (
  action: McpElicitationAction,
  content?: McpElicitationContent,
) => Promise<McpElicitationSubmitOutcome>;

export type KBrainTurnParams = {
  locale?: Locale;
  conversationId: string;
  sessionId: string;
  cwd?: string;
  model: KBrainModelRef;
  prompt: string;
  context: Context;
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
  onThinkingDelta: (text: string) => void;
  onHostedSearch?: (search: HostedSearchBlock) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (call: ToolCall, result: ToolResultMessage) => void;
  /** 命令运行中的输出尾部快照（整体替换，非增量）；结果到达后不再回调。 */
  onToolOutput?: (toolCallId: string, output: string) => void;
  onSubagent?: (subagent: KBrainSubagent) => void;
  /**
   * `usage.updated`: the token usage of the model call that just finished. Fires once
   * per model call during the run, before that call's tools run.
   */
  onUsage?: (usage: AssistantMessage["usage"]) => void;
  /** Every `subagent.*` and `trajectory.child.*` event, from any run of the session. */
  onSubagentEvent?: (event: KBrainEvent) => void;
  onStatus?: (status: string | null) => void;
  /** Called only after the backend returns a valid accepted run identity. */
  onAccepted?: () => void;
  content?: KBrainContentBlock[];
  onQuestionRequest?: (
    request: KBrainQuestionRequest,
    signal?: AbortSignal,
  ) => Promise<KBrainQuestionAnswer[]>;
  /** refusal: K-brain's reason for refusing the previous answer to this prompt (400). */
  onPermissionRequest?: (
    request: KBrainPermissionRequest,
    signal?: AbortSignal,
    refusal?: string,
  ) => Promise<KBrainPermissionAnswer>;
  onPermissionAutoResolved?: (resolved: KBrainPermissionAutoResolved) => void;
  /**
   * An MCP server asked the user to fill in a form (`elicitation.requested`). Setting this
   * also asks K-brain to relay elicitations (option mcp_elicitation), when it can. The
   * signal aborts when the request is resolved or the run ends.
   */
  onElicitationRequest?: (
    request: McpElicitationRequest,
    answer: KBrainElicitationAnswer,
    signal: AbortSignal,
  ) => void;
  /** `elicitation.resolved`: exactly one per request; sensitive values already removed. */
  onElicitationResolved?: (toolCallId: string, record: McpElicitationRecord) => void;
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
  /** prompt 是“/名称 参数”提示词指令，由 K-brain 展开。 */
  promptCommand?: boolean;
  /** 经 goal 接口开始本轮：set 设定新目标，resume 续上已暂停的目标。 */
  goal?: { action: "set"; goal: string } | { action: "resume" };
  /** 不发起新运行，挂接到后端按目标自动发起的这一轮（goal.updated 给出的请求标识）。 */
  attachClientRequestId?: string;
  onGoalUpdate?: (state: KBrainGoalState) => void;
};

const api = "kbrain.agent.v1" as AssistantMessage["api"];
const maxReconnects = 3;
// 取消只是请求：后端 run 收到取消后还要收尾，发出终止事件前会话仍然占用。停止后
// 最多等这么久，让下一轮（排队指令插队）不会撞上还在收尾的 run。
const cancelSettleTimeoutMs = 10_000;
// K-brain 在上一轮收尾、或后台任务仍在跑时拒绝开始新一轮；按退避重试，直到上限。
const sessionBusyError = "session already has a running turn";
const sessionBusyRetryDelaysMs = [250, 500, 1_000, 2_000, 3_000];
const sessionBusyWaitMs = 180_000;
// 后端在上一轮终止事件之后才发起目标续跑；按请求标识轮询，直到它被接受。
const goalAttachPollMs = 150;
const goalAttachTimeoutMs = 60_000;
// 每隔这么多次查询核对一次目标状态（约 1 秒）。
const goalAttachCheckEvery = 6;

function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function usage(message?: KBrainMessage): AssistantMessage["usage"] {
  return kbrainUsage(message?.usage);
}

/** The call without the question a running tool asked (see {@link TOOL_QUESTION_ARG}). */
export function withoutToolQuestion(call: ToolCall): ToolCall {
  if (!(TOOL_QUESTION_ARG in (call.arguments ?? {}))) return call;
  const {
    [TOOL_QUESTION_ARG]: _question,
    [ASK_USER_QUESTION_DEADLINE_ARG]: _deadline,
    ...rest
  } = call.arguments;
  return { ...call, arguments: rest };
}

/** A question asked by a running tool other than AskUserQuestion / K-brain's question. */
export function isToolOwnedQuestion(call: ToolCall | undefined): call is ToolCall {
  return (
    call !== undefined &&
    call.name !== ASK_USER_QUESTION_TOOL_NAME &&
    call.name !== KBRAIN_QUESTION_TOOL_NAME
  );
}

function toolCall(call: KBrainToolCall): ToolCall {
  return normalizeKBrainQuestionToolCall({
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: (call.arguments ?? {}) as Record<string, unknown>,
  });
}

function toolResult(
  result: KBrainToolResult,
  call: ToolCall | undefined,
  runId: string,
  revision: number,
): ToolResultMessage {
  const isError = result.failed === true || result.cancelled === true;
  const images = kbrainToolImages(result.content, result.output);
  return {
    role: "toolResult",
    toolCallId: result.id,
    toolName: kbrainToolResultName(result.name),
    content: [{ type: "text", text: result.output }, ...images.content],
    details: withMcpElicitationDetails(
      withToolRunInfo(
        result.name,
        questionResultDetails(
          result.name,
          result.output,
          call?.arguments,
          isError,
          result.question_answers,
        ) ??
          taskResultDetails(result.name, call?.arguments, result, runId, revision) ??
          displayImageResultDetails(result.name, images.images, isError),
        result,
      ),
      result.elicitations,
    ),
    isError,
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
    // K-brain（Go）把空切片序列化成 null，必须先归一化，否则渲染时崩溃（#1069）。
    const block = normalizeHostedSearchBlock(search);
    if (block) content.push(block);
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

function isSessionBusyError(error: unknown) {
  return (
    (error as { status?: number })?.status === 409 &&
    error instanceof Error &&
    error.message === sessionBusyError
  );
}

/** 停止后等这一轮 run 的终止事件（有超时）；流出错或超时就不再等。 */
async function waitForCancelledRun(
  client: ReturnType<typeof createKBrainClient>,
  sessionId: string,
  runId: string,
  afterSeq: number,
) {
  const settled = new AbortController();
  const timer = setTimeout(() => settled.abort(), cancelSettleTimeoutMs);
  let seq = afterSeq;
  try {
    while (!settled.signal.aborted) {
      const before = seq;
      await client.subscribe(
        sessionId,
        seq,
        {
          onEvent: (event: KBrainEvent) => {
            if (!Number.isInteger(event.seq) || event.seq <= seq) return;
            seq = event.seq;
            if (
              event.run_id === runId &&
              (event.type === "run.cancelled" ||
                event.type === "run.completed" ||
                event.type === "run.failed")
            ) {
              settled.abort();
            }
          },
        },
        settled.signal,
      );
      // 流在没有新事件时结束，再订阅也只是空转。
      if (seq === before) break;
    }
  } catch {
    // 超时或流失败：放弃等待，发送侧仍会按会话忙重试。
  } finally {
    clearTimeout(timer);
  }
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
  try {
    return await executeKBrainTurn(params);
  } finally {
    params.onStatus?.(null);
  }
}

async function executeKBrainTurn(params: KBrainTurnParams): Promise<AssistantMessage> {
  if (params.options?.client_tools?.length) {
    throw new Error("LiveAgent tools must execute in K-brain, not in the frontend");
  }
  const started = performance.now();
  let progress: RunProgress = { stage: "connecting" };
  let clientFirstText: number | undefined;
  let lastStatus: string | null = null;
  let reconnecting = false;
  const reportStatus = (status: string | null) => {
    lastStatus = status;
    params.onStatus?.(status);
  };
  const reportProgress = (next: RunProgress) => {
    progress = {
      ...next,
      ...(clientFirstText === undefined ? {} : { client_first_text_ms: clientFirstText }),
    };
    reportStatus(encodeRunProgress(progress));
  };
  reportProgress(progress);
  const baseUrl = params.baseUrl;
  const client = createKBrainClient({
    baseUrl,
    token: params.token,
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
  const attachRun = async () => {
    const requestId = params.attachClientRequestId ?? "";
    const deadline = Date.now() + goalAttachTimeoutMs;
    for (let attempt = 1; ; attempt += 1) {
      const found = await client.lookupRun(kbrainSessionId, requestId, params.signal);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("K-brain did not start the next goal round");
      // 后端启动续跑失败会把目标改成暂停；会话不存在时 getGoal 直接报错。定期核对
      // 目标状态，这两种情况立即结束，不必空等到超时。
      if (attempt % goalAttachCheckEvery === 0) {
        const goal = await client.getGoal(kbrainSessionId, params.signal);
        params.onGoalUpdate?.(goal);
        if (goal.status !== "active" && goal.status !== "continuing") {
          // 查询与读目标之间这一轮可能刚被接受又结束，再查一次再放弃。
          const late = await client.lookupRun(kbrainSessionId, requestId, params.signal);
          if (late) return late;
          throw new Error(
            `K-brain did not start the next goal round (goal ${goal.status}${goal.reason ? `: ${goal.reason}` : ""})`,
          );
        }
      }
      await waitMs(goalAttachPollMs, params.signal);
    }
  };
  // Ask K-brain to relay MCP form elicitations only when this turn can show them; the client
  // drops the option unless the backend advertises the capability (older backends reject it).
  const runOptions: KBrainRunOptions | undefined =
    params.onElicitationRequest && !params.attachClientRequestId
      ? { ...params.options, mcp_elicitation: true }
      : params.options;
  const startRun = async () => {
    if (params.attachClientRequestId) return attachRun();
    const run = {
      client_request_id: clientRequestId,
      ...(params.turnId ? { turn_id: params.turnId } : {}),
      prompt: params.prompt,
      ...(promptContent.length ? { content: promptContent } : {}),
      model,
      ...(runOptions ? { options: runOptions } : {}),
      ...(params.hook_policy ? { hook_policy: params.hook_policy } : {}),
      ...(params.hook_scope_id ? { hook_scope_id: params.hook_scope_id } : {}),
      ...(resumeMessageId ? { resume_message_id: resumeMessageId } : {}),
      ...(params.promptCommand ? { prompt_command: true } : {}),
    };
    if (params.goal) {
      const state = await client.postGoal(
        kbrainSessionId,
        params.goal.action === "set"
          ? { action: "set", goal: params.goal.goal, run }
          : { action: "resume", run },
        params.signal,
      );
      params.onGoalUpdate?.(state);
      if (!state.run) throw new Error("K-brain goal response has no run");
      return state.run;
    }
    return client.startRun({ conversation_id: kbrainSessionId, ...run }, params.signal);
  };
  // 停止上一轮后立刻发出的下一轮（排队指令插队）可能赶上后台任务仍在运行。K-brain
  // 在登记请求和改动目标之前就拒绝忙会话，所以普通运行和目标设定/续上都可以用同一
  // 请求标识重试；挂接路径本身就在轮询。用户停止时 waitMs 直接抛出中止。
  const startRunWhenIdle = async () => {
    if (params.attachClientRequestId) return startRun();
    const deadline = Date.now() + sessionBusyWaitMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await startRun();
      } catch (error) {
        if (!isSessionBusyError(error)) throw error;
        if (Date.now() >= deadline) {
          throw new Error(
            "该会话上一轮仍在运行，已等待 3 分钟仍未结束。请点击停止按钮结束当前任务后重新发送，或稍后再试。",
          );
        }
        reportProgress({ stage: "waiting_session" });
        const delay =
          sessionBusyRetryDelaysMs[Math.min(attempt, sessionBusyRetryDelaysMs.length - 1)];
        await waitMs(delay ?? 3_000, params.signal);
      }
    }
  };
  let accepted: Awaited<ReturnType<typeof client.startRun>>;
  try {
    accepted = await startRunWhenIdle();
  } catch (error) {
    if ((error as { status?: number }).status !== 404 || !kbrainSessionId) throw error;
    kbrainSessionId = await createSession();
    accepted = await startRunWhenIdle();
  }
  if (accepted.conversation_id !== kbrainSessionId || !accepted.run_id) {
    throw new Error("K-brain returned an invalid run identity");
  }
  params.onAccepted?.();
  if (params.signal.aborted) {
    await client.cancelRun(kbrainSessionId, accepted.run_id).catch(() => undefined);
    await waitForCancelledRun(client, kbrainSessionId, accepted.run_id, accepted.accepted_seq);
    throw abortError();
  }
  reportProgress({ stage: "preparing" });

  let text = "";
  let thinking = "";
  let finalMessage: KBrainMessage | undefined;
  const calls = new Map<string, ToolCall>();
  // 已出结果的调用：之后到达的运行中输出一律忽略。
  const settledCalls = new Set<string>();
  let afterSeq = accepted.accepted_seq;
  let terminal: "stop" | "error" | "aborted" = "stop";
  let errorMessage: string | undefined;
  let sawTerminal = false;
  let permissionFailure: Error | undefined;
  const pendingPermissions = new Map<string, AbortController>();
  const pendingQuestions = new Map<string, AbortController>();
  // question.resolved carries the exact answers (custom flags included); the later
  // tool.result of K-brain's `question` tool is only text, so its card keeps these.
  const resolvedQuestionResults = new Map<string, ToolResultMessage>();
  const pendingClientTools = new Map<string, AbortController>();
  // Never cleared: replayed events after a reconnect must not run the same action twice.
  const handledClientTools = new Set<string>();
  // MCP elicitations waiting for the user, and every one seen (requested or resolved), so a
  // replayed request never reopens a form that was already answered.
  const pendingElicitations = new Map<
    string,
    { controller: AbortController; request: McpElicitationRequest }
  >();
  const seenElicitations = new Set<string>();
  const streamAbortController = new AbortController();
  const cancelPendingPermissions = () => {
    for (const controller of pendingPermissions.values()) controller.abort();
    pendingPermissions.clear();
    for (const controller of pendingQuestions.values()) controller.abort();
    pendingQuestions.clear();
    for (const controller of pendingClientTools.values()) controller.abort();
    pendingClientTools.clear();
    for (const pending of pendingElicitations.values()) pending.controller.abort();
    pendingElicitations.clear();
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
    if (isSubagentEventType(event.type)) params.onSubagentEvent?.(event);
    // Session streams can include background tasks started by an earlier run.
    if (event.run_id !== accepted.run_id && !event.type.startsWith("subagent.")) return;
    if (reconnecting) {
      reconnecting = false;
      params.onStatus?.(lastStatus);
    }
    switch (event.type) {
      case "run.progress": {
        const next = parseRunProgress(eventPayload<unknown>(event));
        if (next) reportProgress(next);
        break;
      }
      case "assistant.text.delta": {
        const delta = eventPayload<{ text?: string }>(event)?.text ?? "";
        if (delta) {
          text += delta;
          if (clientFirstText === undefined) {
            clientFirstText = performance.now() - started;
            reportProgress({ ...progress, stage: "responding" });
          } else if (progress.stage !== "responding") {
            reportProgress({ ...progress, stage: "responding" });
          }
          params.onTextDelta(delta);
        }
        break;
      }
      case "assistant.thinking.delta": {
        const delta = eventPayload<{ text?: string }>(event)?.text ?? "";
        if (delta) {
          thinking += delta;
          if (progress.stage !== "thinking") reportProgress({ ...progress, stage: "thinking" });
          params.onThinkingDelta(delta);
        }
        break;
      }
      case "assistant.sources": {
        // 搜索刚开始时 queries/sources 尚为空，K-brain 会发 null；归一化后再进 UI（#1069）。
        const search = normalizeHostedSearchBlock(eventPayload<KBrainHostedSearch>(event));
        if (search) params.onHostedSearch?.(search);
        break;
      }
      case "tool.call": {
        const payload = eventPayload<{ tool_call?: KBrainToolCall }>(event);
        if (!payload?.tool_call) break;
        const call = toolCall(payload.tool_call);
        reportProgress({ ...progress, stage: "tool" });
        calls.set(call.id, call);
        params.onToolCall(call);
        break;
      }
      case "tool.result": {
        const payload = eventPayload<{ tool_result?: KBrainToolResult }>(event);
        if (!payload?.tool_result) break;
        const computed = toolResult(
          payload.tool_result,
          calls.get(payload.tool_result.id),
          event.run_id,
          event.seq,
        );
        const resolvedQuestion = resolvedQuestionResults.get(computed.toolCallId);
        const result =
          resolvedQuestion?.details && !computed.isError
            ? { ...computed, details: resolvedQuestion.details }
            : computed;
        const call = withoutToolQuestion(
          calls.get(result.toolCallId) ?? {
            type: "toolCall",
            id: result.toolCallId,
            name: result.toolName,
            arguments: {},
          },
        );
        settledCalls.add(result.toolCallId);
        params.onToolResult(call, result);
        break;
      }
      case "assistant.message.created":
        finalMessage = eventPayload<KBrainMessage>(event);
        break;
      case "usage.updated": {
        // One report per model call, after its stream and before its tool calls run.
        // Replayed events after a reconnect arrive here again in order, so the latest
        // report always wins.
        const reported = eventPayload<KBrainUsage>(event);
        if (hasKBrainUsage(reported)) params.onUsage?.(kbrainUsage(reported));
        break;
      }
      case "goal.updated": {
        const state = eventPayload<KBrainGoalState>(event);
        if (state?.conversation_id === kbrainSessionId) params.onGoalUpdate?.(state);
        break;
      }
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
      case "approval.reviewed": {
        const review = eventPayload<{
          phase: string;
          tool: string;
          automatic: boolean;
          report: {
            risk: string;
            reason: string;
            sandbox: string;
            sensitive_data: string;
            model_behavior: string;
            injection: string;
          };
        }>(event);
        if (
          review &&
          Object.entries(review.report).some(([key, value]) => key !== "reason" && value !== "low")
        ) {
          toast.warning(aiReviewTitle(review.tool, params.locale), {
            description: localizeAIReviewReason(review.report.reason, params.locale),
            id: `ai-review-${params.conversationId}`,
            duration: 15000,
          });
        }
        break;
      }
      case "hook.warning": {
        // A failing hook does not stop the run, so without this the user never learns
        // their hook is broken. One toast per hook and turn: a hook bound to a per-tool
        // event updates the same toast instead of stacking one per call.
        const warning = parseHookWarning(eventPayload<unknown>(event));
        if (warning) {
          const notice = hookWarningNotice(warning, params.locale);
          toast.warning(notice.title, {
            description: notice.description,
            id: `hook-warning-${params.conversationId}-${accepted.run_id}-${warning.hookName}`,
            duration: 15000,
          });
        }
        break;
      }
      case "tool.status": {
        const payload = eventPayload<{
          tool_call_id?: string | null;
          status?: string | null;
          text?: string | null;
          message?: string | null;
        }>(event);
        // 带 tool_call_id 的 running 状态是命令运行中的输出快照（#975）：交给对应
        // 工具卡展示，不能当作整轮的状态文字覆盖运行进度。
        const toolCallId = typeof payload?.tool_call_id === "string" ? payload.tool_call_id : "";
        if (toolCallId && payload?.status === "running" && typeof payload.message === "string") {
          if (calls.has(toolCallId) && !settledCalls.has(toolCallId)) {
            params.onToolOutput?.(toolCallId, payload.message);
          }
          break;
        }
        reportStatus(payload?.status ?? payload?.text ?? null);
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
        reportStatus("Waiting for your answer…");
        const questionController = new AbortController();
        if (request.run_id !== accepted.run_id || !request.question_id || !request.tool_call_id)
          throw new Error("Question identity mismatch");
        if (pendingQuestions.has(request.question_id)) break;
        const previousCall = calls.get(request.tool_call_id);
        const previous = previousCall?.arguments ?? {};
        // A running tool asking its own question (SSHManager confirming a host key) keeps
        // its name and arguments: the question rides along until it resolves, and the
        // tool's real result follows.
        const call: ToolCall = isToolOwnedQuestion(previousCall)
          ? {
              ...previousCall,
              arguments: {
                ...previous,
                [TOOL_QUESTION_ARG]: { questions: request.questions },
                [ASK_USER_QUESTION_DEADLINE_ARG]: request.deadline_at,
              },
            }
          : {
              type: "toolCall",
              id: request.tool_call_id,
              name: "AskUserQuestion",
              arguments: {
                questions: request.questions,
                __askUserQuestionDeadlineAt: request.deadline_at,
                ...(previous[KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG] !== undefined
                  ? {
                      [KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG]:
                        previous[KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG],
                    }
                  : {}),
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
            reportStatus(null);
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
          if (call && TOOL_QUESTION_ARG in call.arguments) {
            // The tool goes on running; only the question card goes away.
            const settled = withoutToolQuestion(call);
            calls.set(settled.id, settled);
            if (!settledCalls.has(settled.id)) params.onToolCall(settled);
          } else if (call) {
            const resolved = toolResult(
              {
                id: call.id,
                name: "AskUserQuestion",
                output: JSON.stringify(resolution),
              },
              call,
              event.run_id,
              event.seq,
            );
            resolvedQuestionResults.set(call.id, resolved);
            params.onToolResult(call, resolved);
          }
        }
        reportStatus(null);
        break;
      }
      case "elicitation.requested": {
        const request = parseMcpElicitationRequest(eventPayload<unknown>(event));
        const onElicitationRequest = params.onElicitationRequest;
        // Without a callback the option was never sent; K-brain declines on its own.
        if (!request || !onElicitationRequest) break;
        if (request.runId && request.runId !== accepted.run_id) break;
        if (!request.toolCallId || seenElicitations.has(request.elicitationId)) break;
        seenElicitations.add(request.elicitationId);
        const controller = new AbortController();
        pendingElicitations.set(request.elicitationId, { controller, request });
        reportStatus("Waiting for your answer…");
        const answer: KBrainElicitationAnswer = (action, content) =>
          controller.signal.aborted
            ? Promise.resolve({ ok: false, message: "This form is no longer pending." })
            : client.answerElicitation(
                kbrainSessionId,
                request.elicitationId,
                accepted.run_id,
                action,
                content,
              );
        onElicitationRequest(request, answer, controller.signal);
        break;
      }
      case "elicitation.resolved": {
        const payload = eventPayload<Record<string, unknown>>(event);
        const elicitationId =
          typeof payload?.elicitation_id === "string" ? payload.elicitation_id : "";
        const toolCallId = typeof payload?.tool_call_id === "string" ? payload.tool_call_id : "";
        if (!payload || !elicitationId || !toolCallId) break;
        const pending = pendingElicitations.get(elicitationId);
        pending?.controller.abort();
        pendingElicitations.delete(elicitationId);
        seenElicitations.add(elicitationId);
        // The resolved event has no fields: take them from the request, so the summary can
        // label values (and drop any value of a sensitive field).
        const record = parseMcpElicitationRecord({
          ...payload,
          fields: payload.fields ?? pending?.request.fields,
        });
        if (record) params.onElicitationResolved?.(toolCallId, record);
        if (pendingElicitations.size === 0) reportStatus(null);
        break;
      }
      case "client_tool.requested": {
        const request = eventPayload<KBrainClientToolRequest>(event);
        if (!request?.call_id || request.run_id !== accepted.run_id) break;
        if (handledClientTools.has(request.call_id)) break;
        handledClientTools.add(request.call_id);
        const controller = new AbortController();
        pendingClientTools.set(request.call_id, controller);
        void Promise.resolve()
          .then(
            (): KBrainClientToolResult => ({
              text: `${request.tool} must execute in K-brain; LiveAgent does not execute client tools.`,
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
        reportStatus("Waiting for permission…");
        const request = eventPayload<KBrainPermissionRequest>(event);
        if (!request || !params.onPermissionRequest) {
          permissionFailure = new Error(
            "K-brain requested permission but no permission callback is configured",
          );
          streamAbortController.abort();
          return;
        }
        const permissionController = new AbortController();
        pendingPermissions.set(request.permission_id, permissionController);
        const onPermissionRequest = params.onPermissionRequest;
        const answerPermission = async () => {
          let refusal: string | undefined;
          for (let attempt = 0; ; attempt += 1) {
            const answer = await onPermissionRequest(request, permissionController.signal, refusal);
            if (permissionController.signal.aborted) return;
            const { decision, scope, reason } = permissionAnswerFields(answer);
            try {
              await client.resolvePermission(
                kbrainSessionId,
                request.permission_id,
                decision,
                accepted.run_id,
                reason,
                scope,
              );
              return;
            } catch (error) {
              const status = (error as { status?: number }).status;
              // A concurrent session grant can consume this waiter before its SSE resolution arrives.
              if (status === 404) return;
              // K-brain answers 400 and keeps the prompt waiting when it cannot store the
              // remembered rules (a scope it cannot keep, a failed write): ask again.
              if (
                status === 400 &&
                attempt < PERMISSION_ANSWER_RETRIES &&
                !permissionController.signal.aborted
              ) {
                refusal = error instanceof Error ? error.message : String(error);
                continue;
              }
              throw error;
            }
          }
        };
        void answerPermission()
          .catch((error) => {
            if (permissionController.signal.aborted) return;
            permissionFailure = error instanceof Error ? error : new Error(String(error));
            reportStatus(null);
            streamAbortController.abort();
          })
          .finally(() => {
            if (pendingPermissions.get(request.permission_id) === permissionController) {
              pendingPermissions.delete(request.permission_id);
            }
          });
        break;
      }
      case "permission.auto_resolved": {
        const resolved = eventPayload<{
          tool_call_id?: string;
          source?: string;
          rule?: string;
          scope?: string;
        }>(event);
        const toolCallId = resolved?.tool_call_id?.trim();
        const source = resolved?.source;
        if (toolCallId && (source === "rule" || source === "read_only")) {
          params.onPermissionAutoResolved?.({
            toolCallId,
            source,
            ...(resolved?.rule ? { rule: resolved.rule } : {}),
            ...(resolved?.scope ? { scope: resolved.scope } : {}),
          });
        }
        break;
      }
      case "permission.resolved": {
        const resolution = eventPayload<{ permission_id?: string }>(event);
        if (resolution?.permission_id) {
          pendingPermissions.get(resolution.permission_id)?.abort();
          pendingPermissions.delete(resolution.permission_id);
        }
        reportStatus(null);
        break;
      }
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
        reconnecting = true;
        params.onStatus?.(encodeRunProgress({ stage: "reconnecting" }));
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
    // Stop aborts the event stream fetch, so its AbortError text ("Fetch is aborted" in
    // WKWebView) is not a run failure and must not reach the transcript.
    if (terminal === "error") errorMessage = error instanceof Error ? error.message : String(error);
    streamAbortController.abort();
    cancelPendingPermissions();
    await client.cancelRun(kbrainSessionId, accepted.run_id).catch(() => undefined);
    if (params.signal.aborted && !sawTerminal) {
      await waitForCancelledRun(client, kbrainSessionId, accepted.run_id, afterSeq);
    }
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
  // A stopped turn keeps whatever it streamed; the transcript renders the stopped state.
  if (content.length === 0 && terminal === "error") {
    content = [{ type: "text", text: errorMessage ?? "K-brain run failed" }];
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

// Scope only goes with allow_always and a reason only with reject, so a stray field
// cannot widen or explain a different decision.
function permissionAnswerFields(answer: KBrainPermissionAnswer): {
  decision: KBrainPermissionDecision;
  scope?: string;
  reason?: string;
} {
  if (typeof answer === "string") return { decision: answer };
  const scope = answer.decision === "allow_always" ? answer.scope?.trim() : undefined;
  const reason = answer.decision === "reject" ? answer.reason?.trim() : undefined;
  return {
    decision: answer.decision,
    ...(scope ? { scope } : {}),
    ...(reason ? { reason } : {}),
  };
}
