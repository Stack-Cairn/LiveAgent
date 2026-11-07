// WebUI answer bridge for MCP elicitation forms. The card sits deep in the transcript; the
// submit action is registered by GatewayApp and goes through gateway
// chat_queue.mcp_elicitation (to the desktop pending store, or straight to K-brain when the
// gateway relays the run itself). Module-level singleton, like the question bridge.
import type {
  McpElicitationAction,
  McpElicitationContent,
  McpElicitationSubmitOutcome,
} from "@liveagent/ui/lib/chat/mcpElicitation";

type McpElicitationAnswerHandler = (
  toolCallId: string,
  elicitationId: string,
  action: McpElicitationAction,
  content?: McpElicitationContent,
) => Promise<McpElicitationSubmitOutcome>;

let handler: McpElicitationAnswerHandler | null = null;

export function registerMcpElicitationAnswerHandler(next: McpElicitationAnswerHandler | null) {
  handler = next;
}

export function hasMcpElicitationAnswerHandler() {
  return handler !== null;
}

export function submitMcpElicitationAnswer(
  toolCallId: string,
  elicitationId: string,
  action: McpElicitationAction,
  content?: McpElicitationContent,
): Promise<McpElicitationSubmitOutcome> {
  if (!handler) {
    return Promise.resolve({ ok: false, message: "Gateway connection is not ready." });
  }
  return handler(toolCallId, elicitationId, action, content);
}

/** The request_json of chat_queue.mcp_elicitation. */
export function buildMcpElicitationRequestJson(
  elicitationId: string,
  action: McpElicitationAction,
  content?: McpElicitationContent,
) {
  return JSON.stringify({
    elicitationId,
    action,
    ...(action === "accept" ? { content: content ?? {} } : {}),
  });
}

/** Per-field messages of a refused answer (HTTP 400), carried in item_json. */
export function readMcpElicitationFieldErrors(
  itemJson: string | undefined,
): Record<string, string> | undefined {
  if (!itemJson?.trim()) return undefined;
  try {
    const parsed = JSON.parse(itemJson) as { field_errors?: unknown };
    const raw = parsed?.field_errors;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const out: Record<string, string> = {};
    for (const [name, text] of Object.entries(raw as Record<string, unknown>)) {
      if (name && typeof text === "string") out[name] = text;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
