import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@liveagent/app/lib/agentTypes";

function createAssistantMessageEventStream(): AssistantMessageEventStream & {
  push(event: AssistantMessageEvent): void;
  end(message?: AssistantMessage): void;
} {
  const queue: AssistantMessageEvent[] = [];
  const waiters: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
  let ended = false;
  let finalMessage: AssistantMessage | undefined;
  const next = (): Promise<IteratorResult<AssistantMessageEvent>> => {
    const event = queue.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => waiters.push(resolve));
  };
  const stream = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    result: async () => {
      while (!ended) await new Promise((resolve) => setTimeout(resolve, 0));
      if (finalMessage) return finalMessage;
      throw new Error("Assistant stream ended without a result");
    },
    push(event: AssistantMessageEvent) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else queue.push(event);
    },
    end(message?: AssistantMessage) {
      if (ended) return;
      finalMessage = message;
      ended = true;
      while (waiters.length) waiters.shift()?.({ value: undefined, done: true });
    },
  };
  return stream;
}

function isRetryableAssistantError(message: AssistantMessage | undefined): boolean {
  const text = message?.errorMessage ?? "";
  return /\b(?:408|409|425|429|500|502|503|504|524)\b|timeout|temporar|overloaded|rate.?limit/i.test(
    text,
  );
}

import { RETRYABLE_PRESET_HTTP_STATUS_CODES } from "@liveagent/ui/lib/settings/types";

export type { RetryAttemptRecord } from "@liveagent/ui/lib/chat/retryAttempts";

/** 6 total attempts = 5 retries after the initial try — matches codex's stream_max_retries=5. */
export const DEFAULT_STREAM_RETRY_MAX_ATTEMPTS = 6;

const STREAM_RETRY_BASE_DELAY_MS = 200;
const STREAM_RETRY_BACKOFF_FACTOR = 2;

/**
 * Extra retry classification for the local K-brain stream wrapper.
 * Driven by the user's global retry-error settings (see `RetryErrorSettings`):
 * - `statusCodes`: HTTP status codes (preset toggles) the user wants retried.
 * - `patterns`: free-text substrings matched case-insensitively against the error
 *   message, for relay/gateway wording the default classifier does not recognize.
 *
 * The default module extension enables every preset code (Cloudflare 520-527),
 * so relays self-heal out of the box (#608) even before the settings
 * layer syncs the user's choices in.
 */
export type RetryErrorExtension = {
  statusCodes?: number[];
  patterns?: string[];
};

const DEFAULT_RETRY_ERROR_EXTENSION: RetryErrorExtension = {
  statusCodes: [...RETRYABLE_PRESET_HTTP_STATUS_CODES],
  patterns: [],
};

let currentRetryErrorExtension: RetryErrorExtension = DEFAULT_RETRY_ERROR_EXTENSION;

/**
 * Replaces the process-wide retry-error extension. Called by the settings layer
 * whenever `retryErrorSettings` changes; the extension is a pure function of
 * settings, so stale state is impossible once the effect re-runs. Tests can
 * pass `null` to restore the default.
 */
export function setRetryErrorExtension(extension: RetryErrorExtension | null): void {
  currentRetryErrorExtension = extension ?? DEFAULT_RETRY_ERROR_EXTENSION;
}

export function getRetryErrorExtension(): RetryErrorExtension {
  return currentRetryErrorExtension;
}

function buildStatusCodePattern(codes: readonly number[]): RegExp | undefined {
  if (codes.length === 0) return undefined;
  // Word-boundary-ish: match the number not as a substring of a larger number
  // (so "520" doesn't match "5200"). `\D|$` keeps it simple and sufficient for
  // status codes embedded in error text like "HTTP 525" or "525 SSL handshake".
  return new RegExp(`(?:^|\\D)(?:${codes.join("|")})(?:\\D|$)`);
}

/**
 * Whether a failed assistant message matches the LiveAgent retry extension
 * (preset HTTP status codes + user-defined substrings). The stream wrapper
 * combines this extension with its built-in transient-error classifier.
 */
export function isExtensionRetryableError(
  message: AssistantMessage | undefined,
  extension: RetryErrorExtension = currentRetryErrorExtension,
): boolean {
  if (!message) return false;
  const errorMessage = (message as { errorMessage?: string }).errorMessage ?? "";
  if (!errorMessage) return false;

  const codes = extension.statusCodes;
  if (codes && codes.length > 0) {
    const pattern = buildStatusCodePattern(codes);
    if (pattern?.test(errorMessage)) return true;
  }
  const patterns = extension.patterns;
  if (patterns) {
    const lower = errorMessage.toLowerCase();
    for (const raw of patterns) {
      if (typeof raw !== "string") continue;
      const needle = raw.trim();
      if (needle && lower.includes(needle.toLowerCase())) return true;
    }
  }
  return false;
}

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
  /**
   * Per-call override for the retry-error extension. Defaults to the
   * process-wide extension set via `setRetryErrorExtension`; tests pass this
   * to exercise the classifier without touching shared module state.
   */
  retryExtension?: RetryErrorExtension;
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
 * the built-in transient-error classifier, is discarded wholesale and replaced by
 * a fresh `factory()` call after a codex-style backoff — the caller never
 * sees the failed attempt's events. Once committed, or once retries are
 * exhausted/disabled, events pass straight through untouched. `onRetry` /
 * `onRetryRecovered` let callers surface an ephemeral "reconnecting" status
 * in place of the frozen UI, mirroring codex's TUI behavior. A stop during the
 * backoff ends the stream with an `aborted` terminal, never with the failed
 * attempt's transport error.
 *
 * The pump below runs eagerly (not gated on the returned stream being
 * iterated) because some callers only await `.result()` without ever iterating
 * events, and that pattern must keep working through this wrapper.
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
        const failedMessage = terminalMessage(terminal);
        // Apply the built-in transient-error classifier first, then LiveAgent's
        // extension: preset HTTP status codes (Cloudflare 520-527 for relays,
        // #608) plus user-defined substrings from settings.
        if (
          isRetryableAssistantError(failedMessage) ||
          isExtensionRetryableError(failedMessage, options?.retryExtension)
        ) {
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
