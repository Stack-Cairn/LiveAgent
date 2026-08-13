import { invoke } from "../../lib/tauriBridge";

type InvokeWithAbortOptions<T> = {
  onAbort?: () => Promise<void> | void;
  onLateResult?: (result: T) => Promise<void> | void;
};

export class ToolInvocationCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "ToolInvocationCancelledError";
  }
}

export function throwIfToolInvocationAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ToolInvocationCancelledError();
  }
}

export function createToolRunId(prefix: string, toolCallId: string) {
  const normalizedPrefix = prefix.trim() || "tool";
  const normalizedToolCallId = toolCallId.trim() || "call";
  // Provider tool-call ids are not globally unique (local models commonly
  // reuse ids like "call_1" across conversations), and registering a
  // duplicate run id cancels the previous registration's token — so a uuid
  // suffix is required to keep runs from cancelling each other.
  return `${normalizedPrefix}:${normalizedToolCallId}:${crypto.randomUUID()}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function requestRuntimeCancel(runId: string) {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) return;
  void (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await invoke<{ cancelled: boolean }>("runtime_cancel", {
          run_id: normalizedRunId,
        } as any);
        if (response.cancelled) return;
      } catch {
        // Transient IPC failure — keep retrying; the loop is bounded.
      }
      await delay(50);
    }
  })();
}

export function waitForAbortablePromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfToolInvocationAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ToolInvocationCancelledError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
    }
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function invokeWithAbort<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  options: InvokeWithAbortOptions<T> = {},
): Promise<T> {
  throwIfToolInvocationAborted(signal);
  const invocation = invoke<T>(command, args as any);
  if (!signal) return invocation;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      aborted = true;
      cleanup();
      void Promise.resolve(options.onAbort?.()).catch(() => undefined);
      reject(new ToolInvocationCancelledError());
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
    }

    void invocation.then(
      (result) => {
        if (aborted) {
          void Promise.resolve(options.onLateResult?.(result)).catch(() => undefined);
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
