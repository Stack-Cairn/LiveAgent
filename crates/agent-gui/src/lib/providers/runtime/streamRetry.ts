import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { raceWithAbort } from "../../cancellation/abortRace";

export type { RetryAttemptRecord } from "@liveagent/ui/lib/chat/retryAttempts";

/** 6 total attempts = 5 retries after the initial try — matches codex's stream_max_retries=5. */
export const DEFAULT_STREAM_RETRY_MAX_ATTEMPTS = 6;

const STREAM_RETRY_BASE_DELAY_MS = 200;
const STREAM_RETRY_BACKOFF_FACTOR = 2;
const DEFAULT_STREAM_RETRY_IDLE_TIMEOUT_MS = 30_000;

export type StreamRetryConfig = {
  maxAttempts?: number;
  disabled?: boolean;
  /** Maximum time a provider attempt may wait for its next event or result. */
  idleTimeoutMs?: number;
  /**
   * Retry ordinal (1..maxRetries) about to be attempted, invoked before the
   * backoff sleep. `errorMessage` is the failure that triggered this retry.
   */
  onRetry?: (attempt: number, maxAttempts: number, errorMessage: string) => void;
  /** Invoked once a retried attempt commits its first content-bearing event. */
  onRetryRecovered?: () => void;
};

export type StreamRetryOptions = StreamRetryConfig & {
  signal?: AbortSignal;
};

type TerminalEvent = Extract<AssistantMessageEvent, { type: "done" | "error" }>;

const COMMITTING_EVENT_TYPES = new Set<AssistantMessageEvent["type"]>([
  "text_delta",
  "thinking_delta",
  "toolcall_start",
]);

function isTerminalEvent(event: AssistantMessageEvent): event is TerminalEvent {
  return event.type === "done" || event.type === "error";
}

function terminalMessage(event: TerminalEvent) {
  return event.type === "done" ? event.message : event.error;
}

function terminalAssistantMessage(
  terminal: TerminalEvent | undefined,
): AssistantMessage | undefined {
  return terminal ? (terminalMessage(terminal) as AssistantMessage) : undefined;
}

/** Codex-style backoff: base * factor^(attempt-1) * uniform(0.9, 1.1), uncapped. */
export function computeStreamRetryBackoffMs(attempt: number): number {
  const base = STREAM_RETRY_BASE_DELAY_MS * STREAM_RETRY_BACKOFF_FACTOR ** (attempt - 1);
  return base * (0.9 + Math.random() * 0.2);
}

/**
 * The cancellation terminal a consumer must see when the user stops the run
 * during a retry backoff. It reuses the failed attempt's model identity so the
 * record keeps saying which provider/model the cancelled round belonged to.
 */
function buildAbortedAssistantMessage(previous: AssistantMessage | undefined): AssistantMessage {
  return {
    ...(previous ?? {}),
    role: "assistant",
    content: previous?.content ?? [],
    stopReason: "aborted",
    errorMessage: "Cancelled",
  } as AssistantMessage;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const candidate = error as { errorMessage?: unknown; message?: unknown; error?: unknown };
    if (typeof candidate.errorMessage === "string" && candidate.errorMessage.trim()) {
      return candidate.errorMessage;
    }
    if (typeof candidate.message === "string" && candidate.message.trim()) {
      return candidate.message;
    }
    if (typeof candidate.error === "string" && candidate.error.trim()) return candidate.error;
  }
  return String(error) || "Provider stream failed";
}

function buildTransportErrorMessage(
  error: unknown,
  previous?: AssistantMessage,
): AssistantMessage {
  return {
    ...(previous ?? {}),
    role: "assistant",
    content: previous?.content ?? [],
    stopReason: "error",
    errorMessage: errorText(error),
  } as AssistantMessage;
}

function isRetryableTransportFailure(error: unknown): boolean {
  const assistantError =
    error && typeof error === "object" && "role" in error
      ? (error as AssistantMessage)
      : undefined;
  if (assistantError && isRetryableAssistantError(assistantError)) return true;
  const message = errorText(error);
  if (/\b(?:abort|aborted|cancel|cancelled|canceled)\b/i.test(message)) return false;
  return /(?:fetch failed|network|timed?\s*out|timeout|econn(?:reset|refused|aborted)|connection|socket|stream|\b(?:408|425|429|500|502|503|504|522|524)\b|temporarily unavailable|service unavailable|overloaded)/i.test(
    message,
  );
}

