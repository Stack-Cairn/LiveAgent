import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";

/** 6 total attempts = 5 retries after the initial try — matches codex's stream_max_retries=5. */
export const DEFAULT_STREAM_RETRY_MAX_ATTEMPTS = 6;

export type RetryAttemptRecord = {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
};

const STREAM_RETRY_BASE_DELAY_MS = 200;
const STREAM_RETRY_BACKOFF_FACTOR = 2;

export type StreamRetryConfig = {
  maxAttempts?: number;
  disabled?: boolean;
  /**
   * Retry ordinal (1..maxRetries) about to be attempted, invoked before the
   * backoff sleep. `errorMessage` is the failure that triggered this retry.
   */
  onRetry?: (attempt: number, maxAttempts: number, errorMessage: string) => void;
  /** Invoked once a retried attempt commits its first content-bearing event. */
  onRetryRecovered?: () => void;
  /**
   * 多 API Key 故障转移：主 Key 优先，请求失败（429/限额/鉴权等可重试错误）时
   * 切到下一个 Key 重试。`keys` 为候选列表（首项即主 Key），`rotate` 在每次重试
   * 前被调用以更新当次尝试的凭据；streamByApi 的 factory 在每次 factory() 调用
   * 时从 rotate 写入的 mutable holder 重新读取 apiKey/headers，从而让重试落到
   * 不同 Key 上。一旦开始流式产出（committed）即不再换 Key。
   */
  apiKeyFailover?: {
    keys: string[];
    rotate: (attemptIndex: number) => void;
  };
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
 * in place of the frozen UI, mirroring codex's TUI behavior.
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
  // 多 Key 故障转移：第 0 次（主 Key）在首请求前对齐，重试时逐一切到下一个 Key。
  options?.apiKeyFailover?.rotate(0);
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
          options?.onRetry?.(attempt - 1, maxAttempts - 1, errorMessage);
          hasRetried = true;
          try {
            await sleepWithAbort(computeStreamRetryBackoffMs(attempt - 1), signal);
            // 切到下一个 Key（越界时 rotate 自行兜底，通常回到主 Key 重试）。
            options?.apiKeyFailover?.rotate(attempt - 1);
            source = factory();
            continue;
          } catch {
            // Aborted mid-backoff, or the next attempt failed to start —
            // surface the prior attempt's real failure below instead of
            // hanging the consumer on a retry that will never happen.
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
