export const CHAT_RUN_FINALIZATION_TIMEOUT_MS = 2_000;

export function releaseChatRunUi(params: {
  clearAbortController: () => void;
  clearSendingState: () => void;
  clearToolStatus: () => void;
}) {
  params.clearAbortController();
  params.clearSendingState();
  params.clearToolStatus();
}

export async function settleChatRunFinalization(
  finalization: Promise<unknown>,
  timeoutMs = CHAT_RUN_FINALIZATION_TIMEOUT_MS,
): Promise<"completed" | "timed_out"> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const guardedFinalization = finalization
    .catch((error) => {
      console.warn("chat run finalization failed", error);
    })
    .then(() => "completed" as const);
  const timedOut = new Promise<"timed_out">((resolve) => {
    timeoutId = setTimeout(() => resolve("timed_out"), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([guardedFinalization, timedOut]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

export async function trackTerminalHistoryPersist(
  persist: () => Promise<boolean>,
  markFailed?: () => void,
): Promise<boolean> {
  try {
    const persisted = await persist();
    if (!persisted) {
      markFailed?.();
    }
    return persisted;
  } catch (error) {
    markFailed?.();
    throw error;
  }
}

/**
 * Ordered chat-run finalization: the run only counts as finished after its
 * history persistence has landed, so the next queued turn never starts on a
 * truncated conversation.
 */
export async function finalizeChatRunInOrder(params: {
  waitForPersistBarrier: () => Promise<unknown>;
}): Promise<void> {
  try {
    await params.waitForPersistBarrier();
  } catch (error) {
    console.warn("chat run persist barrier failed", error);
  }
}