function createSyntheticErrorStream(
  error: unknown,
  previous?: AssistantMessage,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const failed = buildTransportErrorMessage(error, previous);
  stream.push({ type: "error", reason: "error", error: failed });
  stream.end(failed);
  return stream;
}

function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function raceWithTimeout<T>(
  operation: PromiseLike<T> | T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (timeoutMs <= 0) return raceWithAbort(operation, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Provider stream idle timeout")), timeoutMs);
  });
  return Promise.race([raceWithAbort(operation, signal), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function readTerminalEventAfterAbort(
  iterator: AsyncIterator<AssistantMessageEvent>,
): Promise<IteratorResult<AssistantMessageEvent>> {
  // A provider may have synchronously buffered its terminal error before the
  // user pressed Stop. Preserve that terminal for retry accounting, but never
  // forward a queued text/thinking/tool event after cancellation.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: IteratorResult<AssistantMessageEvent>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ done: true, value: undefined }), 0);
    Promise.resolve()
      .then(() => iterator.next())
      .then(
      (next) => {
        if (next.done || isTerminalEvent(next.value)) finish(next);
        else finish({ done: true, value: undefined });
      },
      () => finish({ done: true, value: undefined }),
      );
  });
}

function abandonIterator(iterator: AsyncIterator<AssistantMessageEvent>) {
  try {
    // A hung provider iterator can keep its return() promise pending too.
    // Request cleanup without making cancellation wait on provider code.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  } catch {
    // Some minimal provider/test iterators do not support return().
  }
}

/**
 * Wraps a fresh-stream factory with attempt-scoped retry for transient
 * provider/transport failures.
 *
 * Events are buffered per attempt until the first content-bearing event
 * ("committed": text_delta / thinking_delta / toolcall_start) is observed. An
 * attempt that ends in error before committing, classified retryable by
 * pi-ai's `isRetryableAssistantError`, is discarded wholesale and replaced by
 * a fresh `factory()` call after a codex-style backoff — the caller never
 * sees the failed attempt's events. Once committed, or once retries are
 * exhausted/disabled, events pass straight through untouched. `onRetry` /
 * `onRetryRecovered` let callers surface an ephemeral "reconnecting" status
 * in place of the frozen UI, mirroring codex's TUI behavior. A stop during the
 * backoff ends the stream with an `aborted` terminal, never with the failed
 * attempt's transport error.
 *
 * The pump below runs eagerly (not gated on the returned stream being
 * iterated) because pi-ai's own stream factories start their network work as
 * soon as they're called, independent of consumer iteration — some callers
 * only await `.result()` without ever iterating events, and that pattern must
 * keep working through this wrapper.
 */
