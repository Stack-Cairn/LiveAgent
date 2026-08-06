import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import {
  buildSubagentCardToolCallId,
  type SubagentBatchDetails,
  type SubagentCardArguments,
  type SubagentCardDetails,
  type SubagentReportDetails,
} from "./protocol";
import { AGENT_TOOL_NAME, type SubagentIdentity, type SubagentSpec } from "./types";

/**
 * Synthetic per-agent tool call emitted when a subagent starts executing.
 * Reuses the same id scheme as the streaming placeholder cards so live
 * placeholders upgrade in place.
 */
export function buildSubagentCardToolCall(params: {
  parentToolCallId: string;
  spec: SubagentSpec;
  identity: SubagentIdentity;
  index: number;
  total: number;
  concurrency: number;
}): ToolCall {
  const cardArguments: SubagentCardArguments = {
    subagent_card: true,
    parent_tool_call_id: params.parentToolCallId,
    index: params.index + 1,
    total: params.total,
    concurrency: params.concurrency,
    id: params.spec.id,
    name: params.identity.name,
    role: params.identity.role,
    mode: params.spec.mode,
    prompt: params.spec.prompt,
  };
  return {
    type: "toolCall",
    id: buildSubagentCardToolCallId(params.parentToolCallId, params.index + 1),
    name: AGENT_TOOL_NAME,
    arguments: cardArguments,
  };
}

export function buildSubagentCardResult(params: {
  parentToolCallId: string;
  cardToolCall: ToolCall;
  report: SubagentReportDetails;
  index: number;
  total: number;
  concurrency: number;
}): ToolResultMessage {
  const details: SubagentCardDetails = {
    kind: "subagent_card",
    parentToolCallId: params.parentToolCallId,
    index: params.index,
    total: params.total,
    concurrency: params.concurrency,
    agent: params.report,
  };
  return {
    role: "toolResult",
    toolCallId: params.cardToolCall.id,
    toolName: params.cardToolCall.name,
    content: [
      {
        type: "text",
        text:
          params.report.error ||
          params.report.applyError ||
          params.report.summary ||
          params.report.prompt,
      },
    ],
    details,
    isError: params.report.status !== "completed",
    timestamp: Date.now(),
  };
}

function pathListLines(label: string, paths: string[] | undefined) {
  if (!paths || paths.length === 0) return "";
  return `${label}:\n${paths.map((file) => `- ${file}`).join("\n")}`;
}

/** Text rendering of the aggregate batch result returned to the model. */
export function renderBatchResultText(details: SubagentBatchDetails) {
  const lines = [
    `Subagent results: ${details.agents.length} agent(s), concurrency=${details.concurrency}, mode=${details.mode}`,
  ];

  for (const [index, agent] of details.agents.entries()) {
    lines.push(
      "",
      `${index + 1}. [${agent.status}] ${agent.name} (${agent.id}) - ${agent.prompt}`,
      `run_id=${agent.runId}`,
      agent.role ? `role=${agent.role}` : "",
      `mode=${agent.mode}`,
      agent.applyPolicy ? `apply_policy=${agent.applyPolicy}` : "",
      agent.templateId ? `template=${agent.templateId}` : "",
      `duration_ms=${agent.durationMs} rounds=${agent.rounds} tool_calls=${agent.toolCalls}`,
      agent.worktreeRoot ? `worktree=${agent.worktreeRoot}` : "",
      agent.branchName ? `branch=${agent.branchName}` : "",
      typeof agent.changed === "boolean" ? `changed=${agent.changed}` : "",
      agent.applyStatus ? `apply=${agent.applyStatus}` : "",
      agent.applyMethod ? `apply_method=${agent.applyMethod}` : "",
      typeof agent.applyPatchBytes === "number" ? `apply_patch_bytes=${agent.applyPatchBytes}` : "",
      agent.applySkippedReason ? `apply_skipped_reason=${agent.applySkippedReason}` : "",
      agent.applyFallbackReason ? `apply_fallback_reason=${agent.applyFallbackReason}` : "",
      agent.applyError ? `apply_error=${agent.applyError}` : "",
      agent.appliedToWorkdir ? `applied_to=${agent.appliedToWorkdir}` : "",
      agent.worktreeCleanupStatus ? `worktree_cleanup=${agent.worktreeCleanupStatus}` : "",
      agent.worktreeCleanupReason ? `worktree_cleanup_reason=${agent.worktreeCleanupReason}` : "",
      typeof agent.worktreeBranchDeleted === "boolean"
        ? `worktree_branch_deleted=${agent.worktreeBranchDeleted}`
        : "",
      agent.worktreeCleanupError ? `worktree_cleanup_error=${agent.worktreeCleanupError}` : "",
      pathListLines("copied", agent.applyCopiedFiles),
      pathListLines("deleted", agent.applyDeletedFiles),
      pathListLines("apply_conflicts", agent.applyConflictFiles),
      pathListLines("allowed_output_paths", agent.allowedOutputPaths),
      pathListLines("candidate_artifacts", agent.candidateArtifacts),
      agent.diffStat ? `diff_stat:\n${agent.diffStat}` : "",
      pathListLines("untracked", agent.untrackedFiles),
      agent.persistenceWarnings && agent.persistenceWarnings.length > 0
        ? `warning: subagent history persistence failed — resume may lose this session (${agent.persistenceWarnings.join("; ")})`
        : "",
      agent.error ? `error=${agent.error}` : "summary:",
      agent.summary || "(empty summary)",
    );
  }

  return lines.filter((line) => line !== "").join("\n");
}
