import type { Message } from "@earendil-works/pi-ai";
import { invoke } from "../../../lib/tauriBridge";
import { listen } from "../../../lib/tauriBridge";
import { useCallback, useEffect, useRef } from "react";

import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import {
  buildGatewayRuntimeSnapshotEntries,
  type GatewayRuntimeSnapshotState,
} from "./chatRuntimeSnapshot";

const CHAT_INGRESS_BATCH_MAX_RECORDS = 64;
const CHAT_INGRESS_BATCH_MAX_BYTES = 64 * 1024;
const CHAT_INGRESS_BATCH_MAX_DELAY_MS = 25;
const CHAT_INGRESS_HEARTBEAT_MS = 60_000;
const CHAT_INGRESS_COMPLETED_RUN_RETENTION_MS = 10 * 60_000;
// Bound for mirrors that can no longer make progress: never-registered
// orphans of early failure paths, and closing runs whose terminal commit
// failed for good. Without it they would sit in the map (and heartbeat, for
// the former) until app exit.
const CHAT_INGRESS_ABANDONED_RUN_TTL_MS = 10 * 60_000;

type GatewayIngressRecordInput = {
  eventJson: string;
  workerId?: string;
};

type PendingGatewayIngressRecord = {
  event: Record<string, unknown>;
  eventJson: string;
  workerId?: string;
  encodedBytes: number;
};

