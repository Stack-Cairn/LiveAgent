/** A step that did not answer in time; migrations treat it as transient and retry later. */
export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Runs `step` with a signal that aborts after `timeoutMs` (or when `parent` aborts) and settles
 * at that moment even if the step ignores its signal, as a Tauri `invoke` does. Startup waits on
 * these steps, so none of them may keep it waiting forever.
 */
export function withDeadline<T>(
  step: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  what: string,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromParent = () => controller.abort(parent?.reason);
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    };
    controller.signal.addEventListener(
      "abort",
      () => {
        cleanup();
        reject(controller.signal.reason);
      },
      { once: true },
    );
    if (parent?.aborted) {
      abortFromParent();
      return;
    }
    parent?.addEventListener("abort", abortFromParent, { once: true });
    timer = setTimeout(
      () =>
        controller.abort(
          new DeadlineError(`${what} did not finish within ${Math.round(timeoutMs / 1000)} s`),
        ),
      Math.max(0, timeoutMs),
    );
    let started: Promise<T>;
    try {
      started = step(controller.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(controller.signal.aborted ? controller.signal.reason : error);
      },
    );
  });
}
