import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { isExtensionRetryableError, type RetryErrorExtension } from "./streamRetry";

/**
 * Provider auto-failover runtime (cc-switch inspired).
 *
 * Mirrors cc-switch's proxy-side design adapted to LiveAgent's client-side
 * streaming architecture:
 * - a per-target circuit breaker ("consecutive failures → open → cooldown →
 *   half-open probe") keyed by `customProviderId::model`;
 * - an error classifier that decides whether switching providers can help
 *   (provider-fault class) or not (client-request class);
 * - a stream wrapper that tries an ordered candidate list and only fails over
 *   while the current attempt has not committed any visible content, matching
 *   withStreamRetry's buffering semantics so the consumer never sees events
 *   from a discarded attempt.
 *
 * Unlike cc-switch (which always routes by queue priority, P1 first), LiveAgent
 * keeps the user's per-conversation model selection first and uses the queue as
 * fallback order. The breaker intentionally skips cc-switch's half-open permit
 * accounting: LiveAgent's request concurrency is bounded (one chat turn plus a
 * handful of subagents), so unlimited half-open probes are acceptable and much
 * simpler.
 */

export type ModelFailoverRuntimeConfig = {
  /** Maximum provider switches per round (attempts = switches + 1). */
  maxSwitches: number;
  /** Consecutive eligible failures before the breaker opens. */
  failureThreshold: number;
  /** Seconds an open breaker waits before allowing a half-open probe. */
  cooldownSeconds: number;
};

export const MODEL_FAILOVER_BREAKER_LIMITS = {
  maxSwitches: { min: 1, max: 10, fallback: 3 },
  failureThreshold: { min: 1, max: 10, fallback: 4 },
  cooldownSeconds: { min: 5, max: 3600, fallback: 60 },
} as const;

/** 候选来自哪一层（设计文档 8.2）：凭据 → 源 → 端点 → 供应商，四层共用一份切换预算。 */
export type ProviderFailoverLayer = "credential" | "origin" | "endpoint" | "provider";

/** 源地址的主机（含非默认端口）；解析失败退回原串，保证键仍可区分。 */
function originHostKey(origin: string): string {
  const trimmed = origin.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed;
  }
}

/**
 * 熔断 key。四层候选（设计文档 8.2）共用一张表：同一供应商下不同凭据 / 不同源 /
 * 不同接口各自独立计数，一把 Key、一个源或一条渠道对某个模型失败不影响其它候选。
 * 带源时为 `provider::credential::originHost::protocol::model`；不带源时保持
 * `provider::credential::protocol::model`，不带 scope 的旧调用保持 `provider::model`。
 */
export function failoverBreakerKey(
  customProviderId: string,
  model: string,
  scope?: { credentialId?: string; protocol?: string; origin?: string },
): string {
  const credentialId = scope?.credentialId?.trim() ?? "";
  const protocol = scope?.protocol?.trim() ?? "";
  const origin = originHostKey(scope?.origin ?? "");
  if (!credentialId && !protocol && !origin) return `${customProviderId}::${model}`;
  if (!origin) return `${customProviderId}::${credentialId}::${protocol}::${model}`;
  return `${customProviderId}::${credentialId}::${origin}::${protocol}::${model}`;
}

type BreakerEntry = {
  consecutiveFailures: number;
  /** Epoch ms when the breaker opened; null while closed. */
  openedAt: number | null;
};

const breakerRegistry = new Map<string, BreakerEntry>();

function getBreakerEntry(key: string): BreakerEntry {
  let entry = breakerRegistry.get(key);
  if (!entry) {
    entry = { consecutiveFailures: 0, openedAt: null };
    breakerRegistry.set(key, entry);
  }
  return entry;
}

/**
 * Closed → available. Open → available only after the cooldown elapsed
 * (half-open probe; a failed probe re-opens the window from "now").
 */
export function isFailoverTargetAvailable(
  key: string,
  config: Pick<ModelFailoverRuntimeConfig, "cooldownSeconds">,
  now = Date.now(),
): boolean {
  const entry = breakerRegistry.get(key);
  if (!entry || entry.openedAt === null) return true;
  return now - entry.openedAt >= config.cooldownSeconds * 1000;
}

