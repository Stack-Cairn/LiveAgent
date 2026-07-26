import type { Message } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { type MutableRefObject, useEffect, useRef } from "react";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { QueuedChatTurn } from "../queue/chatTurnQueue";
import {
  buildGatewayRuntimeSnapshotEntries,
  type GatewayRuntimeSnapshotState,
} from "./chatRuntimeSnapshot";
import type { GatewayRuntimeStatus } from "./gatewayRuntimeStatusModel";

export type ActiveGatewayRuntimeRun = {
  conversationId: string;
  runId: string;
  clientRequestId?: string;
  workerId?: string;
  cwd?: string;
  revision: number;
  state: GatewayRuntimeSnapshotState;
  userMessage: Message;
  transcriptStore: LiveTranscriptStore;
  toolStatusIsCompaction: boolean;
};

const GATEWAY_RUNTIME_SNAPSHOT_DEBOUNCE_MS = 300;
// Must stay well below the desktop run ledger's 5-minute active TTL.
const GATEWAY_RUNTIME_RUN_KEEPALIVE_MS = 60_000;

type UseGatewayRuntimeSnapshotsParams = {
  canShareHistory: boolean;
  remoteRuntimeStatus: GatewayRuntimeStatus;
  currentConversationIdRef: MutableRefObject<string>;
  queuedChatTurnsRef: MutableRefObject<QueuedChatTurn[]>;
  publishChatQueueSnapshots: (
    conversationIds: Iterable<string>,
    queue?: readonly QueuedChatTurn[],
  ) => void;
  collectChatQueueSnapshotConversationIds: (
    queue?: readonly QueuedChatTurn[],
    extraConversationIds?: readonly string[],
  ) => Set<string>;
};

/**
 * Live-run mirroring to the gateway: registers active runs, publishes
 * debounced ChatRuntimeSnapshot frames from the live transcript, re-publishes
 * on reconnect, and keep-alives long-silent runs so the desktop run ledger
 * never times them out mid-tool-call.
 */
