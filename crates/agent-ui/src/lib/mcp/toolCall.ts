// K-brain's POST /v1/mcp/tools/call reply and its approval round trip. Backends with
// capability `mcp_tool_call_approval` answer a tool under an "ask" policy with
// `status: "approval_required"` instead of running it; the caller shows the approval to
// the user and repeats the identical request with `approval_id`. Older backends run the
// tool right away and reply without `status`.

/** K-brain capability names of the MCP tool contract (all integer, compared with 1). */
export const KBRAIN_MCP_APPS_STRUCTURED_CONTENT_CAPABILITY = "mcp_apps_structured_content";
export const KBRAIN_MCP_TOOL_VISIBILITY_CAPABILITY = "mcp_tool_visibility";
export const KBRAIN_MCP_TOOL_CALL_APPROVAL_CAPABILITY = "mcp_tool_call_approval";
export const KBRAIN_MCP_TOOL_SERVER_IDS_CAPABILITY = "mcp_tool_server_ids";

type McpToolCallStatus = "completed" | "failed" | "cancelled" | "approval_required";

export type McpToolCallApproval = {
  id: string;
  /** Model-facing tool name (`mcp__<serverKey>__<tool>`). */
  name: string;
  /** Configured server id and the server's own tool name, when the backend knows them. */
  serverId: string;
  toolName: string;
  policy: string;
  arguments: unknown;
  expiresAt: string;
};

export type McpToolCallResponse = {
  name: string;
  output: string;
  failed: boolean;
  cancelled: boolean;
  status: McpToolCallStatus;
  /** The server's raw CallToolResult, returned to an MCP App view as-is. */
  result?: Record<string, unknown>;
  approval?: McpToolCallApproval;
};

/** Optional request fields; send each only when its capability is present. */
export type McpToolCallExtras = {
  caller?: "model" | "app";
  approvalId?: string;
};

const STATUSES = new Set<McpToolCallStatus>([
  "completed",
  "failed",
  "cancelled",
  "approval_required",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseApproval(value: unknown): McpToolCallApproval | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;
  return {
    id,
    name: readString(value.name),
    serverId: readString(value.server_id),
    toolName: readString(value.tool_name),
    policy: readString(value.policy),
    arguments: value.arguments ?? {},
    expiresAt: readString(value.expires_at),
  };
}

/**
 * Normalizes a POST /v1/mcp/tools/call reply. Without `status` (older backends) it is
 * derived from `cancelled`/`failed`; an approval_required reply without a usable
 * `approval` counts as failed.
 */
export function parseMcpToolCallResponse(body: unknown): McpToolCallResponse {
  const record = isRecord(body) ? body : {};
  const cancelled = record.cancelled === true;
  const failed = record.failed === true;
  const approval = parseApproval(record.approval);
  let status: McpToolCallStatus =
    typeof record.status === "string" && STATUSES.has(record.status as McpToolCallStatus)
      ? (record.status as McpToolCallStatus)
      : cancelled
        ? "cancelled"
        : failed
          ? "failed"
          : "completed";
  if (status === "approval_required" && !approval) status = "failed";
  return {
    name: readString(record.name),
    output: readString(record.output),
    failed: failed || cancelled || status === "failed" || status === "cancelled",
    cancelled,
    status,
    ...(isRecord(record.result) ? { result: record.result } : {}),
    ...(status === "approval_required" && approval ? { approval } : {}),
  };
}

/** The JSON request body; `caller`/`approval_id` only when given (older backends 400 on them). */
export function mcpToolCallRequestBody(
  name: string,
  args: Record<string, unknown>,
  cwd: string | undefined,
  extras: McpToolCallExtras = {},
) {
  return {
    name,
    arguments: args,
    ...(cwd ? { cwd } : {}),
    ...(extras.caller ? { caller: extras.caller } : {}),
    ...(extras.approvalId ? { approval_id: extras.approvalId } : {}),
  };
}

/** What an MCP App view gets back from tools/call: the raw result, else the text output. */
export function mcpToolCallViewResult(response: McpToolCallResponse): Record<string, unknown> {
  if (response.result) return response.result;
  return { content: [{ type: "text", text: response.output }], isError: response.failed };
}

/** The approval of a repeated call was unknown, expired, used, or for another call (409). */
export class McpToolApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolApprovalConflictError";
  }
}

function httpStatus(error: unknown) {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

export type McpToolApprovalOutcome =
  | { kind: "done"; response: McpToolCallResponse }
  | { kind: "denied"; approval: McpToolCallApproval };

/**
 * Runs one call through the approval loop: call; on approval_required ask `approve`, and
 * when it agrees repeat the same call with the approval id. A 409 on the repeat becomes
 * McpToolApprovalConflictError; a second approval_required is reported as failed.
 */
export async function runMcpToolCallWithApproval(options: {
  call: (approvalId?: string) => Promise<McpToolCallResponse>;
  approve: (approval: McpToolCallApproval) => Promise<boolean>;
}): Promise<McpToolApprovalOutcome> {
  const first = await options.call();
  if (first.status !== "approval_required" || !first.approval) {
    return { kind: "done", response: first };
  }
  const approval = first.approval;
  if (!(await options.approve(approval))) return { kind: "denied", approval };
  let second: McpToolCallResponse;
  try {
    second = await options.call(approval.id);
  } catch (error) {
    if (httpStatus(error) === 409) {
      throw new McpToolApprovalConflictError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  if (second.status === "approval_required") {
    const { approval: _ignored, ...rest } = second;
    return { kind: "done", response: { ...rest, status: "failed", failed: true } };
  }
  return { kind: "done", response: second };
}
