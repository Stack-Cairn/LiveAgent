import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";

export type { RetryAttemptRecord } from "@liveagent/ui/lib/chat/retryAttempts";

/** 6 total attempts = 5 retries after the initial try — matches codex's stream_max_retries=5. */
export const DEFAULT_STREAM_RETRY_MAX_ATTEMPTS = 6;

const STREAM_RETRY_BASE_DELAY_MS = 200;
const STREAM_RETRY_BACKOFF_FACTOR = 2;

export type StreamRetryConfig = {
  maxAttempts?: number;
  disabled?: boolean;
  /**
   * Retry ordinal (1..maxRetries) about to be attempted, invoked before the
   * backoff sleep. `errorMessage` is the failure that triggered this retry;
   * `plannedDelayMs` is the backoff about to be slept (PR-4 audit field).
   */
  onRetry?: (
    attempt: number,
    maxAttempts: number,
    errorMessage: string,
    plannedDelayMs?: number,
  ) => void;
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
  const signal = options?.signal;

  const output = createAssistantMessageEventStream();
  const firstSource = factory();

  void (async () => {
    let attempt = 1;
    let source = firstSource;
    let hasRetried = false;

    while (true) {
      let committed = false;
      const buffered: AssistantMessageEvent[] = [];
      let terminal: TerminalEvent | undefined;

      for await (const event of source) {
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
        if (isTerminalEvent(event)) terminal = event;
      }

      if (terminal?.type === "error" && !committed && !disabled && attempt < maxAttempts) {
        if (isRetryableAssistantError(terminalMessage(terminal))) {
          const errorMessage = terminalMessage(terminal)?.errorMessage || "Unknown error";
          attempt += 1;
          // Computed before the callback so the audit trail records the exact
          // backoff about to be slept. Rounded to whole milliseconds: setTimeout
          // is ms-granular anyway, and a fractional float drifts by 1 ulp per
          // trajectory persistence merge (serde_json best-effort float parse),
          // which would give the same retry two identities in the converged
          // ledger — duplicated rows and an inflated retry count.
          const plannedDelayMs = Math.round(computeStreamRetryBackoffMs(attempt - 1));
          options?.onRetry?.(attempt - 1, maxAttempts - 1, errorMessage, plannedDelayMs);
          hasRetried = true;
          try {
            await sleepWithAbort(plannedDelayMs, signal);
            source = factory();
            continue;
          } catch {
            // Stopped mid-backoff: the terminal must say "aborted", not replay
            // the prior attempt's transport error. Handing the consumer that
            // error instead loses the fact that the user stopped the run — the
            // abort branches upstream never fire, so nothing records the
            // cancellation and the status row falls back to a spinner.
            if (signal?.aborted) {
              const aborted = buildAbortedAssistantMessage(
                terminalMessage(terminal) as AssistantMessage | undefined,
              );
              output.push({ type: "error", reason: "aborted", error: aborted });
              output.end(aborted);
              return;
            }
            // The next attempt failed to start — surface the prior attempt's
            // real failure below instead of hanging the consumer on a retry
            // that will never happen.
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
      output.end(await source.result());
      return;
    }
  })();

  return output;
}
