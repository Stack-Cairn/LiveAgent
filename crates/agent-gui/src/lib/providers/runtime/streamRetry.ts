import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { RETRYABLE_PRESET_HTTP_STATUS_CODES } from "@liveagent/ui/lib/settings/types";
import { createLinkedAbortSignal } from "./abortLink";
import { isOverflowError } from "./overflow";

export type { RetryAttemptRecord } from "@liveagent/ui/lib/chat/retryAttempts";

/** 6 total attempts = 5 retries after the initial try — matches codex's stream_max_retries=5. */
export const DEFAULT_STREAM_RETRY_MAX_ATTEMPTS = 6;

const STREAM_RETRY_BASE_DELAY_MS = 200;
const STREAM_RETRY_BACKOFF_FACTOR = 2;

/**
 * Extra retry classification layered on top of pi-ai's `isRetryableAssistantError`.
 * Driven by the user's global retry-error settings (see `RetryErrorSettings`):
 * - `statusCodes`: HTTP status codes (preset toggles) the user wants retried
 *   beyond pi-ai's hardcoded set (which already covers 429/500/502/503/504/524).
 * - `patterns`: free-text substrings matched case-insensitively against the error
 *   message, for relay/gateway wording pi-ai doesn't recognize.
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
 * (preset HTTP status codes + user-defined substrings), independently of
 * pi-ai's `isRetryableAssistantError`. Does not re-check pi-ai's own patterns
 * — callers OR the two together so the union is retryable.
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
  /**
   * Transport watchdog, opt-in. Max wait from dispatch until the attempt's
   * first committing event (text_delta / thinking_delta / toolcall_start).
   * Non-committing events such as `start` (headers arrived) don't reset it.
   */
  firstEventTimeoutMs?: number;
  /**
   * Transport watchdog, opt-in. Max gap between any two events once the
   * attempt has committed. Not armed before the first committing event —
   * that phase belongs to `firstEventTimeoutMs`.
   */
  idleTimeoutMs?: number;
  /**
   * Whether a stalled attempt that never committed is retried here. Defaults
   * to false: a deterministic silence (slow prefill, long reasoning) bills the
   * whole request again on every retry, so callers opt in deliberately.
   */
  retryOnStall?: boolean;
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

type StreamStallKind = "first-event" | "idle";

const STREAM_STALL_ERROR_PREFIX = "stream stalled:";

function formatStallDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

function buildStallErrorMessage(kind: StreamStallKind, timeoutMs: number): string {
  const duration = formatStallDuration(timeoutMs);
  return kind === "first-event"
    ? `${STREAM_STALL_ERROR_PREFIX} no content for ${duration} after the request was sent`
    : `${STREAM_STALL_ERROR_PREFIX} no events for ${duration}`;
}

/**
 * Whether a failed assistant message is a watchdog stall rewritten by
 * withStreamRetry (as opposed to a provider error or a user stop). Runners
 * throw it as AssistantResponseError, so `readAssistantFromError` feeds this.
 */
export function isStreamStallError(message: AssistantMessage | undefined): boolean {
  return (
    message?.stopReason === "error" &&
    (message.errorMessage ?? "").startsWith(STREAM_STALL_ERROR_PREFIX)
  );
}

/** setTimeout's ceiling; larger delays overflow to ~1ms in Node and WebViews. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function positiveTimeoutMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMER_DELAY_MS)
    : undefined;
}

/**
 * Per-attempt watchdog: an AbortController linked to the caller's signal plus
 * one timer (first-event before commit, idle after). A fired timer records the
 * stall text and aborts only this attempt; the caller's signal is untouched.
 */
type AttemptWatchdog = {
  signal: AbortSignal | undefined;
  /** Set once a timer fired; the attempt's terminal is rewritten to it. */
  readonly stallErrorMessage: string | undefined;
  observe: (event: AssistantMessageEvent) => void;
  /** Clears the timer and unlinks from the caller's signal. Idempotent. */
  dispose: () => void;
};