export function recordFailoverTargetResult(
  key: string,
  success: boolean,
  config: Pick<ModelFailoverRuntimeConfig, "failureThreshold">,
  now = Date.now(),
): void {
  const entry = getBreakerEntry(key);
  if (success) {
    entry.consecutiveFailures = 0;
    entry.openedAt = null;
    return;
  }
  entry.consecutiveFailures += 1;
  const threshold = Math.max(1, config.failureThreshold);
  if (entry.consecutiveFailures >= threshold) {
    // Open (or re-open after a failed half-open probe): restart the cooldown.
    entry.openedAt = now;
  }
}

export function resetFailoverBreakers(key?: string): void {
  if (typeof key === "string") {
    breakerRegistry.delete(key);
    return;
  }
  breakerRegistry.clear();
}

export function getFailoverBreakerSnapshot(
  key: string,
): { consecutiveFailures: number; openedAt: number | null } | null {
  const entry = breakerRegistry.get(key);
  return entry
    ? { consecutiveFailures: entry.consecutiveFailures, openedAt: entry.openedAt }
    : null;
}

/**
 * Client-request-class failures where every provider would reject the same
 * payload (cc-switch's NonRetryable bucket: 400/413/422-style semantic
 * errors). Context-window overflow belongs to compaction, not failover.
 */
const FAILOVER_INELIGIBLE_ERROR_PATTERN = new RegExp(
  [
    "context.?length",
    "context.?window",
    "maximum.?context",
    "prompt is too long",
    "too many tokens",
    "input.?(?:is.?)?too.?long",
    "string too long",
    "invalid.?request.?format",
    "unsupported.?media",
    "payload.?too.?large",
    "request.?entity.?too.?large",
  ].join("|"),
  "i",
);

/**
 * Failures that same-provider retry treats as fatal but a *different* provider
 * can genuinely fix: separate API keys, separate quota pools, separate
 * accounts. This is the key difference between pi-ai's retry classification
 * and cross-provider failover (cc-switch keeps 401/403/429-with-quota in the
 * retryable bucket for exactly this reason).
 */
/**
 * 鉴权 / 账户类错误（401 / 403 等）：换 Key 或换供应商有意义，换源没有——同一把 Key
 * 在另一台主机上照样被拒。源层候选对这类错误跳过。
 */
const FAILOVER_AUTH_ERROR_SOURCES = [
  "\\b401\\b",
  "\\b403\\b",
  "unauthorized",
  "forbidden",
  "invalid.?(?:api.?key|x-api-key|token)",
  "api.?key.?(?:not|is).?(?:valid|found)",
  "authentication",
  "permission.?denied",
  "account.?(?:suspended|disabled|banned)",
];

const FAILOVER_AUTH_ERROR_PATTERN = new RegExp(FAILOVER_AUTH_ERROR_SOURCES.join("|"), "i");

export function isFailoverAuthError(errorMessage: string | undefined): boolean {
  return Boolean(errorMessage) && FAILOVER_AUTH_ERROR_PATTERN.test(errorMessage ?? "");
}

const FAILOVER_EXTRA_ELIGIBLE_ERROR_PATTERN = new RegExp(
  [
    // Quota / billing exhaustion — pi-ai marks these non-retryable for the
    // same provider, but another provider has an independent balance.
    "insufficient_quota",
    "quota exceeded",
    "exceeded your current quota",
    "out of budget",
    "billing",
    "monthly usage limit",
    "available balance",
    "insufficient.?(?:credit|balance|funds)",
    // Auth / account state — another provider holds a different key.
    "\\b402\\b",
    ...FAILOVER_AUTH_ERROR_SOURCES,
    // Routing-level not-found: a relay without the model → another provider
    // may host it under the same id.
    "\\b404\\b",
    "model.?not.?(?:found|exist)",
  ].join("|"),
  "i",
);

/**
 * Whether a terminal stream error is worth switching providers for.
 *
 * Order matters: the ineligible guard runs first so "prompt is too long"
 * style client errors never fail over even though they may contain digits
 * that look like status codes.
 */
export function isFailoverEligibleAssistantError(
  message: AssistantMessage | undefined,
  retryExtension?: RetryErrorExtension,
): boolean {
  if (!message) return false;
  const errorMessage = (message as { errorMessage?: string }).errorMessage ?? "";
  if (FAILOVER_INELIGIBLE_ERROR_PATTERN.test(errorMessage)) return false;
  if (isRetryableAssistantError(message)) return true;
  // Same LiveAgent extension as withStreamRetry: a transient relay 5xx (#608)
  // or a user-defined pattern is worth trying a different provider for — a
  // fallback relay holds an independent origin/key and may not hit the same
  // Cloudflare edge. Matches pi-ai's existing 524 → failover-eligible behavior.
  if (isExtensionRetryableError(message, retryExtension)) return true;
  return FAILOVER_EXTRA_ELIGIBLE_ERROR_PATTERN.test(errorMessage);
}

