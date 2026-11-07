// Desktop pending store for MCP form elicitations (K-brain `elicitation.*`). The turn
// runner registers each request with the function that posts its answer; the transcript
// card (local) and the gateway queue action (WebUI) answer through answerMcpElicitation.
// Resolved records are kept per tool call so the live transcript shows the summary before
// the tool result arrives. Typed answers are never stored here: they pass straight to
// K-brain, and the records only hold K-brain's redacted copy.

import {
  MCP_ELICITATION_PENDING_ARG,
  MCP_ELICITATION_RECORDS_ARG,
  type McpElicitationAction,
  type McpElicitationContent,
  type McpElicitationRecord,
  type McpElicitationRequest,
  type McpElicitationSubmitOutcome,
} from "@liveagent/ui/lib/chat/mcpElicitation";

type PendingElicitation = {
  conversationId: string;
  request: McpElicitationRequest;
  answer: (
    action: McpElicitationAction,
    content?: McpElicitationContent,
  ) => Promise<McpElicitationSubmitOutcome>;
};

type LiveRecords = { conversationId: string; records: McpElicitationRecord[] };

const pendingById = new Map<string, PendingElicitation>();
const recordsByToolCallId = new Map<string, LiveRecords>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribeMcpElicitations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMcpElicitationVersion() {
  return version;
}

function emitChange() {
  version += 1;
  for (const listener of Array.from(listeners)) listener();
}

/** Registers a request until it is resolved or `signal` aborts (run ended, resolved). */
export function registerMcpElicitation(params: {
  conversationId: string;
  request: McpElicitationRequest;
  answer: PendingElicitation["answer"];
  signal: AbortSignal;
}) {
  const { request } = params;
  if (params.signal.aborted || pendingById.has(request.elicitationId)) return;
  pendingById.set(request.elicitationId, {
    conversationId: params.conversationId,
    request,
    answer: params.answer,
  });
  params.signal.addEventListener(
    "abort",
    () => {
      if (pendingById.get(request.elicitationId)?.request === request) {
        pendingById.delete(request.elicitationId);
        emitChange();
      }
    },
    { once: true },
  );
  emitChange();
}

/** Records K-brain's resolution (sensitive values already removed) and closes the form. */
export function recordMcpElicitationResolution(
  conversationId: string,
  toolCallId: string,
  record: McpElicitationRecord,
) {
  if (record.elicitationId) pendingById.delete(record.elicitationId);
  const entry = recordsByToolCallId.get(toolCallId) ?? { conversationId, records: [] };
  if (
    !record.elicitationId ||
    !entry.records.some((existing) => existing.elicitationId === record.elicitationId)
  ) {
    entry.records = [...entry.records, record];
  }
  recordsByToolCallId.set(toolCallId, entry);
  emitChange();
}

export function hasPendingMcpElicitationRequest(toolCallId: string, elicitationId: string) {
  const pending = pendingById.get(elicitationId);
  return Boolean(pending && pending.request.toolCallId === toolCallId);
}

const ACTIONS = new Set<McpElicitationAction>(["accept", "decline", "cancel"]);

/**
 * Answers a pending request. Remote answers must name the conversation, so a WebUI client
 * cannot answer a form of another conversation. The form stays registered until K-brain's
 * `elicitation.resolved` arrives; a 400 keeps it open with the server's field errors.
 */
export async function answerMcpElicitation(
  toolCallId: string,
  elicitationId: string,
  action: unknown,
  content?: unknown,
  options?: { conversationId?: string },
): Promise<McpElicitationSubmitOutcome> {
  const pending = pendingById.get(elicitationId.trim());
  if (!pending || pending.request.toolCallId !== toolCallId.trim()) {
    return { ok: false, message: "This form is no longer pending." };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, message: "This form belongs to a different conversation." };
  }
  if (typeof action !== "string" || !ACTIONS.has(action as McpElicitationAction)) {
    return { ok: false, message: "Unknown answer action." };
  }
  if (
    action === "accept" &&
    (typeof content !== "object" || content === null || Array.isArray(content))
  ) {
    return { ok: false, message: "An accepted answer needs content." };
  }
  return pending.answer(
    action as McpElicitationAction,
    action === "accept" ? (content as McpElicitationContent) : undefined,
  );
}

/**
 * Synthetic arguments describing the call's elicitations, for the live transcript and the
 * tool_call events synced to the WebUI. Empty when the call has none.
 */
export function mcpElicitationArgsOverlay(toolCallId: string): Record<string, unknown> {
  const pending = Array.from(pendingById.values())
    .filter((entry) => entry.request.toolCallId === toolCallId)
    .map((entry) => entry.request);
  const records = recordsByToolCallId.get(toolCallId)?.records ?? [];
  return {
    ...(pending.length > 0 ? { [MCP_ELICITATION_PENDING_ARG]: pending } : {}),
    ...(records.length > 0 ? { [MCP_ELICITATION_RECORDS_ARG]: records } : {}),
  };
}

/** Forgets everything of a conversation (end of turn; the history reload carries records). */
export function clearMcpElicitationsForConversation(conversationId: string) {
  let changed = false;
  for (const [id, pending] of pendingById) {
    if (pending.conversationId === conversationId) {
      pendingById.delete(id);
      changed = true;
    }
  }
  for (const [toolCallId, entry] of recordsByToolCallId) {
    if (entry.conversationId === conversationId) {
      recordsByToolCallId.delete(toolCallId);
      changed = true;
    }
  }
  if (changed) emitChange();
}
