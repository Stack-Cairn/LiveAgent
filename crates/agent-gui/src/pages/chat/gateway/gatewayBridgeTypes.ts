import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import type { ComposerTurnCommand } from "@liveagent/ui/lib/chat/composerCommands";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { MutableRefObject } from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type {
  ChatRuntimeControls,
  CommandSafetyMode,
  ExecutionMode,
  ProviderId,
} from "../../../lib/settings";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";

export type GatewaySelectedModelEvent = {
  customProviderId: string;
  model: string;
  providerType: string;
};

export type GatewayChatRuntimeControlsEvent = Pick<
  ChatRuntimeControls,
  "thinkingEnabled" | "nativeWebSearchEnabled" | "reasoning" | "planModeEnabled"
>;

export type GatewayChatRequestEvent = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  message: string;
  rebased?: boolean;
  baseMessageRef?: HistoryMessageRef;
  selectedModel?: GatewaySelectedModelEvent;
  runtimeControls?: GatewayChatRuntimeControlsEvent;
  executionMode?: string;
  workdir?: string;
  commandSafetyMode?: string;
  uploadedFiles?: PendingUploadedFile[];
  referencedConversations?: ConversationMentionReference[];
  queuePolicy?: "auto" | "append" | "interrupt" | string;
  /** WebUI 输入框“/”指令：set/resume 经 K-brain goal 接口开始本轮（Gateway 已校验）。 */
  goalAction?: string;
  /** goalAction 为 set 时的目标正文。 */
  goalText?: string;
  /** message 是提示词指令（"/name args"），由 K-brain 展开，历史保留原文。 */
  promptCommand?: boolean;
  planCommand?: boolean;
};

export type GatewayChatClaimedRequest = {
  requestId: string;
  clientRequestId: string;
  conversationId: string;
  state: string;
  attempt: number;
  leaseMs: number;
  request: GatewayChatRequestEvent;
};

export type GatewayChatRequestReadyEvent = {
  requestId?: string;
  reason?: string;
};

export type EnsureGatewayBridgeConversationReadyOptions = {
  rebased?: boolean;
};

export type PrepareEditResend = (
  conversationId: string,
  messageRef: HistoryMessageRef,
  options?: { activate?: boolean },
) => Promise<{ conversationId: string; messageRef: HistoryMessageRef }>;

export type GatewayChatCancelEvent = {
  requestId: string;
  conversationId: string;
};

export type GatewayClarifyTurnRequestEvent = {
  requestId: string;
  messagesJson: string;
  providerId: string;
  model: string;
  runtimeControlsJson: string;
};

/** Rust 转来的 WebUI 非运行指令（/goal clear、/loop）；字段与 GoalManage/LoopManage 请求一致。 */
export type GatewayComposerActionEvent = {
  requestId: string;
  kind: "goal" | "loop" | string;
  conversationId: string;
  action: string;
  cron: string;
  interval: string;
  prompt: string;
  reasoning: string;
  loopId: string;
  data?: Record<string, unknown> | null;
};

export type ActiveGatewayBridgeRequest = {
  requestId: string;
  conversationId: string;
  clientRequestId?: string;
  workerId?: string;
  startedAt: number;
  selectedModelOverride?: GatewaySelectedModelEvent;
  runtimeControlsOverride?: ChatRuntimeControls;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  commandSafetyModeOverride?: CommandSafetyMode;
};

export type SendChatAction = (overrides?: {
  textOverride?: string;
  composerDraftOverride?: MentionComposerDraft;
  uploadedFilesOverride?: PendingUploadedFile[];
  conversationIdOverride?: string;
  executionModeOverride?: ExecutionMode;
  workdirOverride?: string;
  commandSafetyModeOverride?: CommandSafetyMode;
  runtimeControlsOverride?: ChatRuntimeControls;
  /** 输入框“/”指令带来的单轮语义（goal 或提示词指令）。 */
  composerCommand?: ComposerTurnCommand;
  gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
  preserveComposerOnStart?: boolean;
  beforeRuntimeStart?: () => Promise<void>;
  afterInitialHistoryPersist?: () => Promise<void>;
  // Edit-resend atomically replaces this user message and its following
  // history before the model runtime starts, then forwards the same anchor
  // so other connected clients can apply the rebase.
  editResendBaseMessageRef?: HistoryMessageRef;
}) => Promise<boolean>;

export type GatewayBridgeRuntimeRefs = {
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  ensureGatewayBridgeConversationReadyRef: MutableRefObject<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >;
  sendActionRef: MutableRefObject<SendChatAction>;
};

export function normalizeGatewayProviderType(value: string): ProviderId | null {
  const normalized = value.trim();
  if (
    normalized === "codex" ||
    normalized === "claude_code" ||
    normalized === "gemini" ||
    normalized === "xai" ||
    normalized === "deepseek"
  ) {
    return normalized;
  }
  return null;
}

export function normalizeGatewayExecutionMode(
  value: string | null | undefined,
): ExecutionMode | undefined {
  switch (value?.trim()) {
    case "tools":
    case "agent-dev":
    case "text":
      return value.trim() as ExecutionMode;
    default:
      return undefined;
  }
}

// 命令安全模式的网关归一化。返回 undefined(而非某个默认模式)表示"远端未指定",
// 让 useSendChatTurn 的优先级链回落到本地 settings.system.commandSafetyMode;绝不
// 默认成 "auto",以免静默下调桌面端已选的更严格模式(fail-closed)。
export function normalizeGatewayCommandSafetyMode(
  value: string | null | undefined,
): CommandSafetyMode | undefined {
  switch (value?.trim()) {
    case "ask":
    case "auto":
    case "autoEdit":
    case "always":
    case "autoReview":
    case "sandbox":
    case "sandboxOffline":
      return value.trim() as CommandSafetyMode;
    default:
      return undefined;
  }
}

export function normalizeGatewayWorkdir(value: string | null | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}

/**
 * 把 Gateway 转来的 goal/prompt 字段还原成单轮指令。没有指令语义时返回 undefined；
 * 字段自相矛盾（未知 goal 动作、set 缺正文、goal 与 prompt 并存）时返回 null，调用方应拒绝该请求，
 * 不能把 "/goal ..." 当普通消息发给模型。
 */
export function gatewayComposerTurnCommand(
  request: Pick<
    GatewayChatRequestEvent,
    "goalAction" | "goalText" | "promptCommand" | "planCommand"
  >,
): ComposerTurnCommand | null | undefined {
  const action = request.goalAction?.trim() ?? "";
  const goal = request.goalText?.trim() ?? "";
  const prompt = request.promptCommand === true;
  if (request.planCommand) {
    return action || goal || prompt ? null : { kind: "plan" };
  }
  if (!action) {
    if (goal) return null;
    return prompt ? { kind: "prompt" } : undefined;
  }
  if (prompt) return null;
  if (action === "resume") return { kind: "goal", action: "resume" };
  if (action === "set" && goal) return { kind: "goal", action: "set", goal };
  return null;
}