export type ProviderFailoverCandidate = {
  /** Breaker identity, from failoverBreakerKey(customProviderId, model). */
  key: string;
  /** Human-readable "Provider · model" label for status surfaces. */
  label: string;
  /**
   * 候选所属层；缺省视为供应商层。源层候选只对连接 / 超时 / 5xx 类失败生效：上一次
   * 失败是鉴权类错误时跳过（同一把 Key 换主机无意义）。
   */
  layer?: ProviderFailoverLayer;
  /** Model identity used to synthesize an error message when start() fails. */
  model: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; id: string };
  /**
   * Lazily builds this candidate's stream. Only invoked when the candidate is
   * actually attempted, so fallback proxy/model preparation stays off the hot
   * path. May reject: that counts as an eligible failure and moves on.
   */
  start: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
};

export type ProviderFailoverEvent = {
  fromLabel: string;
  toLabel: string;
  /** Index into the original candidates array for the target being tried. */
  toIndex: number;
  errorMessage: string;
};

export type ProviderFailoverStreamOptions = {
  config: ModelFailoverRuntimeConfig;
  signal?: AbortSignal;
  /** Fired before each switch, including a skip of an open-breaker primary. */
  onFailover?: (event: ProviderFailoverEvent) => void;
  /**
   * Fired once per attempt that produces a usable outcome (first committed
   * content event, or a clean done). Callers use it to make the winning
   * candidate sticky for subsequent rounds.
   */
  onCommitted?: (candidateIndex: number) => void;
  now?: () => number;
  /**
   * Per-call override for the retry-error extension used by the eligibility
   * classifier. Defaults to the process-wide extension
   * ({@link setRetryErrorExtension}); kept consistent with withStreamRetry so a
   * transient error retryable by same-provider retry is also failover-eligible.
   */
  retryExtension?: RetryErrorExtension;
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

function terminalErrorMessage(event: TerminalEvent | undefined): string {
  if (!event) return "Unknown error";
  const message = terminalMessage(event) as { errorMessage?: string } | undefined;
  return message?.errorMessage || "Unknown error";
}

function buildStartFailureAssistantMessage(
  candidate: ProviderFailoverCandidate,
  error: unknown,
): AssistantMessage {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    role: "assistant",
    content: [],
    api: candidate.model.api,
    provider: candidate.model.provider,
    model: candidate.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  } as AssistantMessage;
}

/**
 * Runs candidates in order with buffer-until-commit semantics.
 *
 * - candidates[0] is the active selection; the rest follow failover-queue
 *   order. Candidates whose breaker is open are skipped up front (unless that
 *   would leave nothing — then the primary is attempted anyway, mirroring
 *   cc-switch's single-provider breaker bypass).
 * - An attempt that terminally errors before committing any content, with a
 *   failover-eligible error, is discarded wholesale and the next candidate is
 *   started. The consumer never sees the failed attempt's events.
 * - Once content commits (or retries are exhausted), events pass through and
 *   the attempt's terminal result ends the output stream.
 * - Breaker bookkeeping matches cc-switch: eligible failures count against
 *   the target, client-class failures leave health untouched, done resets it.
 */
