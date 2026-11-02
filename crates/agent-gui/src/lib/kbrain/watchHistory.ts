import type { KBrainClient } from "./client";

/** Idle event streams close after replay; reconnect without retaining a full transcript. */
export function watchKBrainHistory(
  client: Pick<KBrainClient, "getHistory" | "subscribe">,
  sessionId: string,
  onChanged: () => void,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let afterSeq: number | undefined;
  const connect = async () => {
    try {
      if (afterSeq === undefined) {
        const snapshot = await client.getHistory(sessionId, { maxMessages: 1 });
        if (controller.signal.aborted) return;
        afterSeq = snapshot.session.last_seq;
        onChanged();
      }
      await client.subscribe(
        sessionId,
        afterSeq,
        {
          onEvent: (event) => {
            afterSeq = event.seq;
            if (event.type === "history.updated") onChanged();
          },
        },
        controller.signal,
      );
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