export function withStreamRetry(
  factory: () => AssistantMessageEventStream,
  options?: StreamRetryOptions,
): AssistantMessageEventStream {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_STREAM_RETRY_MAX_ATTEMPTS);
  const disabled = options?.disabled ?? false;
  const idleTimeoutMs = Math.max(
    0,
    options?.idleTimeoutMs ?? DEFAULT_STREAM_RETRY_IDLE_TIMEOUT_MS,
  );
  const signal = options?.signal;

  const output = createAssistantMessageEventStream();
  let firstSource: AssistantMessageEventStream;
  try {
    firstSource = factory();
  } catch (error) {
    firstSource = createSyntheticErrorStream(error);
  }

  const endAsAborted = (previous?: AssistantMessage) => {
    const aborted = buildAbortedAssistantMessage(previous);
    output.push({ type: "error", reason: "aborted", error: aborted });
    output.end(aborted);
  };

  void (async () => {
    let attempt = 1;
    let source = firstSource;
    let hasRetried = false;

    while (true) {
      let committed = false;
      const buffered: AssistantMessageEvent[] = [];
      let terminal: TerminalEvent | undefined;
      let iteratorFailure = false;

      const iterator = source[Symbol.asyncIterator]();
      while (true) {
        let next: IteratorResult<AssistantMessageEvent>;
        try {
          next = signal?.aborted
            ? await readTerminalEventAfterAbort(iterator)
            : await raceWithTimeout(iterator.next(), idleTimeoutMs, signal);
        } catch (error) {
          if (signal?.aborted) {
            abandonIterator(iterator);
            endAsAborted(terminalAssistantMessage(terminal));
            return;
          }
          abandonIterator(iterator);
          iteratorFailure = true;
          const failed = buildTransportErrorMessage(error, terminalAssistantMessage(terminal));
          terminal = { type: "error", reason: "error", error: failed };
          const failedEvent = terminal;
          if (committed) output.push(failedEvent);
          else buffered.push(failedEvent);
          break;
        }
        if (next.done) break;
        const event = next.value;
        if (!committed && COMMITTING_EVENT_TYPES.has(event.type)) {
          committed = true;
          for (const bufferedEvent of buffered.splice(0)) output.push(bufferedEvent);
          if (hasRetried) {
            hasRetried = false;
            options?.onRetryRecovered?.();
          }
        }
        if (committed) {
          output.push(event);
        } else {
          buffered.push(event);
        }
        if (isTerminalEvent(event)) {
          terminal = event;
          abandonIterator(iterator);
          break;
        }
      }

      // The abort-aware terminal drain may stop waiting before the provider iterator
      // acknowledges cancellation. Ask it to release its transport without blocking the UI.
      if (signal?.aborted) abandonIterator(iterator);

      let result: AssistantMessage | undefined;
      if (!iteratorFailure && terminal === undefined) {
        if (signal?.aborted) {
          if (terminal === undefined) {
            endAsAborted();
            return;
          }
          result = terminalMessage(terminal) as AssistantMessage;
        } else {
          try {
            result = await raceWithTimeout(source.result(), idleTimeoutMs, signal);
          } catch (error) {
            if (signal?.aborted) {
              endAsAborted(terminalAssistantMessage(terminal));
              return;
            }
            if (terminal === undefined) {
              const failed = buildTransportErrorMessage(error);
              terminal = { type: "error", reason: "error", error: failed };
              if (committed) output.push(terminal);
              else buffered.push(terminal);
            }
          }
        }
      }

      // A few provider adapters finish iteration without emitting a terminal
      // event and expose the failure only through result(). Treat that shape
      // exactly like an in-stream error so an uncommitted network failure can
      // still be retried.
      if (terminal === undefined && result?.stopReason === "error") {
        terminal = { type: "error", reason: "error", error: result };
        if (committed) output.push(terminal);
        else buffered.push(terminal);
      }

      if (terminal?.type === "error" && !committed && !disabled && attempt < maxAttempts) {
        const terminalError = terminalMessage(terminal);
        if (isRetryableAssistantError(terminalError) || isRetryableTransportFailure(terminalError)) {
          const errorMessage = terminalMessage(terminal)?.errorMessage || "Unknown error";
          attempt += 1;
          options?.onRetry?.(attempt - 1, maxAttempts - 1, errorMessage);
          hasRetried = true;
          try {
            await sleepWithAbort(computeStreamRetryBackoffMs(attempt - 1), signal);
          } catch {
            // Stopped mid-backoff: the terminal must say "aborted", not replay
            // the prior attempt's transport error. Handing the consumer that
            // error instead loses the fact that the user stopped the run — the
            // abort branches upstream never fire, so nothing records the
            // cancellation and the status row falls back to a spinner.
            if (signal?.aborted) {
              endAsAborted(terminalAssistantMessage(terminal));
              return;
            }
            // The next attempt failed to start — surface the prior attempt's
            // real failure below instead of hanging the consumer on a retry
            // that will never happen.
            break;
          }
          try {
            source = factory();
            continue;
          } catch (error) {
            // A synchronous provider construction failure is still a
            // transport attempt. Feed it through the same bounded retry loop.
            source = createSyntheticErrorStream(
              error,
              terminalAssistantMessage(terminal),
            );
            continue;
          }
        }
      }

      if (!committed) {
        for (const bufferedEvent of buffered) output.push(bufferedEvent);
      }
      // Some streams (notably minimal test doubles) never yield a terminal
      // done/error event through iteration and only expose the final message
      // via result(). output.end() is idempotent once a terminal event has
      // already been pushed above, so this also safety-nets that case.
      output.end(result ?? terminalAssistantMessage(terminal) ?? buildTransportErrorMessage("Provider stream ended without a result"));
      return;
    }
  })().catch((error) => {
    if (signal?.aborted) {
      endAsAborted();
      return;
    }
    const failed = buildAbortedAssistantMessage(undefined);
    failed.stopReason = "error";
    failed.errorMessage = error instanceof Error ? error.message : String(error);
    output.push({ type: "error", reason: "error", error: failed });
    output.end(failed);
  });

  return output;
}
