export const CHAT_RUN_FINALIZATION_TIMEOUT_MS = 2_000;

export function releaseChatRunUi(params: {
  releaseRun: () => boolean;
  clearToolStatus: () => void;
}) {
  if (!params.releaseRun()) {
    return false;
  }
  params.clearToolStatus();
  return true;
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

/**
 * Ordered chat-run finalization: history persistence must land before the
 * gateway stream close / terminal runtime snapshot become observable remotely
 * (26f2561 — "done" is only sent after persist), otherwise a WebUI client can
 * hydrate a truncated conversation. The barrier is therefore awaited first
 * instead of being raced against the flushes; the flushes themselves carry no
 * mutual ordering and run together.
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
  await Promise.allSettled([params.closeBridge(), params.finishRuntimeRun()]);
}