export function withProviderFailover(
  candidates: ProviderFailoverCandidate[],
  options: ProviderFailoverStreamOptions,
): AssistantMessageEventStream {
  if (candidates.length === 0) {
    throw new Error("withProviderFailover requires at least one candidate");
  }
  const output = createAssistantMessageEventStream();
  const now = options.now ?? Date.now;
  const { config, signal } = options;

  const attemptPlan: { candidate: ProviderFailoverCandidate; index: number }[] = [];
  candidates.forEach((candidate, index) => {
    if (isFailoverTargetAvailable(candidate.key, config, now())) {
      attemptPlan.push({ candidate, index });
    }
  });
  if (attemptPlan.length === 0) {
    // Every breaker is open: fail open on the primary instead of dead-ending.
    attemptPlan.push({ candidate: candidates[0], index: 0 });
  }
  // Starting on a fallback because the primary's breaker is open is already a
  // provider switch, so it consumes one unit of the switch budget: with
  // maxSwitches=1 and an open primary, exactly one fallback is attempted.
  const initialSwitches = attemptPlan[0].index === 0 ? 0 : 1;
  const maxAttempts = Math.max(
    1,
    Math.min(attemptPlan.length, config.maxSwitches + 1 - initialSwitches),
  );

  void (async () => {
    let lastTerminal: TerminalEvent | undefined;
    // 鉴权类失败后源层候选不再尝试：同一把 Key 换主机照样被拒。
    let skipOriginLayer = false;
    const nextCursor = (from: number): number => {
      for (let cursor = from; cursor < attemptPlan.length; cursor++) {
        if (skipOriginLayer && attemptPlan[cursor].candidate.layer === "origin") continue;
        return cursor;
      }
      return -1;
    };
    /** 失败后是否还能换下一个候选；能则返回下一个游标，否则 -1。 */
    const advance = (attempt: number, cursor: number): number => {
      if (attempt + 1 >= maxAttempts || signal?.aborted) return -1;
      skipOriginLayer ||= isFailoverAuthError(terminalErrorMessage(lastTerminal));
      return nextCursor(cursor + 1);
    };

    let cursor = 0;
    let previous: ProviderFailoverCandidate | undefined;
    for (let attempt = 0; attempt < maxAttempts && cursor >= 0; attempt++) {
      const { candidate, index } = attemptPlan[cursor];

      if (attempt > 0 || index !== 0) {
        options.onFailover?.({
          fromLabel: (previous ?? candidates[0]).label,
          toLabel: candidate.label,
          toIndex: index,
          errorMessage: attempt > 0 ? terminalErrorMessage(lastTerminal) : "circuit breaker open",
        });
      }
      previous = candidate;

      let source: AssistantMessageEventStream;
      try {
        source = await candidate.start();
      } catch (error) {
        // Candidate failed to even start (proxy prep/config). Counts as an
        // eligible provider fault; move on unless this was the final attempt.
        recordFailoverTargetResult(candidate.key, false, config, now());
        const failureMessage = buildStartFailureAssistantMessage(candidate, error);
        lastTerminal = { type: "error", reason: "error", error: failureMessage };
        const next = advance(attempt, cursor);
        if (next >= 0) {
          cursor = next;
          continue;
        }
        // Surface the real failure through the standard error event contract.
        output.push(lastTerminal);
        output.end();
        return;
      }

      let committed = false;
      const buffered: AssistantMessageEvent[] = [];
      let terminal: TerminalEvent | undefined;
      let terminalEligible = false;

      for await (const event of source) {
        // Breaker bookkeeping runs BEFORE the terminal event is forwarded so
        // consumers resuming on the terminal always observe updated breaker
        // state (recording after the push would race the consumer microtask).
        if (isTerminalEvent(event)) {
          terminal = event;
          if (event.type === "done") {
            recordFailoverTargetResult(candidate.key, true, config, now());
          } else if (event.reason !== "aborted") {
            terminalEligible = isFailoverEligibleAssistantError(
              terminalMessage(event) as AssistantMessage,
              options?.retryExtension,
            );
            if (terminalEligible) {
              recordFailoverTargetResult(candidate.key, false, config, now());
            }
          }
        }
        if (!committed && COMMITTING_EVENT_TYPES.has(event.type)) {
          committed = true;
          options.onCommitted?.(index);
          for (const bufferedEvent of buffered.splice(0)) output.push(bufferedEvent);
        }
        if (committed) {
          output.push(event);
        } else {
          buffered.push(event);
        }
      }

      if (terminal?.type === "done") {
        if (!committed) {
          options.onCommitted?.(index);
          for (const bufferedEvent of buffered) output.push(bufferedEvent);
        }
        output.end(await source.result());
        return;
      }

      lastTerminal = terminal;

      if (!committed && terminalEligible) {
        const next = advance(attempt, cursor);
        if (next >= 0) {
          // Discard this attempt's buffered events and try the next candidate.
          cursor = next;
          continue;
        }
      }

      // Terminal failure we must surface: committed content, client-class
      // error, exhausted attempts, or user abort.
      if (!committed) {
        for (const bufferedEvent of buffered) output.push(bufferedEvent);
      }
      output.end(await source.result());
      return;
    }
  })();

  return output;
}
