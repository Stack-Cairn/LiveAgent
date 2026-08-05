/**
 * Subagent UI wire protocol.
 *
 * This file is mirrored byte-for-byte between agent-gui and agent-gateway/web
 * (see scripts/mirror-manifest.json). It must stay dependency-free: both
 * frontends render subagent tool calls purely from these shapes, which travel
 * inside tool_call/tool_result payloads.
 */

export type SubagentProtocolMode = "readonly" | "worktree";
export type SubagentProtocolStatus = "completed" | "failed" | "cancelled";
export type SubagentProtocolChannel = "direct" | "shared" | "decision" | "question";

/** Final per-agent report embedded in cards and batch results. */
export type SubagentReportDetails = {
  id: string;
  runId: string;
  name: string;
  role?: string;
  prompt: string;
  templateId?: string;
  mode: SubagentProtocolMode;
  applyPolicy?: "none" | "explicit" | "auto";
  allowedOutputPaths?: string[];
  status: SubagentProtocolStatus;
  summary: string;
  durationMs: number;
  rounds: number;
  toolCalls: number;
  error?: string;
  persistenceWarnings?: string[];
  worktreeRoot?: string;
  workdir?: string;
  branchName?: string;
  changed?: boolean;
  statusText?: string;
  diffStat?: string;
  diff?: string;
  diffTruncated?: boolean;
  untrackedFiles?: string[];
  worktreeStatusError?: string;
  applyStatus?: "applied" | "skipped" | "failed";
  applyMethod?: "git_apply" | "git_apply_3way" | "file_copy_fallback";
  applyChanged?: boolean;
  applyPatchBytes?: number;
  applySkippedReason?: string;
  applyFallbackReason?: string;
  applyCopiedFiles?: string[];
  applyDeletedFiles?: string[];
  applyConflictFiles?: string[];
  applyError?: string;
  appliedToWorkdir?: string;
  worktreeCleanupStatus?: "removed" | "retained" | "skipped" | "failed";
  worktreeCleanupReason?: string;
  worktreeCleanupError?: string;
  worktreeBranchDeleted?: boolean;
  candidateArtifacts?: string[];
  changedPaths?: string[];
};

export type SubagentBatchIssue = {
  agentId?: string;
  code: string;
  message: string;
};

export type SubagentRosterEntry = {
  id: string;
  name: string;
  role: string;
  lastMode: SubagentProtocolMode;
  lastStatus?: string;
  lastSummary?: string;
};

export type SubagentTemplateEntry = {
  id: string;
  name: string;
  description?: string;
};

/** Aggregate result of one Agent tool call. */
export type SubagentBatchDetails = {
  kind: "subagent_batch";
  status: "ok" | "rejected";
  agentCount: number;
  concurrency: number;
  totalDurationMs: number;
  mode: "readonly" | "worktree" | "mixed";
  agents: SubagentReportDetails[];
  issues?: SubagentBatchIssue[];
  roster?: SubagentRosterEntry[];
  templates?: SubagentTemplateEntry[];
};

/** Per-agent live card result, fanned out from one Agent tool call. */
export type SubagentCardDetails = {
  kind: "subagent_card";
  parentToolCallId: string;
  index: number;
  total: number;
  concurrency: number;
  agent: SubagentReportDetails;
};

/** SendMessage tool result payload. */
export type SubagentMessageDetails = {
  kind: "subagent_message";
  parentConversationId: string;
  seq: number;
  senderId: string;
  senderName?: string;
  recipientId: string;
  recipientName?: string;
  channel: SubagentProtocolChannel;
  subject?: string;
  sourceRunId?: string;
  sourceToolCallId?: string;
  bodyPreview: string;
};

/**
 * Synthetic-card tool-call arguments. Cards use tool name "Agent" and the
 * `subagent_card: true` flag so both frontends can tell them apart from the
 * (suppressed) parent Agent call. `index` is 1-based for display.
 */
export type SubagentCardArguments = {
  subagent_card: true;
  parent_tool_call_id: string;
  index: number;
  total: number;
  concurrency?: number;
  id: string;
  name?: string;
  role?: string;
  mode?: SubagentProtocolMode;
  prompt?: string;
};

export function buildSubagentCardToolCallId(parentToolCallId: string, displayIndex: number) {
  return `${parentToolCallId}:agent:${displayIndex}`;
}

export function isSubagentCardArguments(value: unknown): value is SubagentCardArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.subagent_card === true && typeof record.id === "string";
}