export function useGatewayRuntimeSnapshots(params: UseGatewayRuntimeSnapshotsParams) {
  const {
    canShareHistory,
    remoteRuntimeStatus,
    currentConversationIdRef,
    queuedChatTurnsRef,
    publishChatQueueSnapshots,
    collectChatQueueSnapshotConversationIds,
  } = params;

  const activeGatewayRuntimeRunsRef = useRef(new Map<string, ActiveGatewayRuntimeRun>());
  const gatewayRuntimeSnapshotChainsRef = useRef(new Map<string, Promise<void>>());
  const gatewayRuntimeSnapshotTimersRef = useRef(
    new Map<string, { run: ActiveGatewayRuntimeRun; timerId: number }>(),
  );

  function clearGatewayRuntimeSnapshotTimer(
    conversationId: string,
    expectedRun?: ActiveGatewayRuntimeRun,
  ) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    const pending = gatewayRuntimeSnapshotTimersRef.current.get(targetConversationId);
    if (!pending || (expectedRun && pending.run !== expectedRun)) {
      return;
    }
    window.clearTimeout(pending.timerId);
    gatewayRuntimeSnapshotTimersRef.current.delete(targetConversationId);
  }

  async function publishGatewayRuntimeSnapshot(
    run: ActiveGatewayRuntimeRun,
    state: GatewayRuntimeSnapshotState = run.state,
  ) {
    const liveTranscript = run.transcriptStore.getSnapshot();
    const entries = buildGatewayRuntimeSnapshotEntries({
      userMessage: run.userMessage,
      liveTranscript,
    });
    run.state = state;
    run.revision += 1;
    const toolStatus = liveTranscript.toolStatus?.trim() || "";

    try {
      await invoke("gateway_publish_chat_runtime_snapshot", {
        input: {
          conversationId: run.conversationId,
          runId: run.runId,
          clientRequestId: run.clientRequestId ?? "",
          workerId: run.workerId ?? "",
          state,
          cwd: run.cwd ?? "",
          updatedAt: Date.now(),
          revision: run.revision,
          entriesJson: JSON.stringify(entries),
          toolStatus,
          toolStatusIsCompaction: Boolean(toolStatus) && run.toolStatusIsCompaction,
        },
      } as any);
    } catch (error) {
      console.warn("gateway_publish_chat_runtime_snapshot failed", error);
    }
  }

  function queueGatewayRuntimeSnapshotForRun(
    run: ActiveGatewayRuntimeRun,
    options?: { state?: GatewayRuntimeSnapshotState; force?: boolean },
  ) {
    const state = options?.state ?? run.state;
    run.state = state;
    if (options?.force) {
      clearGatewayRuntimeSnapshotTimer(run.conversationId, run);
    } else {
      const pending = gatewayRuntimeSnapshotTimersRef.current.get(run.conversationId);
      if (pending?.run === run) {
        return gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) ?? Promise.resolve();
      }
      if (pending) {
        clearGatewayRuntimeSnapshotTimer(run.conversationId);
      }
    }

    const publish = () => {
      const pending = gatewayRuntimeSnapshotTimersRef.current.get(run.conversationId);
      if (pending?.run === run) {
        gatewayRuntimeSnapshotTimersRef.current.delete(run.conversationId);
      }
      const previous =
        gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => publishGatewayRuntimeSnapshot(run, state));
      gatewayRuntimeSnapshotChainsRef.current.set(run.conversationId, next);
      void next.finally(() => {
        if (gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) === next) {
          gatewayRuntimeSnapshotChainsRef.current.delete(run.conversationId);
        }
      });
      return next;
    };

    if (options?.force) {
      return publish();
    }

    const timerId = window.setTimeout(publish, GATEWAY_RUNTIME_SNAPSHOT_DEBOUNCE_MS);
    gatewayRuntimeSnapshotTimersRef.current.set(run.conversationId, { run, timerId });
    return gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) ?? Promise.resolve();
  }

  function queueGatewayRuntimeSnapshot(
    conversationId: string,
    options?: { state?: GatewayRuntimeSnapshotState; force?: boolean },
  ) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return Promise.resolve();
    }
    const run = activeGatewayRuntimeRunsRef.current.get(targetConversationId);
    if (!run) {
      return Promise.resolve();
    }
    return queueGatewayRuntimeSnapshotForRun(run, options);
  }

  function registerActiveGatewayRuntimeRun(run: ActiveGatewayRuntimeRun) {
    activeGatewayRuntimeRunsRef.current.set(run.conversationId, run);
    return run;
  }

  function finishActiveGatewayRuntimeRun(
    conversationId: string,
    state: GatewayRuntimeSnapshotState,
    expectedRun: ActiveGatewayRuntimeRun | null,
  ) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return Promise.resolve();
    }
    const run = expectedRun;
    if (!run) {
      return Promise.resolve();
    }
    return queueGatewayRuntimeSnapshotForRun(run, { state, force: true }).finally(() => {
      if (activeGatewayRuntimeRunsRef.current.get(targetConversationId) === run) {
        activeGatewayRuntimeRunsRef.current.delete(targetConversationId);
        clearGatewayRuntimeSnapshotTimer(targetConversationId, run);
      }
    });
  }

  useEffect(
    () => () => {
      for (const pending of gatewayRuntimeSnapshotTimersRef.current.values()) {
        window.clearTimeout(pending.timerId);
      }
      gatewayRuntimeSnapshotTimersRef.current.clear();
      activeGatewayRuntimeRunsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!canShareHistory) {
      return;
    }
    publishChatQueueSnapshots(
      collectChatQueueSnapshotConversationIds(queuedChatTurnsRef.current, [
        currentConversationIdRef.current,
      ]),
    );
    for (const run of activeGatewayRuntimeRunsRef.current.values()) {
      void queueGatewayRuntimeSnapshotForRun(run, { state: run.state, force: true });
    }
  }, [canShareHistory, remoteRuntimeStatus.connectedSince, remoteRuntimeStatus.sessionId]);

  // Keep-alive: a long silent tool call produces no chat events, and the
  // desktop run ledger treats an untouched run as lost after its active TTL
  // (which would surface a spurious failure on remote clients). Re-publishing
  // the running snapshot refreshes both the ledger and the gateway activity.
  useEffect(() => {
    if (!canShareHistory) {
      return;
    }
    const timerId = window.setInterval(() => {
      for (const run of activeGatewayRuntimeRunsRef.current.values()) {
        if (run.state === "running") {
          void queueGatewayRuntimeSnapshotForRun(run, { state: run.state });
        }
      }
    }, GATEWAY_RUNTIME_RUN_KEEPALIVE_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, [canShareHistory]);

  return {
    activeGatewayRuntimeRunsRef,
    queueGatewayRuntimeSnapshot,
    queueGatewayRuntimeSnapshotForRun,
    registerActiveGatewayRuntimeRun,
    finishActiveGatewayRuntimeRun,
  };
}
