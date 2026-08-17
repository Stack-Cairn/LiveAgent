// Per-conversation extraction controller: the single owner of extraction
// lifecycle state. Fixes three defects of the old pipeline:
//  - throttle TOCTOU: gating + claim happen synchronously before any await;
//  - abort races: each run owns its AbortController and links the originating
//    chat userStop signal without sharing request-scoped controller churn;
//  - state leaks: dispose() clears a conversation's state on deletion, and an
//    LRU cap bounds the map.
// Concurrency model is coalesce-skip: at most one run per conversation; while
// one is running, the newest request is parked and re-gated on completion
// (the engine reads conversation state at run time, so one queued run covers
// every turn that landed meanwhile).

import {
  EXTRACTION_CONVERSATION_STATE_LIMIT,
  EXTRACTION_WRITTEN_SLUG_LIMIT,
} from "@liveagent/ui/lib/memory/config";
import { extractLatestUserText } from "../../memory/extraction/context";
import { extractionSkipReason, isConfirmationDeferral } from "../../memory/extraction/gating";
import type { MemoryExtractionEngineParams, MemoryExtractionResult } from "./extractionEngine";

type EngineFn = (params: MemoryExtractionEngineParams) => Promise<MemoryExtractionResult>;
let engineOverride: EngineFn | null = null;

async function runExtractionEngine(
  params: MemoryExtractionEngineParams,
): Promise<MemoryExtractionResult> {
  if (engineOverride) return engineOverride(params);
  const { runMemoryExtraction } = await import("./extractionEngine");
  return runMemoryExtraction(params);
}

/** Test seam: swap the engine so controller semantics (atomic claim,
 *  coalescing, abort, LRU) are testable without an LLM. */
export function __setMemoryExtractionEngineForTests(next: EngineFn | null) {
  engineOverride = next;
}

export type MemoryExtractionRequest = Omit<
  MemoryExtractionEngineParams,
  "alreadyWrittenSlugs" | "confirmationDeferralOnly"
>;

type ConversationExtractionState = {
  phase: "idle" | "running";
  lastRunAt?: number;
  lastExtractedUserKey?: string;
  writtenSlugs: string[];
  abort?: AbortController;
  queued?: MemoryExtractionRequest;
};

const SKIPPED_RESULT: Omit<MemoryExtractionResult, "skipped"> = {
  ok: true,
  acceptedCount: 0,
  rejectedCount: 0,
  writtenSlugs: [],
  emittedMessages: [],
};

const states = new Map<string, ConversationExtractionState>();

function ensureState(conversationId: string): ConversationExtractionState {
  let state = states.get(conversationId);
  if (!state) {
    state = { phase: "idle", writtenSlugs: [] };
    states.set(conversationId, state);
    pruneStates();
  }
  return state;
}

function pruneStates() {
  if (states.size <= EXTRACTION_CONVERSATION_STATE_LIMIT) return;
  const sorted = [...states.entries()].sort(
    (a, b) => (a[1].lastRunAt ?? 0) - (b[1].lastRunAt ?? 0),
  );
  for (const [key, state] of sorted.slice(0, states.size - EXTRACTION_CONVERSATION_STATE_LIMIT)) {
    if (state.phase === "running") continue;
    states.delete(key);
  }
}

function userMessageKey(messages: MemoryExtractionRequest["messages"], text: string): string {
  return `${messages.length}:${text.length}:${text.slice(0, 80)}`;
}

function noteWrittenSlugs(state: ConversationExtractionState, slugs: readonly string[]) {
  for (const slug of slugs) {
    if (!slug || state.writtenSlugs.includes(slug)) continue;
    state.writtenSlugs.push(slug);
  }
  if (state.writtenSlugs.length > EXTRACTION_WRITTEN_SLUG_LIMIT) {
    state.writtenSlugs.splice(0, state.writtenSlugs.length - EXTRACTION_WRITTEN_SLUG_LIMIT);
  }
}

async function process(
  conversationId: string,
  request: MemoryExtractionRequest,
  fromQueue = false,
): Promise<MemoryExtractionResult> {
  const state = ensureState(conversationId);

  if (state.phase === "running") {
    // Coalesce: keep only the newest request; it re-enters gating when the
    // in-flight run completes.
    state.queued = request;
    return { ...SKIPPED_RESULT, skipped: "coalesced-into-running-extraction" };
  }

  const latestUserText = extractLatestUserText(request.messages);
  const currentUserKey = userMessageKey(request.messages, latestUserText);
  const now = Date.now();
  // Strict pass decides outright; the lenient pass (unknown hypothesis) only
  // differs for short confirmation replies, which the engine settles after
  // loading candidates.
  const strictReason = extractionSkipReason({
    latestUserText,
    // A dequeued request already waited behind the in-flight run — the queue
    // itself is the throttle, so min-interval does not apply to it.
    lastRunAt: fromQueue ? undefined : state.lastRunAt,
    lastExtractedUserKey: state.lastExtractedUserKey,
    currentUserKey,
    hasConfirmableHypothesis: false,
    now,
  });
  const deferral = isConfirmationDeferral(strictReason, latestUserText);
  if (strictReason && !deferral) {
    console.debug(`Memory extraction skipped: ${strictReason}`);
    return { ...SKIPPED_RESULT, skipped: strictReason };
  }

  // Atomic claim — no awaits between the gate above and these writes.
  state.phase = "running";
  state.lastRunAt = now;
  state.lastExtractedUserKey = currentUserKey;
  const abort = new AbortController();
  state.abort = abort;
  const parentSignal = request.signal;
  const abortFromParent = () => abort.abort();
  if (parentSignal?.aborted) {
    abort.abort();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    const result = await runExtractionEngine({
      ...request,
      alreadyWrittenSlugs: [...state.writtenSlugs],
      confirmationDeferralOnly: deferral,
      signal: abort.signal,
    });
    noteWrittenSlugs(state, result.writtenSlugs);
    return result;
  } finally {
    state.phase = "idle";
    state.abort = undefined;
    const queued = state.queued;
    state.queued = undefined;
    parentSignal?.removeEventListener("abort", abortFromParent);
    if (queued && !abort.signal.aborted) {
      void process(conversationId, queued, true);
    }
  }
}

export const memoryExtraction = {
  /** Fire-and-forget or awaited entry from the turn runners. */
  requestExtraction(request: MemoryExtractionRequest): Promise<MemoryExtractionResult> {
    const key = request.conversationId.trim();
    if (!key) {
      return Promise.resolve({ ...SKIPPED_RESULT, skipped: "missing-conversation-id" });
    }
    return process(key, request);
  },

  /** New user turn: reset per-turn dedup state. The originating turn's
   *  userStop signal owns cancellation of any in-flight extraction. */
  noteTurnBoundary(conversationId: string) {
    const state = states.get(conversationId.trim());
    if (!state) return;
    state.writtenSlugs = [];
    state.lastRunAt = undefined;
  },

  /** Conversation deleted: cancel any in-flight run and drop all state. */
  dispose(conversationId: string) {
    const key = conversationId.trim();
    const state = states.get(key);
    if (!state) return;
    state.queued = undefined;
    state.abort?.abort();
    states.delete(key);
  },

  /** App teardown. */
  disposeAll() {
    for (const state of states.values()) {
      state.queued = undefined;
      state.abort?.abort();
    }
    states.clear();
  },
};
