import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import type {
  SubagentBatchDetails,
  SubagentBatchIssue,
  SubagentRosterEntry,
  SubagentTemplateEntry,
} from "./protocol";

export type SubagentIssueCode =
  | "invalid_arguments"
  | "duplicate_agent_id"
  | "unknown_agent_id"
  | "unknown_template"
  | "identity_conflict"
  | "worktree_unavailable"
  | "output_path_outside_workspace"
  | "unknown_recipient"
  | "provision_failed";

export type SubagentIssue = {
  agentId?: string;
  code: SubagentIssueCode;
  message: string;
};

export function issue(code: SubagentIssueCode, message: string, agentId?: string): SubagentIssue {
  return agentId ? { agentId, code, message } : { code, message };
}

/** Uniform error tool-result constructor used by every subagent tool path. */
export function toolErrorResult(
  toolCall: ToolCall,
  text: string,
  details: ToolResultMessage["details"] = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details,
    isError: true,
    timestamp: Date.now(),
  };
}

export function buildRejectedBatchDetails(params: {
  issues: SubagentIssue[];
  roster: SubagentRosterEntry[];
  templates: SubagentTemplateEntry[];
  concurrency?: number;
}): SubagentBatchDetails {
  return {
    kind: "subagent_batch",
    status: "rejected",
    agentCount: 0,
    concurrency: params.concurrency ?? 0,
    totalDurationMs: 0,
    mode: "readonly",
    agents: [],
    issues: params.issues.map((item): SubagentBatchIssue => ({ ...item })),
    roster: params.roster,
    templates: params.templates,
  };
}

/**
 * Text rendering of a rejected batch. Mirrors the structured details so the
 * model can self-correct from either representation.
 */
export function renderBatchRejectionText(params: {
  issues: SubagentIssue[];
  roster: SubagentRosterEntry[];
  templates: SubagentTemplateEntry[];
}) {
  const lines = [
    "Agent rejected this call. No subagents were started. Fix every issue and retry with one corrected call.",
    "",
    "Issues:",
    ...params.issues.map((item, index) => {
      const scope = item.agentId ? ` agent=${item.agentId}` : "";
      return `${index + 1}. [${item.code}]${scope} ${item.message}`;
    }),
  ];
  if (params.roster.length > 0) {
    lines.push(
      "",
      "Existing agents (reuse these ids to resume):",
      ...params.roster.map((entry) => {
        const status = entry.lastStatus ? ` status=${entry.lastStatus}` : "";
        return `- id=${entry.id} name=${entry.name} role=${entry.role} mode=${entry.lastMode}${status}`;
      }),
    );
  } else {
    lines.push("", "No existing agents are recorded for this conversation.");
  }
  if (params.templates.length > 0) {
    lines.push(
      "",
      "Enabled templates (reference by template=<id>):",
      ...params.templates.map((entry) => {
        const description = entry.description ? ` - ${entry.description}` : "";
        return `- ${entry.id} (${entry.name})${description}`;
      }),
    );
  }
  return lines.join("\n");
}
