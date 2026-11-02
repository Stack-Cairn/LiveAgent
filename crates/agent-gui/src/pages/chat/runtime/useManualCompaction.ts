import { useCallback } from "react";
import { createKBrainClient } from "../../../lib/kbrain/client";
import { getKBrainSessionId } from "../../../lib/kbrain/mapping";
import { getConfiguredKBrainConnection } from "../../../lib/kbrain/runtimeConnection";

const activeCompactions = new Map<
  string,
  {
    controller: AbortController;
    client: ReturnType<typeof createKBrainClient>;
    sessionId: string;
    runId: string;
  }
>();

export function cancelManualCompaction(conversationId: string): void {
  const active = activeCompactions.get(conversationId.trim());
  if (!active) return;
  active.controller.abort();
  void active.client.cancelRun(active.sessionId, active.runId).catch(() => undefined);
}

export type ManualCompactionResult = {
  status: "compacted" | "failed" | "busy" | "skipped";
  message?: string;
};

export type ManualCompactionRequest = {
  conversationId?: string;
  operationId?: string;
  onAccepted?: () => void;
};

export function useManualCompaction(options?: {
  onCompleted?: (conversationId: string) => Promise<void>;
}) {
  return useCallback(
    async (request?: ManualCompactionRequest): Promise<ManualCompactionResult> => {
      const conversationId = request?.conversationId?.trim();
      const connection = getConfiguredKBrainConnection();
      const sessionId = conversationId
        ? getKBrainSessionId(conversationId, connection?.baseUrl)
        : undefined;
      if (!conversationId || !sessionId || !connection) {
        return {
          status: "skipped",
          message: "No backend session is available for compaction.",
        };
      }

      const client = createKBrainClient(connection);
      if (activeCompactions.has(conversationId)) {
        return {
          status: "busy",
          message: "The session is already compacting.",
        };
      }
      try {
        const session = await client.getSession(sessionId);
        if (!session.revision) throw new Error("Session revision is unavailable.");
        const clientRequestId =
          request?.operationId?.trim() ||
          `liveagent-compact-${conversationId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const accepted = await client.compactSession(sessionId, {
          client_request_id: clientRequestId,
          expected_revision: session.revision,
        });
        request?.onAccepted?.();
        const abort = new AbortController();
        activeCompactions.set(conversationId, {
          controller: abort,
          client,
          sessionId,
          runId: accepted.run_id,
        });
        let result: ManualCompactionResult = {
          status: "failed",
          message: "Compaction ended without a result.",
        };
        await client
          .subscribe(
            sessionId,
            accepted.accepted_seq - 1,
            {
              onEvent(event) {
                if (event.run_id !== accepted.run_id) return;
                if (event.type === "compaction.completed") {
                  const payload = event.payload as { status?: string; error?: string } | undefined;
                  result =
                    payload?.status === "completed"
                      ? { status: "compacted" }
                      : {
                          status: "failed",
                          message: payload?.error ?? "Compaction failed.",
                        };
                  abort.abort();
                } else if (event.type === "run.cancelled") {
                  result = {
                    status: "skipped",
                    message: "Compaction cancelled.",
                  };
                  abort.abort();
                } else if (event.type === "run.failed") {
                  const payload = event.payload as { error?: string } | undefined;
                  result = {
                    status: "failed",
                    message: payload?.error ?? "Compaction failed.",
                  };
                  abort.abort();
                }
              },
            },
            abort.signal,
          )
          .catch((error) => {
            if (!abort.signal.aborted) throw error;
          });
        activeCompactions.delete(conversationId);
        if (result.status === "compacted") await options?.onCompleted?.(conversationId);
        return result;
      } catch (error) {
        activeCompactions.delete(conversationId);
        const status = (error as { status?: number }).status;
        if (status === 409) return { status: "busy", message: "The session is busy." };
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [options],
  );
}
