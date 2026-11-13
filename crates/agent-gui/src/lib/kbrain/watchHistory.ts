import type { KBrainClient } from "./client";

/** Idle event streams close after replay; reconnect without retaining a full transcript. */
export function watchKBrainHistory(
  client: Pick<KBrainClient, "getHistory" | "subscribe">,
  sessionId: string,
  onChanged: () => unknown,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let afterSeq: number | undefined;
  let revision: string | undefined;
  let needsReconcile = false;
  const notifyChanged = () => {
    needsReconcile = false;
    try {
      void Promise.resolve(onChanged()).catch(() => {
        needsReconcile = true;
      });
    } catch {
      needsReconcile = true;
    }
  };
  const connect = async () => {
    try {
      // The terminal SSE event may precede the final history write. Check the
      // authority on reconnect even when its event cursor has not advanced.
      const snapshot = await client.getHistory(sessionId, { maxMessages: 1 });
      if (controller.signal.aborted) return;
      const changed = afterSeq !== snapshot.session.last_seq || revision !== snapshot.revision;
      afterSeq = snapshot.session.last_seq;
      revision = snapshot.revision;
      if (changed || needsReconcile) notifyChanged();
      const connectedAfterSeq = afterSeq;
      await client.subscribe(
        sessionId,
        afterSeq,
        {
          onEvent: (event) => {
            if (controller.signal.aborted || event.seq <= (afterSeq ?? 0)) return;
            if (event.conversation_id && event.conversation_id !== sessionId) {
              throw new Error("K-brain history event identity mismatch");
            }
            if (event.seq !== (afterSeq ?? 0) + 1) {
              throw new Error("K-brain history event sequence gap");
            }
            afterSeq = event.seq;
            if (
              event.type === "history.updated" ||
              event.type === "run.completed" ||
              event.type === "run.failed" ||
              event.type === "run.cancelled" ||
              event.type === "subagent.completed" ||
              event.type === "subagent.failed"
            )
              notifyChanged();
          },
        },
        controller.signal,
      );
      // Terminal SSE closure can race the final history write. Reconcile once more
      // after replay, without repeatedly fetching full history for an idle stream.
      if (!controller.signal.aborted && afterSeq !== connectedAfterSeq) notifyChanged();
    } catch {
      afterSeq = undefined;
      // A disconnected backend is retried until the owning view unmounts.
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => void connect(), 2_000);
    }
  };
  void connect();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
