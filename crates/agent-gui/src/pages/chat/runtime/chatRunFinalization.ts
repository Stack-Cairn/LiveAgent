export const CHAT_RUN_FINALIZATION_TIMEOUT_MS = 2_000;

/** Terminal history writes get a few short retries before the run is marked failed. */
export const TERMINAL_HISTORY_PERSIST_MAX_ATTEMPTS = 3;
export const TERMINAL_HISTORY_PERSIST_RETRY_DELAY_MS = 150;

export function releaseChatRunUi(params: {
  clearAbortController: () => void;
  clearSendingState: () => void;
  clearToolStatus: () => void;
}) {
  params.clearAbortController();
  params.clearSendingState();
  params.clearToolStatus();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Retry a terminal history write a few times. Transient SQLite / IPC failures
 * during the final persist otherwise leave the DB stuck on the user-only
 * snapshot while memory extraction still runs from in-memory state.
 */
export async function persistTerminalHistoryWithRetry(
  persist: () => Promise<boolean>,
  options?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void;
  },
): Promise<boolean> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? TERMINAL_HISTORY_PERSIST_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(
    0,
    options?.retryDelayMs ?? TERMINAL_HISTORY_PERSIST_RETRY_DELAY_MS,
  );
  const sleep = options?.sleep ?? delay;
  let lastError: unknown = null;
  // null = no terminal outcome yet; true = last attempt returned false; false = threw
  let lastAttemptWasSoftFalse: boolean | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const persisted = await persist();
      if (persisted) {
        return true;
      }
      lastAttemptWasSoftFalse = true;
      lastError = new Error("history persist returned false");
    } catch (error) {
      lastAttemptWasSoftFalse = false;
      lastError = error;
    }

    if (attempt >= maxAttempts) {
      break;
    }
    options?.onRetry?.(lastError, attempt, maxAttempts);
    if (retryDelayMs > 0) {
      await sleep(retryDelayMs * attempt);
    }
  }

  // Preserve the historical contract: a soft `false` from persist stays a
  // boolean failure, while thrown errors remain exceptional.
  if (lastAttemptWasSoftFalse) {
    return false;
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  if (lastError != null) {
    throw new Error(String(lastError));
  }
  return false;
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
  options?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void;
  },
): Promise<boolean> {
  try {
    const persisted = await persistTerminalHistoryWithRetry(persist, options);
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
 * Keep a terminal write attached to the run that produced it. A force-stopped
 * run can finish after its replacement has installed a new controller; it
 * must not enqueue its old snapshot or mark the replacement as persist-failed.
 */
export async function persistOwnedTerminalHistory<T extends object>(params: {
  input: T;
  ownsRun: () => boolean;
  persist: (input: T & { shouldPersist: () => boolean }) => Promise<boolean>;
  markFailed: () => void;
  options?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void;
  };
}): Promise<boolean> {
  const { input, ownsRun, persist, markFailed, options } = params;
  if (!ownsRun()) return false;

  let ownershipLost = false;
  const persistWhileOwned = async () => {
    if (!ownsRun()) {
      ownershipLost = true;
      return true;
    }
    const persisted = await persist({ ...input, shouldPersist: ownsRun });
    if (!ownsRun()) {
      ownershipLost = true;
      return true;
    }
    return persisted;
  };

  try {
    const persisted = await persistTerminalHistoryWithRetry(persistWhileOwned, options);
    if (!persisted && !ownershipLost) {
      markFailed();
    }
    return ownershipLost ? false : persisted;
  } catch (error) {
    if (!ownsRun()) return false;
    markFailed();
    throw error;
  }
}

/**
 * A force-stopped run can outlive its UI ownership while the next run begins
 * on the same conversation. In that state the live transcript store belongs
 * to the replacement run, so an old terminal mirror must fall back to its
 * own persisted-state projection instead of reading shared live state.
 */
export function resolveGatewayTerminalProjectionSource(params: {
  state: "running" | "completed" | "failed" | "cancelled";
  hasFrozenProjection: boolean;
  ownsRun: boolean;
}): "frozen" | "live" | "history" {
  if (params.hasFrozenProjection) return "frozen";
  return params.state === "cancelled" && params.ownsRun ? "live" : "history";
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
