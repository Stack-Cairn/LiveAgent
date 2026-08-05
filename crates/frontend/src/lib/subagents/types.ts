import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

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