function createAttemptWatchdog(
  parentSignal: AbortSignal | undefined,
  firstEventTimeoutMs: number | undefined,
  idleTimeoutMs: number | undefined,
): AttemptWatchdog {
  const controller = new AbortController();
  const link = createLinkedAbortSignal([parentSignal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let committed = false;
  let stallErrorMessage: string | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (kind: StreamStallKind, timeoutMs: number | undefined) => {
    clearTimer();
    if (timeoutMs === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      // A user stop owns the terminal; never relabel it as a stall.
      if (parentSignal?.aborted || controller.signal.aborted) return;
      stallErrorMessage = buildStallErrorMessage(kind, timeoutMs);
      controller.abort(new Error(stallErrorMessage));
    }, timeoutMs);
  };

  arm("first-event", firstEventTimeoutMs);
  return {
    signal: link.signal,
    get stallErrorMessage() {
      return stallErrorMessage;
    },
    observe(event) {
      if (isTerminalEvent(event)) {
        clearTimer();
        return;
      }
      if (!committed) {
        if (!COMMITTING_EVENT_TYPES.has(event.type)) return;
        committed = true;
      }
      arm("idle", idleTimeoutMs);
    },
    dispose() {
      clearTimer();
      link.cleanup();
    },
  };
}

/**
 * A stalled attempt ends as `aborted` (pi-ai maps any signal abort to that),
 * which nothing ever retries and every consumer reads as a user stop. Rewrite
 * it to an `error` carrying the stall text — unless the caller's own signal
 * aborted, in which case the stop is real and stays `aborted`.
 */
function rewriteStalledMessage(
  message: AssistantMessage,
  stallErrorMessage: string | undefined,
  parentSignal: AbortSignal | undefined,
): AssistantMessage {
  if (!stallErrorMessage || parentSignal?.aborted) return message;
  if (message.stopReason !== "aborted" && message.stopReason !== "error") return message;
  return { ...message, stopReason: "error", errorMessage: stallErrorMessage };
}

/** Codex-style backoff: base * factor^(attempt-1) * uniform(0.9, 1.1), uncapped. */
export function computeStreamRetryBackoffMs(attempt: number): number {
  const base = STREAM_RETRY_BASE_DELAY_MS * STREAM_RETRY_BACKOFF_FACTOR ** (attempt - 1);
  return base * (0.9 + Math.random() * 0.2);
}

/**
 * Swaps an adapter's prebuilt options' signal for the attempt signal handed to
 * a withStreamRetry factory. Returns the options untouched when there is none
 * (watchdog off), so the no-watchdog request is exactly what it was before.
 */
export function withAttemptSignal<T extends { signal?: AbortSignal }>(
  options: T,
  attemptSignal: AbortSignal | undefined,
): T {
  return attemptSignal ? { ...options, signal: attemptSignal } : options;
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
 * Whether an uncommitted failed attempt is worth another try at this layer.
 */
function shouldRetryFailedAttempt(
  failedMessage: AssistantMessage,
  stalled: boolean,
  options: StreamRetryOptions | undefined,
): boolean {
  if (stalled) return options?.retryOnStall ?? false;
  // A user-configured substring wins over the overflow guard: the user knows
  // their relay's wording better than pi-ai's catch-all overflow patterns.
  const { patterns } = options?.retryExtension ?? getRetryErrorExtension();
  if (isExtensionRetryableError(failedMessage, { patterns })) return true;
  // Overflow never heals by resending the same payload — and pi-ai's
  // unanchored "503" pattern would otherwise retry "205031 tokens > 200000".
  if (isOverflowError(failedMessage)) return false;
  // pi-ai's classifier first (preserves its non-retryable quota/billing
  // guard), then LiveAgent's extension: preset HTTP status codes (Cloudflare
  // 520-527 for relays, #608) + user-defined substrings from settings.
  return (
    isRetryableAssistantError(failedMessage) ||
    isExtensionRetryableError(failedMessage, options?.retryExtension)
  );
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
 *
 * Opt-in watchdog (`firstEventTimeoutMs` / `idleTimeoutMs`): each attempt then
 * gets its own AbortController linked to `options.signal`, handed to the
 * factory as `attemptSignal`. A fired timer aborts only that attempt and its
 * terminal — both the pushed event and `result()` — becomes a stall `error`
 * (see `isStreamStallError`) before the retry decision; it is retried only
 * when uncommitted and `retryOnStall` is set. With no timer configured the
 * factory gets no attempt signal and behaves exactly as before.
 */
export function withStreamRetry(
  factory: (attemptSignal?: AbortSignal) => AssistantMessageEventStream,
  options?: StreamRetryOptions,
): AssistantMessageEventStream {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_STREAM_RETRY_MAX_ATTEMPTS);
  const disabled = options?.disabled ?? false;
  const signal = options?.signal;
  const firstEventTimeoutMs = positiveTimeoutMs(options?.firstEventTimeoutMs);
  const idleTimeoutMs = positiveTimeoutMs(options?.idleTimeoutMs);
  const watchdogEnabled = firstEventTimeoutMs !== undefined || idleTimeoutMs !== undefined;

  const startAttempt = (): {
    source: AssistantMessageEventStream;
    watchdog: AttemptWatchdog | undefined;
  } => {
    if (!watchdogEnabled) return { source: factory(), watchdog: undefined };
    const watchdog = createAttemptWatchdog(signal, firstEventTimeoutMs, idleTimeoutMs);
    try {
      return { source: factory(watchdog.signal), watchdog };
    } catch (error) {
      watchdog.dispose();
      throw error;
    }
  };

  const output = createAssistantMessageEventStream();
  const firstAttempt = startAttempt();

  void (async () => {
    let attempt = 1;
    let { source, watchdog } = firstAttempt;
    let hasRetried = false;

    while (true) {
      let committed = false;
      let stalled = false;
      const buffered: AssistantMessageEvent[] = [];
      let terminal: TerminalEvent | undefined;

      try {
        for await (const sourceEvent of source) {
          let event = sourceEvent;
          if (watchdog && isTerminalEvent(event)) {
            const message = terminalMessage(event);
            const rewritten = rewriteStalledMessage(message, watchdog.stallErrorMessage, signal);
            if (rewritten !== message) {
              event = { type: "error", reason: "error", error: rewritten };
              stalled = true;
            }
          }
          watchdog?.observe(event);
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
      } finally {
        watchdog?.dispose();
      }

      if (terminal?.type === "error" && !committed && !disabled && attempt < maxAttempts) {
        const failedMessage = terminalMessage(terminal);
        if (shouldRetryFailedAttempt(failedMessage, stalled, options)) {
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
            ({ source, watchdog } = startAttempt());
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
      const final = await source.result();
      output.end(
        watchdog ? rewriteStalledMessage(final, watchdog.stallErrorMessage, signal) : final,
      );
      return;
    }
  })();

  return output;
}
