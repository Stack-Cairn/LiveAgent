function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Resolves/rejects with `operation` unless `signal` aborts first. The source
 * promise remains observed after an abort, so a late rejection never becomes
 * an unhandled rejection.
 */
export function raceWithAbort<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  const source = Promise.resolve(operation);
  if (!signal) return source;
  if (signal.aborted) {
    // The caller may already have started an IPC/network promise before it
    // checks cancellation. Keep that promise observed even though this race
    // has already been decided, otherwise a late rejection becomes unhandled.
    void source.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => fail(abortReason(signal));

    signal.addEventListener("abort", onAbort, { once: true });
    source.then(
      (value) => finish(resolve, value),
      (error) => fail(error),
    );
  });
}
