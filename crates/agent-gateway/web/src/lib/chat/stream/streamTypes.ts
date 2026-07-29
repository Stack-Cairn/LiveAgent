import type { ChatEvent } from "@/lib/gatewayTypes";

// Wire types for the conversation-scoped chat stream protocol.
//
// One persistent subscription per conversation carries every run: run
// boundaries are events inside the stream (run_started / run_finished), all
// events carry first-class conversation_id / run_id / seq, and reconnects
// resume from the last seen seq.

export type RunFinishedStatus = "completed" | "failed" | "cancelled";

export type RunLifecycleEvent =
  | {
      type: "run_started";
      conversation_id: string;
      run_id: string;
      seq: number;
      client_request_id?: string;
      workdir?: string;
    }
  | {
      type: "run_finished";
      conversation_id: string;
      run_id: string;
      seq: number;
      status: RunFinishedStatus;
      error_code?: string;
      message?: string;
      reason?: string;
      title?: string;
      client_request_id?: string;
    }
  | {
      type: "run_queued";
      conversation_id: string;
      run_id: string;
      seq: number;
      client_request_id?: string;
    }
  | {
      type: "snapshot";
      conversation_id: string;
      run_id: string;
      revision?: number;
      entries_json?: string;
      tool_status?: string | null;
      tool_status_is_compaction?: boolean;
      // The conversation log seq this snapshot represents through: events
      // with seq <= as_of_seq are already folded into entries_json.
      as_of_seq?: number;
    }
  | {
      type: "run_content_snapshot";
      conversation_id: string;
      run_id: string;
      seq: number;
      revision: number;
      entries_json: string;
      content_complete: boolean;
      history_required?: boolean;
      sha256?: string;
    };

export type ConversationStreamEvent = (ChatEvent | RunLifecycleEvent) & {
  conversation_id?: string;
  run_id?: string;
  seq?: number;
};

export type RunActivityState = "queued" | "running" | "cancelling";

export type StreamRunActivity = {
  runId: string;
  state: RunActivityState;
  startedSeq: number;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
  clientRequestId?: string;
  updatedAt: number;
};

export type StreamRunSnapshot = {
  runId: string;
  revision: number;
  entriesJson: string;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
  // The log seq the snapshot content covers through (dedup barrier for the
  // overlapping event replay).
  asOfSeq: number;
};

// Parsed chat.subscribe response.
export type ConversationSubscribeResult = {
  conversationId: string;
  streamEpoch: string;
  latestSeq: number;
  reset: boolean;
  activity: StreamRunActivity | null;
  snapshot: StreamRunSnapshot | null;
  events: ConversationStreamEvent[];
};

// chat.activity broadcast: the single source for sidebar dots / busy state of
// non-visible conversations.
export type ConversationActivityEvent = {
  conversationId: string;
  runId: string | null;
  running: boolean;
  state: RunActivityState | null;
  workdir: string | null;
  clientRequestId: string | null;
  updatedAt: number;
};

// chat.command_update push: pre-stream outcomes of a submitted command,
// delivered only to the issuing connection.
export type ChatCommandUpdate = {
  runId: string;
  clientRequestId: string;
  conversationId: string | null;
  phase: "bound" | "queued_in_gui" | "failed";
  errorCode: string | null;
  message: string | null;
};

export type ChatCommandAccepted = {
  runId: string;
  conversationId: string;
  acceptedSeq: number;
};

export type ConversationStreamHandlers = {
  // A chat.subscribe round-trip completed (initial subscribe, reconnect
  // resume, or reset recovery). When reset is true the local tail must be
  // rebuilt from snapshot + events.
  onSync(result: ConversationSubscribeResult): void;
  // A live pushed event.
  onEvent(event: ConversationStreamEvent): void;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeRunActivity(raw: unknown): StreamRunActivity | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const runId = readString(value.run_id).trim();
  if (!runId) {
    return null;
  }
  const state = readString(value.state).trim();
  return {
    runId,
    state: state === "queued" || state === "cancelling" ? state : "running",
    startedSeq: readNumber(value.started_seq),
    toolStatus: readString(value.tool_status).trim() || null,
    toolStatusIsCompaction: value.tool_status_is_compaction === true,
    clientRequestId: readString(value.client_request_id).trim() || undefined,
    updatedAt: readNumber(value.updated_at),
  };
}

export function normalizeRunSnapshot(raw: unknown): StreamRunSnapshot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const runId = readString(value.run_id).trim();
  if (!runId) {
    return null;
  }
  return {
    runId,
    revision: readNumber(value.revision),
    entriesJson: readString(value.entries_json),
    toolStatus: readString(value.tool_status).trim() || null,
    toolStatusIsCompaction: value.tool_status_is_compaction === true,
    asOfSeq: readNumber(value.as_of_seq),
  };
}

export function normalizeSubscribeResult(
  conversationId: string,
  raw: unknown,
): ConversationSubscribeResult {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const events = Array.isArray(value.events)
    ? (value.events.filter(
        (event) => event && typeof event === "object",
      ) as ConversationStreamEvent[])
    : [];
  return {
    conversationId: readString(value.conversation_id).trim() || conversationId,
    streamEpoch: readString(value.stream_epoch).trim(),
    latestSeq: readNumber(value.latest_seq),
    reset: value.reset === true,
    activity: normalizeRunActivity(value.activity),
    snapshot: normalizeRunSnapshot(value.snapshot),
    events,
  };
}

export function normalizeActivityEvent(raw: unknown): ConversationActivityEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const conversationId = readString(value.conversation_id).trim();
  if (!conversationId) {
    return null;
  }
  const state = readString(value.state).trim();
  return {
    conversationId,
    runId: readString(value.run_id).trim() || null,
    running: value.running === true,
    state: state === "queued" || state === "running" || state === "cancelling" ? state : null,
    workdir: readString(value.workdir).trim() || null,
    clientRequestId: readString(value.client_request_id).trim() || null,
    updatedAt: readNumber(value.updated_at),
  };
}

export function normalizeCommandUpdate(raw: unknown): ChatCommandUpdate | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const runId = readString(value.run_id).trim();
  const phase = readString(value.phase).trim();
  if (!runId || (phase !== "bound" && phase !== "queued_in_gui" && phase !== "failed")) {
    return null;
  }
  return {
    runId,
    clientRequestId: readString(value.client_request_id).trim(),
    conversationId: readString(value.conversation_id).trim() || null,
    phase,
    errorCode: readString(value.error_code).trim() || null,
    message: readString(value.message).trim() || null,
  };
}

export function readEventSeq(event: ConversationStreamEvent): number {
  const seq = (event as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
}

export function readEventRunId(event: ConversationStreamEvent): string {
  const runId = (event as { run_id?: unknown }).run_id;
  return typeof runId === "string" ? runId.trim() : "";
}

export function readEventConversationId(event: ConversationStreamEvent): string {
  const conversationId = (event as { conversation_id?: unknown }).conversation_id;
  return typeof conversationId === "string" ? conversationId.trim() : "";
}
