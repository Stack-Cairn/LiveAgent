import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  SubagentRuntimeFinishInput,
  SubagentRuntimePatch,
  SubagentRuntimeStartInput,
} from "@liveagent/ui/lib/subagents/runtime";
import type { ProviderRuntimeConfig } from "../providers/runtime/types";
import type { ProviderId, ReasoningLevel } from "../settings";

export const AGENT_TOOL_NAME = "Agent";
export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

export const SUBAGENT_PARENT_ID = "parent";
export const SUBAGENT_BROADCAST_RECIPIENT = "*";

export const MAX_AGENTS = 8;
export const DEFAULT_CONCURRENCY = MAX_AGENTS;
export const MAX_SUMMARY_CHARS = 8_000;
export const MAX_DIFF_CHARS = 20_000;

/**
 * Version stamp persisted with every run. Bumping it invalidates stored
 * private contexts whose prompt/layout assumptions no longer hold.
 */
export const SUBAGENT_CONTEXT_SCHEMA_VERSION = 2;

export const SUBAGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type SubagentMode = "readonly" | "worktree";
export type SubagentApplyPolicy = "none" | "explicit" | "auto";
export type SubagentRunStatus = "running" | "completed" | "failed" | "cancelled";
export type SubagentMessageChannel = "direct" | "shared" | "decision" | "question";

/** One fully validated agent request inside an Agent tool call. */
export type SubagentSpec = {
  id: string;
  prompt: string;
  name?: string;
  role?: string;
  identity?: string;
  templateId?: string;
  mode: SubagentMode;
  applyPolicy: SubagentApplyPolicy;
  allowedOutputPaths: string[];
  resume: boolean;
  retainWorktree: boolean;
  /** 覆盖父会话模型；undefined = 继承父会话。始终是同一个 provider。 */
  model?: string;
  /** 覆盖思考档位；undefined = 沿用该模型的默认档位。 */
  reasoning?: ReasoningLevel;
};

/**
 * Agent 工具可覆盖的模型/思考档位空间，由聊天层按当前 provider 装配。
 * 缺省即不允许覆盖——子代理完全继承父会话，与本特性上线前行为一致。
 *
 * 之所以传能力对象而不是让校验层自己去查目录：模型清单与档位表都住在 settings
 * 层，domain 层直接依赖它会把整个 settings 模块图拖进子代理的单元测试。
 */
/**
 * 用户在设置里钉死的子代理模型。存在时 Agent 工具的 model/thinking 一律拒绝
 * ——用户的选择是硬约束而非建议，否则「把机械活交给便宜模型」这个诉求就落不了地。
 * providerId 可以与父会话不同（跨供应商钉选）。
 */
export type SubagentPinnedModel = {
  providerId: ProviderId;
  model: string;
  reasoning?: ReasoningLevel;
  runtime: ProviderRuntimeConfig;
  /** 拒绝覆盖时回给模型的可读标签，例如 "gpt-5-mini · high"。 */
  label: string;
};

export type SubagentModelOptions = {
  /** 存在即钉死；此时下面三个字段不参与（模型不能自选）。 */
  pinned?: SubagentPinnedModel;
  /** 允许指定的模型 id（当前 provider 的启用模型）；空数组等同于不允许覆盖。 */
  models: string[];
  /**
   * 某模型的合法思考档位全集，含 "off"（若该模型允许关闭思考）。
   * 空数组表示该模型不支持调档。
   */
  thinkingLevelsFor: (model: string) => readonly ReasoningLevel[];
  /**
   * 按模型 + 档位派生 runtime。reasoning 为 undefined 时沿用该模型默认档位。
   * 必须走 createProviderRuntimeConfig，否则 modelConfig 会停留在父模型的配置上。
   */
  createRuntime: (model: string, reasoning: ReasoningLevel | undefined) => ProviderRuntimeConfig;
};

/**
 * 运行态上报出口。契约就是 @liveagent/ui 那份实时镜像的写入 API——刻意不在这里
 * 另立一套形状，否则每加一个字段都要在两处对齐。domain 层只调这三个方法，不 import
 * 镜像实现，因此无头场景（测试、gateway）传 undefined 即可完全旁路。
 */
export type SubagentActivitySink = {
  start: (input: SubagentRuntimeStartInput) => void;
  update: (runId: string, patch: SubagentRuntimePatch) => void;
  finish: (runId: string, outcome: SubagentRuntimeFinishInput) => void;
};

export type SubagentTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
};

export type SubagentIdentity = {
  parentConversationId: string;
  agentId: string;
  name: string;
  role: string;
  identityPrompt: string;
  templateId?: string;
  lastMode: SubagentMode;
  createdToolCallId?: string;
  createdAt: number;
  updatedAt: number;
};

export type SubagentRunSummary = {
  id: string;
  parentConversationId: string;
  parentToolCallId: string;
  agentId: string;
  agentIndex: number;
  agentTotal: number;
  prompt: string;
  mode: SubagentMode;
  status: SubagentRunStatus;
  providerId: string;
  model: string;
  sessionId?: string;
  workdir?: string;
  worktreeRoot?: string;
  branchName?: string;
  contextSchemaVersion: number;
  activeSegmentIndex: number;
  totalSegmentCount: number;
  totalMessageCount: number;
  roundCount: number;
  toolCallCount: number;
  compactionCount: number;
  summary?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  updatedAt: number;
};

export type SubagentMessageRecord = {
  id: number;
  parentConversationId: string;
  seq: number;
  senderId: string;
  senderName?: string;
  recipientId: string;
  recipientName?: string;
  channel: SubagentMessageChannel;
  subject?: string;
  bodyMarkdown: string;
  sourceRunId?: string;
  sourceToolCallId?: string;
  createdAt: number;
};

export type SubagentWorktreeInfo = {
  repoRoot: string;
  worktreeRoot: string;
  workdir: string;
  branchName: string;
};

export type SubagentWorktreeStatus = {
  changed: boolean;
  status: string;
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  untrackedFiles: string[];
};

export type SubagentWorktreeApplyResult = {
  applied: boolean;
  changed: boolean;
  status: string;
  patchBytes: number;
  skippedReason?: string;
  applyMethod?: "git_apply" | "git_apply_3way" | "file_copy_fallback";
  fallbackReason?: string;
  copiedFiles?: string[];
  deletedFiles?: string[];
  conflictFiles?: string[];
};

export type SubagentWorktreeCleanupResult = {
  worktreeRoot: string;
  branchName?: string;
  removed: boolean;
  branchDeleted: boolean;
  skippedReason?: string;
  error?: string;
};

export type WorktreeApplyDecision = {
  shouldApply: boolean;
  skippedReason?: string;
  changedPaths: string[];
  candidateArtifacts: string[];
};

export type WorktreeCleanupDecision = {
  shouldCleanup: boolean;
  reason: string;
};

/** A tool registry slice a subagent may execute against. */
export type SubagentToolRegistry = {
  tools: Tool[];
  executeToolCall: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
  metadataByName: Map<string, ToolMetadataLike>;
};

/**
 * Structural subset of BuiltinToolMetadata. The domain layer never imports
 * from ../tools; the adapter layer's metadata maps satisfy this shape.
 */
export type ToolMetadataLike = {
  groupId: string;
  kind: string;
  isReadOnly: boolean;
};