type GatewayRunMirror = {
  runId: string;
  conversationId: string;
  workerId?: string;
  userMessage?: Message;
  transcriptStore?: LiveTranscriptStore;
  revision: number;
  state: GatewayRuntimeSnapshotState;
  pendingRecords: PendingGatewayIngressRecord[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  operationChain: Promise<void>;
  locallyAcceptedThrough: number | null;
  lastError: unknown | null;
  closing: boolean;
  lastExternalEventAt: number;
  runningCheckpointCommit: Promise<void> | null;
  terminalPersisted: boolean;
  terminalCheckpoint: GatewayRunTerminalCheckpoint | null;
  terminalCommit: Promise<GatewayChatCheckpointCommitResult> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

type GatewayRunTerminalCheckpoint = {
  revision: number;
  entriesJson: string;
  state: GatewayRuntimeSnapshotState;
  errorCode?: string;
  errorMessage?: string;
  contentComplete: boolean;
  historyRequired: boolean;
};

export type GatewayChatIngressBatchResult = {
  firstSeq: number;
  lastSeq: number;
  locallyAccepted: boolean;
};

export type GatewayChatCheckpointCommitResult = {
  sourceSeq: number;
  durablyPersisted: boolean;
  sha256: string;
};

export type GatewayRunMirrorCheckpointRequest = {
  runId: string;
  conversationId: string;
  reason: string;
  expectedNextSeq?: number;
  deltaRecords?: number;
  deltaBytes?: number;
  journalBytes?: number;
};

export type RegisterGatewayRunMirrorInput = {
  runId: string;
  conversationId: string;
  workerId?: string;
  userMessage: Message;
  transcriptStore: LiveTranscriptStore;
  state?: GatewayRuntimeSnapshotState;
};

export type FinishGatewayRunMirrorInput = {
  runId: string;
  conversationId: string;
  entriesJson: string;
  state: GatewayRuntimeSnapshotState;
  errorCode?: string;
  errorMessage?: string;
  contentComplete: boolean;
  historyRequired?: boolean;
};

const textEncoder = new TextEncoder();

function encodePendingRecord(event: Record<string, unknown>, workerId?: string) {
  const eventJson = JSON.stringify(event);
  return {
    eventJson,
    encodedBytes:
      textEncoder.encode(eventJson).byteLength +
      (workerId ? textEncoder.encode(workerId).byteLength : 0) +
      16,
  };
}

function encodedBatchBaseBytes(run: GatewayRunMirror) {
  return (
    textEncoder.encode(run.runId).byteLength +
    textEncoder.encode(run.conversationId).byteLength +
    32
  );
}

function isPlainTextDelta(event: Record<string, unknown>) {
  if (event.type !== "token" && event.type !== "thinking") {
    return false;
  }
  if (typeof event.text !== "string" || event.text.length === 0) {
    return false;
  }
  return Object.keys(event).every(
    (key) => key === "type" || key === "text" || key === "conversation_id" || key === "round",
  );
}

function canMergeTextDelta(
  previous: PendingGatewayIngressRecord,
  event: Record<string, unknown>,
  workerId?: string,
) {
  return (
    previous.workerId === workerId &&
    isPlainTextDelta(previous.event) &&
    isPlainTextDelta(event) &&
    previous.event.type === event.type &&
    previous.event.conversation_id === event.conversation_id &&
    previous.event.round === event.round
  );
}

function toIngressRecord(record: PendingGatewayIngressRecord): GatewayIngressRecordInput {
  return {
    eventJson: record.eventJson,
    ...(record.workerId ? { workerId: record.workerId } : {}),
  };
}

function assertAcceptedSequence(
  run: GatewayRunMirror,
  firstSeq: number,
  lastSeq: number,
  recordCount: number,
) {
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 1) {
    throw new Error(`gateway chat ingress returned invalid first_seq: ${firstSeq}`);
  }
  if (!Number.isSafeInteger(lastSeq) || lastSeq < firstSeq) {
    throw new Error(`gateway chat ingress returned invalid last_seq: ${lastSeq}`);
  }
  if (lastSeq - firstSeq + 1 !== recordCount) {
    throw new Error(
      `gateway chat ingress accepted sequence range does not match record count: ${firstSeq}-${lastSeq} for ${recordCount}`,
    );
  }
  if (run.locallyAcceptedThrough !== null && firstSeq !== run.locallyAcceptedThrough + 1) {
    throw new Error(
      `gateway chat ingress accepted a non-contiguous sequence: expected ${run.locallyAcceptedThrough + 1}, received ${firstSeq}`,
    );
  }
  run.locallyAcceptedThrough = lastSeq;
}

function createRunMirror(
  runId: string,
  conversationId: string,
  workerId?: string,
): GatewayRunMirror {
  return {
    runId,
    conversationId,
    workerId,
    revision: 0,
    state: "running",
    pendingRecords: [],
    pendingBytes: 0,
    flushTimer: null,
    operationChain: Promise.resolve(),
    locallyAcceptedThrough: null,
    lastError: null,
    closing: false,
    lastExternalEventAt: Date.now(),
    runningCheckpointCommit: null,
    terminalPersisted: false,
    terminalCheckpoint: null,
    terminalCommit: null,
    cleanupTimer: null,
  };
}

export function useGatewayRunMirrorCoordinator() {
  const runsRef = useRef(new Map<string, GatewayRunMirror>());

  const ensureRun = useCallback((runId: string, conversationId: string, workerId?: string) => {
    const normalizedRunId = runId.trim();
    const normalizedConversationId = conversationId.trim();
    let run = runsRef.current.get(normalizedRunId);
    if (!run) {
      run = createRunMirror(
        normalizedRunId,
        normalizedConversationId,
        workerId?.trim() || undefined,
      );
      runsRef.current.set(normalizedRunId, run);
      return run;
    }
    if (normalizedConversationId) {
      run.conversationId = normalizedConversationId;
    }
    if (workerId?.trim()) {
      run.workerId = workerId.trim();
    }
    return run;
  }, []);

  const enqueueOperation = useCallback(
    <T>(run: GatewayRunMirror, operation: () => Promise<T>): Promise<T> => {
      const result = run.operationChain.then(operation);
      run.operationChain = result.then(
        () => undefined,
        (error) => {
          run.lastError = error;
          console.error("gateway chat ingress operation failed", {
            runId: run.runId,
            conversationId: run.conversationId,
            error,
          });
        },
      );
      return result;
    },
    [],
  );

  const flushRun = useCallback(
    (run: GatewayRunMirror): Promise<GatewayChatIngressBatchResult> | null => {
      if (run.flushTimer !== null) {
        clearTimeout(run.flushTimer);
        run.flushTimer = null;
      }
      if (run.pendingRecords.length === 0) {
        return null;
      }
      const records = run.pendingRecords.map(toIngressRecord);
      run.pendingRecords = [];
      run.pendingBytes = 0;
      return enqueueOperation(run, async () => {
        const result = await invoke<GatewayChatIngressBatchResult>(
          "gateway_send_chat_ingress_batch",
          {
            input: {
              runId: run.runId,
              conversationId: run.conversationId,
              records,
            },
          },
        );
        if (result.locallyAccepted !== true) {
          throw new Error("gateway chat ingress batch was not locally accepted");
        }
        assertAcceptedSequence(run, result.firstSeq, result.lastSeq, records.length);
        return result;
      });
    },
    [enqueueOperation],
  );

  const commitCheckpoint = useCallback(
    (
      run: GatewayRunMirror,
      input: {
        kind: "checkpoint" | "terminal";
        revision?: number;
        entriesJson: string;
        state: GatewayRuntimeSnapshotState;
        errorCode?: string;
        errorMessage?: string;
        contentComplete: boolean;
        historyRequired: boolean;
      },
    ) => {
      flushRun(run);
      const revision = input.revision ?? run.revision + 1;
      run.revision = Math.max(run.revision, revision);
      return enqueueOperation(run, async () => {
        const result = await invoke<GatewayChatCheckpointCommitResult>(
          "gateway_commit_chat_checkpoint",
          {
            input: {
              runId: run.runId,
              conversationId: run.conversationId,
              entriesJson: input.entriesJson,
              revision,
              kind: input.kind,
              state: input.state,
              errorCode: input.errorCode ?? "",
              errorMessage: input.errorMessage ?? "",
              contentComplete: input.contentComplete,
              historyRequired: input.historyRequired,
            },
          },
        );
        if (result.durablyPersisted !== true) {
          throw new Error(`gateway chat ${input.kind} checkpoint was not durably persisted`);
        }
        assertAcceptedSequence(run, result.sourceSeq, result.sourceSeq, 1);
        if (!result.sha256?.trim()) {
          throw new Error(`gateway chat ${input.kind} checkpoint returned an empty sha256`);
        }
        return result;
      });
    },
    [enqueueOperation, flushRun],
  );

  const commitRunningCheckpoint = useCallback(
    (run: GatewayRunMirror): Promise<void> => {
      if (run.closing) return Promise.resolve();
      if (run.runningCheckpointCommit) {
        return run.runningCheckpointCommit;
      }
      const checkpointCommit = (async () => {
        await Promise.resolve();
        if (run.closing) return;
        if (!run.userMessage || !run.transcriptStore) {
          const error = new Error(`gateway chat checkpoint source is unavailable: ${run.runId}`);
          run.lastError = error;
          console.error(error);
          return;
        }
        flushRun(run);
        const entries = buildGatewayRuntimeSnapshotEntries({
          userMessage: run.userMessage,
          liveTranscript: run.transcriptStore.getSnapshot(),
        });
        await commitCheckpoint(run, {
          kind: "checkpoint",
          entriesJson: JSON.stringify(entries),
          state: "running",
          // The live transcript store can lag events already sequenced ahead
          // of this checkpoint, so a running projection must never confirm
          // content: contentComplete stays false and history keeps the final
          // convergence authority. Only the terminal (built from persisted
          // state) may confirm.
          contentComplete: false,
          historyRequired: false,
        });
      })();
      run.runningCheckpointCommit = checkpointCommit;
      const clearCheckpointCommit = () => {
        if (run.runningCheckpointCommit === checkpointCommit) {
          run.runningCheckpointCommit = null;
        }
      };
      checkpointCommit.then(clearCheckpointCommit, clearCheckpointCommit);
      return checkpointCommit;
    },
    [commitCheckpoint, flushRun],
  );

  const scheduleFlush = useCallback(
    (run: GatewayRunMirror) => {
      if (run.flushTimer !== null) {
        return;
      }
      run.flushTimer = setTimeout(() => {
        run.flushTimer = null;
        flushRun(run);
      }, CHAT_INGRESS_BATCH_MAX_DELAY_MS);
    },
    [flushRun],
  );

  const queueGatewayBridgeEventForRequest = useCallback(
    (
      requestId: string,
      event: Record<string, unknown>,
      options?: { workerId?: string },
    ): Promise<void> | void => {
      // "done" and "error" are reserved lifecycle types on the reliable
      // ingress protocol: the gateway rejects them as deltas, and a rejected
      // record wedges the run's sequence ahead of its terminal forever. Their
      // content travels in the terminal record (state/error_code/error_message)
      // instead.
      if (event.type === "done" || event.type === "error") {
        return;
      }
      const conversationId =
        typeof event.conversation_id === "string" ? event.conversation_id.trim() : "";
      const run = ensureRun(requestId, conversationId, options?.workerId);
      if (event.type !== "run_heartbeat") {
        run.lastExternalEventAt = Date.now();
      }
      if (run.closing) {
        const error = new Error(`gateway chat run is already closing: ${requestId}`);
        run.lastError = error;
        console.error(error);
        return;
      }
      const workerId = options?.workerId?.trim() || run.workerId;
      const encoded = encodePendingRecord(event, workerId);
      const batchByteBudget = CHAT_INGRESS_BATCH_MAX_BYTES - encodedBatchBaseBytes(run);
      if (encoded.encodedBytes > batchByteBudget) {
        flushRun(run);
        return commitRunningCheckpoint(run);
      }
      const previous = run.pendingRecords.at(-1);
      if (previous && canMergeTextDelta(previous, event, workerId)) {
        const mergedEvent = {
          ...previous.event,
          text: `${String(previous.event.text ?? "")}${String(event.text ?? "")}`,
        };
        const merged = encodePendingRecord(mergedEvent, workerId);
        if (run.pendingBytes - previous.encodedBytes + merged.encodedBytes <= batchByteBudget) {
          run.pendingBytes = run.pendingBytes - previous.encodedBytes + merged.encodedBytes;
          previous.event = mergedEvent;
          previous.eventJson = merged.eventJson;
          previous.encodedBytes = merged.encodedBytes;
          scheduleFlush(run);
          return;
        }
      }
      if (
        run.pendingRecords.length >= CHAT_INGRESS_BATCH_MAX_RECORDS ||
        run.pendingBytes + encoded.encodedBytes > batchByteBudget
      ) {
        flushRun(run);
      }
      run.pendingRecords.push({
        event: { ...event },
        eventJson: encoded.eventJson,
        workerId,
        encodedBytes: encoded.encodedBytes,
      });
      run.pendingBytes += encoded.encodedBytes;
      if (
        run.pendingRecords.length >= CHAT_INGRESS_BATCH_MAX_RECORDS ||
        run.pendingBytes >= batchByteBudget
      ) {
        const flush = flushRun(run);
        return flush ? flush.then(() => undefined) : undefined;
      }
      scheduleFlush(run);
    },
    [commitRunningCheckpoint, ensureRun, flushRun, scheduleFlush],
  );

  const flushGatewayBridgeEventsForRequest = useCallback(
    async (requestId: string) => {
      const run = runsRef.current.get(requestId.trim());
      if (!run) {
        return;
      }
      flushRun(run);
      await run.operationChain;
      if (run.lastError) {
        throw run.lastError;
      }
    },
    [flushRun],
  );

  const registerGatewayRunMirror = useCallback(
    (input: RegisterGatewayRunMirrorInput) => {
      const run = ensureRun(input.runId, input.conversationId, input.workerId);
      if (run.closing || run.terminalPersisted || run.terminalCommit) {
        const error = new Error(`gateway chat run id cannot be reused: ${input.runId}`);
        run.lastError = error;
        console.error(error);
        return run;
      }
      if (run.cleanupTimer !== null) {
        clearTimeout(run.cleanupTimer);
        run.cleanupTimer = null;
      }
      run.userMessage = input.userMessage;
      run.transcriptStore = input.transcriptStore;
      run.state = input.state ?? "running";
      run.lastExternalEventAt = Date.now();
      return run;
    },
    [ensureRun],
  );

  const finishGatewayRunMirror = useCallback(
    async (input: FinishGatewayRunMirrorInput) => {
      const run = ensureRun(input.runId, input.conversationId);
      if (run.terminalPersisted) {
        return;
      }
      if (run.terminalCommit) {
        await run.terminalCommit;
        return;
      }
      run.closing = true;
      run.state = input.state;
      if (!run.terminalCheckpoint) {
        const revision = run.revision + 1;
        run.revision = revision;
        run.terminalCheckpoint = {
          revision,
          entriesJson: input.entriesJson,
          state: input.state,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          contentComplete: input.contentComplete,
          historyRequired: input.historyRequired === true,
        };
      }
      const terminalCheckpoint = run.terminalCheckpoint;
      const terminalCommit = commitCheckpoint(run, {
        kind: "terminal",
        ...terminalCheckpoint,
      });
      run.terminalCommit = terminalCommit;
      try {
        await terminalCommit;
      } catch (error) {
        if (run.terminalCommit === terminalCommit) {
          run.terminalCommit = null;
        }
        throw error;
      }
      run.terminalPersisted = true;
      run.lastError = null;
      run.cleanupTimer = setTimeout(() => {
        if (runsRef.current.get(run.runId) === run && run.terminalPersisted) {
          runsRef.current.delete(run.runId);
        }
      }, CHAT_INGRESS_COMPLETED_RUN_RETENTION_MS);
    },
    [commitCheckpoint, ensureRun],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<GatewayRunMirrorCheckpointRequest>("gateway:chat-checkpoint-requested", (event) => {
      const run = runsRef.current.get(event.payload.runId.trim());
      if (run) {
        void commitRunningCheckpoint(run).catch(() => undefined);
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [commitRunningCheckpoint]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const run of runsRef.current.values()) {
        if (now - run.lastExternalEventAt > CHAT_INGRESS_ABANDONED_RUN_TTL_MS) {
          // Two shapes of abandoned mirror: an early-failure orphan that never
          // registered a transcript source (would heartbeat forever), and a
          // closing run whose terminal commit failed with no retry left.
          const neverRegistered = !run.transcriptStore && run.state === "running" && !run.closing;
          const terminalAbandoned =
            run.closing && !run.terminalPersisted && run.terminalCommit === null;
          if (neverRegistered || terminalAbandoned) {
            if (run.flushTimer !== null) {
              clearTimeout(run.flushTimer);
            }
            runsRef.current.delete(run.runId);
            continue;
          }
        }
        if (run.state !== "running" || run.closing) {
          continue;
        }
        queueGatewayBridgeEventForRequest(
          run.runId,
          { type: "run_heartbeat", conversation_id: run.conversationId },
          { workerId: run.workerId },
        );
      }
    }, CHAT_INGRESS_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [queueGatewayBridgeEventForRequest]);

  useEffect(
    () => () => {
      for (const run of runsRef.current.values()) {
        if (run.flushTimer !== null) {
          clearTimeout(run.flushTimer);
        }
        if (run.cleanupTimer !== null) {
          clearTimeout(run.cleanupTimer);
        }
      }
      runsRef.current.clear();
    },
    [],
  );

  return {
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
  };
}
