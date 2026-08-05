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
  markFailed: () => void,
): Promise<boolean> {
  try {
    const persisted = await persist();
    if (!persisted) {
      markFailed();
    }
    return persisted;
  } catch (error) {
    markFailed();
    throw error;
  }
}

/**
 * Ordered chat-run finalization: history persistence must land before the
 * gateway stream close / terminal runtime snapshot become observable remotely
 * (26f2561 — "done" is only sent after persist), otherwise a WebUI client can
 * hydrate a truncated conversation.
 */
export async function finalizeChatRunInOrder(params: {
  waitForPersistBarrier: () => Promise<unknown>;
  closeBridge: () => Promise<unknown>;
  finishRuntimeRun: () => Promise<unknown>;
}): Promise<void> {
  try {
    await params.waitForPersistBarrier();
  } catch (error) {
    console.warn("chat run persist barrier failed", error);
  }
  let finalizationError: unknown = null;
  try {
    await params.closeBridge();
  } catch (error) {
    finalizationError = error;
    console.warn("chat run delta flush failed", error);
  }
  try {
    await params.finishRuntimeRun();
  } catch (error) {
    finalizationError ??= error;
    console.warn("chat run terminal checkpoint failed", error);
  }
  if (finalizationError) {
    throw finalizationError;
  }
}
