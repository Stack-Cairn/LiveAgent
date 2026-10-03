import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  withStreamRetry,
  computeStreamRetryBackoffMs,
  DEFAULT_STREAM_RETRY_MAX_ATTEMPTS,
  isExtensionRetryableError,
  isStreamStallError,
  setRetryErrorExtension,
  getRetryErrorExtension,
} = loader.loadModule("src/lib/providers/runtime/streamRetry.ts");
const piAiRetry = await import(
  new URL("../../node_modules/@earendil-works/pi-ai/dist/utils/retry.js", import.meta.url).href
);
const { isFailoverEligibleAssistantError } = loader.loadModule(
  "src/lib/providers/runtime/providerFailover.ts",
);

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(text, stopReason, extra = {}) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: createUsage(),
    stopReason,
    timestamp: Date.now(),
    ...extra,
  };
}

function createErrorStream(errorMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "error", error: createAssistant(undefined, "error", { errorMessage }) };
    },
    async result() {
      return createAssistant(undefined, "error", { errorMessage });
    },
  };
}

function createSuccessStream(text) {
  const assistant = createAssistant(text, "stop");
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...assistant, content: [] } };
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: { ...assistant, content: [{ type: "text", text }] },
      };
      yield { type: "done", message: assistant };
    },
    async result() {
      return assistant;
    },
  };
}

function createErrorAfterContentStream(text, errorMessage) {
  const partial = createAssistant(text, "error", { errorMessage });
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...partial, content: [] } };
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: { ...partial, content: [{ type: "text", text }] },
      };
      yield { type: "error", error: partial };
    },
    async result() {
      return partial;
    },
  };
}

function createAbortedDoneStream() {
  const assistant = createAssistant(undefined, "aborted");
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", message: assistant };
    },
    async result() {
      return assistant;
    },
  };
}

async function collectEvents(eventStream) {
  const events = [];
  for await (const event of eventStream) events.push(event);
  return events;
}

test("withStreamRetry succeeds after N retryable errors without leaking failed-attempt events", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls < 3) return createErrorStream("503 service unavailable");
      return createSuccessStream("final answer");
    },
    { maxAttempts: 5 },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 3);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_delta", "done"],
  );
  const final = await wrapped.result();
  assert.equal(final.stopReason, "stop");
  assert.equal(final.content[0].text, "final answer");
});

test("withStreamRetry invokes onRetry per attempt and onRetryRecovered once content commits", async () => {
  let calls = 0;
  const retryCalls = [];
  let recoveredCalls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls < 3) return createErrorStream("503 service unavailable");
      return createSuccessStream("final answer");
    },
    {
      maxAttempts: 5,
      onRetry: (attempt, maxAttempts) => retryCalls.push([attempt, maxAttempts]),
      onRetryRecovered: () => {
        recoveredCalls += 1;
      },
    },
  );

  await collectEvents(wrapped);
  assert.deepEqual(retryCalls, [
    [1, 4],
    [2, 4],
  ]);
  assert.equal(recoveredCalls, 1);
});

test("withStreamRetry passes the failing attempt's error message as onRetry's third argument", async () => {
  let calls = 0;
  const retryErrorMessages = [];
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls < 3) return createErrorStream(`503 service unavailable (call ${calls})`);
      return createSuccessStream("final answer");
    },
    {
      maxAttempts: 5,
      onRetry: (_attempt, _maxAttempts, errorMessage) => retryErrorMessages.push(errorMessage),
    },
  );

  await collectEvents(wrapped);
  assert.deepEqual(retryErrorMessages, [
    "503 service unavailable (call 1)",
    "503 service unavailable (call 2)",
  ]);
});

test("withStreamRetry reports the exact backoff about to be slept as onRetry's fourth argument", async () => {
  let calls = 0;
  const plannedDelays = [];
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls < 3) return createErrorStream("503 service unavailable");
      return createSuccessStream("final answer");
    },
    {
      maxAttempts: 5,
      onRetry: (_attempt, _maxAttempts, _errorMessage, plannedDelayMs) =>
        plannedDelays.push(plannedDelayMs),
    },
  );

  await collectEvents(wrapped);
  assert.equal(plannedDelays.length, 2);
  // codex-style backoff: base 200ms * 2^(n-1) * uniform(0.9, 1.1).
  assert.ok(plannedDelays[0] >= 180 && plannedDelays[0] <= 220, `attempt 1: ${plannedDelays[0]}`);
  assert.ok(plannedDelays[1] >= 360 && plannedDelays[1] <= 440, `attempt 2: ${plannedDelays[1]}`);
});

test("withStreamRetry never calls onRetryRecovered when no retry occurred", async () => {
  let recoveredCalls = 0;
  const wrapped = withStreamRetry(() => createSuccessStream("first try"), {
    onRetryRecovered: () => {
      recoveredCalls += 1;
    },
  });

  await collectEvents(wrapped);
  assert.equal(recoveredCalls, 0);
});

test("withStreamRetry does not retry once content has been committed", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(() => {
    calls += 1;
    return createErrorAfterContentStream("partial", "503 service unavailable");
  });

  const events = await collectEvents(wrapped);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_delta", "error"],
  );
  const final = await wrapped.result();
  assert.equal(final.stopReason, "error");
});

test("withStreamRetry never retries an aborted stream", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(() => {
    calls += 1;
    return createAbortedDoneStream();
  });

  const events = await collectEvents(wrapped);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["done"],
  );
  const final = await wrapped.result();
  assert.equal(final.stopReason, "aborted");
});

test("withStreamRetry respects maxAttempts and surfaces the last failure", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream(`rate limit exceeded (attempt ${calls})`);
    },
    { maxAttempts: 3 },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  const final = await wrapped.result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage, /attempt 3/);
});

test("withStreamRetry does not retry non-retryable errors", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream("insufficient_quota: billing required");
    },
    { maxAttempts: 5 },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 1);
  assert.equal(events[0].type, "error");
});

test("withStreamRetry backoff aborted before it can fire prevents any further attempt", async () => {
  // Pre-abort so the retry loop's sleepWithAbort() rejects synchronously on
  // its aborted-check, instead of racing a real timer against a real abort
  // (which would make this test's timing non-deterministic).
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream("503 service unavailable");
    },
    { maxAttempts: 5, signal: controller.signal },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  // A stop during the backoff is a cancellation, not the failed attempt's
  // transport error: replaying the 503 here would hide the fact that the user
  // stopped the run, so every abort branch upstream would miss it.
  assert.equal(events[0].reason, "aborted");
  assert.equal(events[0].error.stopReason, "aborted");
});

test("withStreamRetry resolves an aborted backoff to an aborted final message", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const wrapped = withStreamRetry(() => createErrorStream("502 bad gateway"), {
    maxAttempts: 5,
    signal: controller.signal,
  });

  await collectEvents(wrapped);
  const final = await wrapped.result();
  assert.equal(final.stopReason, "aborted");
  // The model identity of the cancelled round survives, so the persisted
  // record still says which provider/model the stopped turn belonged to.
  assert.equal(final.model, "test-model");
  assert.equal(final.provider, "anthropic");
});

test("withStreamRetry reports the retry that was cancelled through onRetry", async () => {
  // The status row and the persisted stop notice both read the last retry
  // record, so the retry that was in flight when the user stopped must have
  // been reported before the abort lands.
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const retryCalls = [];
  const wrapped = withStreamRetry(() => createErrorStream("502 bad gateway"), {
    maxAttempts: 5,
    signal: controller.signal,
    onRetry: (attempt, maxAttempts, errorMessage) =>
      retryCalls.push([attempt, maxAttempts, errorMessage]),
  });

  await collectEvents(wrapped);
  assert.deepEqual(retryCalls, [[1, 4, "502 bad gateway"]]);
});

test("withStreamRetry with disabled:true never retries", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream("503 service unavailable");
    },
    { maxAttempts: 5, disabled: true },
  );

  await collectEvents(wrapped);
  assert.equal(calls, 1);
});

test("computeStreamRetryBackoffMs follows codex's uncapped base*2^(n-1)*jitter(0.9,1.1) formula", () => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const delay = computeStreamRetryBackoffMs(attempt);
    const base = 200 * 2 ** (attempt - 1);
    assert.ok(delay >= base * 0.9);
    assert.ok(delay <= base * 1.1);
  }
});

test("DEFAULT_STREAM_RETRY_MAX_ATTEMPTS is 6 total attempts (5 retries), matching codex", () => {
  assert.equal(DEFAULT_STREAM_RETRY_MAX_ATTEMPTS, 6);
});

// ---- LiveAgent retry-error extension (#608: Cloudflare 5xx from relays) ----

test("isExtensionRetryableError matches a preset status code embedded in an error message", () => {
  const message = createAssistant(undefined, "error", { errorMessage: "HTTP 525 SSL handshake failed" });
  assert.equal(isExtensionRetryableError(message, { statusCodes: [525] }), true);
});

test("isExtensionRetryableError does not match a status code that's a substring of a larger number", () => {
  // "5200" must not match preset 520 (word-boundary guard).
  const message = createAssistant(undefined, "error", { errorMessage: "upstream returned 5200" });
  assert.equal(isExtensionRetryableError(message, { statusCodes: [520] }), false);
});

test("isExtensionRetryableError matches a custom substring case-insensitively", () => {
  const message = createAssistant(undefined, "error", { errorMessage: "Upstream SSL Handshake Failed" });
  assert.equal(
    isExtensionRetryableError(message, { statusCodes: [], patterns: ["ssl handshake failed"] }),
    true,
  );
});

test("isExtensionRetryableError returns false for an unrelated error and an empty extension", () => {
  const message = createAssistant(undefined, "error", { errorMessage: "insufficient_quota: billing" });
  assert.equal(isExtensionRetryableError(message, { statusCodes: [], patterns: [] }), false);
});

test("withStreamRetry retries a Cloudflare 525 (#608) via an explicit retryExtension", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls < 2) return createErrorStream("HTTP 525 SSL Handshake Failed");
      return createSuccessStream("recovered");
    },
    { maxAttempts: 5, retryExtension: { statusCodes: [525] } },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 2);
  const final = await wrapped.result();
  assert.equal(final.stopReason, "stop");
});

test("withStreamRetry retries a user-defined custom substring pattern", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls < 2) return createErrorStream("origin SSL handshake with upstream failed");
      return createSuccessStream("ok");
    },
    { maxAttempts: 5, retryExtension: { statusCodes: [], patterns: ["SSL handshake"] } },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 2);
});

test("withStreamRetry does NOT retry a preset code the user has disabled", async () => {
  // retryExtension omits 525 (user toggled it off) and carries nothing else that
  // matches — pi-ai doesn't classify 525 either, so the turn must fail fast.
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream("HTTP 525 SSL Handshake Failed");
    },
    { maxAttempts: 5, retryExtension: { statusCodes: [], patterns: [] } },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 1);
  const final = await wrapped.result();
  assert.equal(final.stopReason, "error");
});

test("withStreamRetry still does not retry a non-retryable quota error when the extension doesn't match it", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream("insufficient_quota: billing required");
    },
    { maxAttempts: 5, retryExtension: { statusCodes: [525], patterns: ["SSL handshake"] } },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 1);
});

test("withStreamRetry retries a Cloudflare 525 via the module default extension (zero-config #608 fix)", async () => {
  // Reset to the process-wide default (all presets on) so this test doesn't
  // depend on ordering or prior tests mutating the module extension.
  setRetryErrorExtension(null);
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls < 2) return createErrorStream("HTTP 525 SSL Handshake Failed");
      return createSuccessStream("recovered");
    },
    { maxAttempts: 5 },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 2);
});

test("isFailoverEligibleAssistantError treats a Cloudflare 525 as failover-eligible via the extension", () => {
  const message = createAssistant(undefined, "error", { errorMessage: "HTTP 525 SSL Handshake Failed" });
  assert.equal(isFailoverEligibleAssistantError(message, { statusCodes: [525] }), true);
});

test("isFailoverEligibleAssistantError still rejects client-class errors even if the extension matches", () => {
  // Context-overflow is ineligible regardless of extension — switching providers
  // can't fix a too-long prompt.
  const message = createAssistant(undefined, "error", {
    errorMessage: "prompt is too long (520 context length exceeded)",
  });
  assert.equal(isFailoverEligibleAssistantError(message, { statusCodes: [520] }), false);
});

// ---- Extension state + classifier edge cases ----

test("setRetryErrorExtension / getRetryErrorExtension round-trip and restore-to-default", () => {
  // The default enables every Cloudflare preset, so a 525 matches it without
  // any per-call extension.
  const message = createAssistant(undefined, "error", { errorMessage: "HTTP 525" });
  assert.equal(isExtensionRetryableError(message), true);

  // A user who disabled every preset and added no patterns sees no match.
  setRetryErrorExtension({ statusCodes: [], patterns: [] });
  assert.equal(isExtensionRetryableError(message), false);
  assert.deepEqual(getRetryErrorExtension(), { statusCodes: [], patterns: [] });

  // Custom patterns flow through the module extension too.
  setRetryErrorExtension({ statusCodes: [], patterns: ["ssl handshake failed"] });
  assert.equal(
    isExtensionRetryableError(
      createAssistant(undefined, "error", { errorMessage: "upstream SSL Handshake Failed" }),
    ),
    true,
  );

  // null restores the default (all presets on) — the zero-config #608 fix.
  setRetryErrorExtension(null);
  assert.equal(isExtensionRetryableError(message), true);
});

test("isExtensionRetryableError returns false for undefined or empty error messages", () => {
  assert.equal(isExtensionRetryableError(undefined, { statusCodes: [525] }), false);
  assert.equal(
    isExtensionRetryableError(createAssistant(undefined, "error"), { statusCodes: [525] }),
    false,
  );
  assert.equal(
    isExtensionRetryableError(
      createAssistant(undefined, "error", { errorMessage: "" }),
      { statusCodes: [525] },
    ),
    false,
  );
});

test("isExtensionRetryableError matches any one of several preset codes (alternation)", () => {
  const ext = { statusCodes: [520, 521, 525], patterns: [] };
  for (const code of [520, 521, 525]) {
    assert.equal(
      isExtensionRetryableError(
        createAssistant(undefined, "error", { errorMessage: `error ${code} occurred` }),
        ext,
      ),
      true,
    );
  }
  // An unrelated 5xx not in the list is not matched by the code branch.
  assert.equal(
    isExtensionRetryableError(
      createAssistant(undefined, "error", { errorMessage: "error 530 occurred" }),
      ext,
    ),
    false,
  );
});

test("isExtensionRetryableError ignores whitespace-only custom patterns", () => {
  const ext = { statusCodes: [], patterns: ["   ", ""] };
  assert.equal(
    isExtensionRetryableError(
      createAssistant(undefined, "error", { errorMessage: "anything" }),
      ext,
    ),
    false,
  );
});

// ---- Context overflow is never retried ----

test("withStreamRetry never retries a context overflow whose token count contains 503", async () => {
  // pi-ai's unanchored "503" pattern matches "205031 tokens": without the
  // overflow guard this would burn every retry on a payload that can't fit.
  const errorMessage = "prompt is too long: 205031 tokens > 200000 maximum";
  assert.equal(
    piAiRetry.isRetryableAssistantError(createAssistant(undefined, "error", { errorMessage })),
    true,
  );
  let calls = 0;
  const retryCalls = [];
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream(errorMessage);
    },
    { maxAttempts: 5, onRetry: (...args) => retryCalls.push(args) },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 1);
  assert.deepEqual(retryCalls, []);
  assert.deepEqual(
    events.map((event) => event.type),
    ["error"],
  );
  assert.equal((await wrapped.result()).errorMessage, errorMessage);
});

test("withStreamRetry still retries throttles that pi-ai's overflow fallbacks would match", async () => {
  // LiteLLM in front of Bedrock: "RateLimitError" has no space, so pi-ai's own
  // "rate limit" exclusion misses it and its "too many tokens" fallback fires.
  const errorMessage =
    'litellm.RateLimitError: BedrockException - {"message":"Too many tokens, please wait before trying again."}';
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls === 1) return createErrorStream(errorMessage);
      return createSuccessStream("after throttle");
    },
    { maxAttempts: 2 },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 2);
  assert.equal((await wrapped.result()).stopReason, "stop");
});

test("withStreamRetry lets a user retry pattern win over the overflow guard", async () => {
  // pi-ai's "too many tokens" catch-all calls this an overflow; the user knows
  // their relay better and asked for it to be retried.
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls === 1) return createErrorStream("400 relay busy: too many tokens queued");
      return createSuccessStream("recovered");
    },
    { maxAttempts: 2, retryExtension: { patterns: ["relay busy"] } },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 2);
  assert.equal((await wrapped.result()).stopReason, "stop");
});

test("withStreamRetry never retries Anthropic's 'exceed context limit' overflow", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream(
        "input length and `max_tokens` exceed context limit: 195031 + 32000 > 200000",
      );
    },
    { maxAttempts: 5 },
  );
  await collectEvents(wrapped);
  assert.equal(calls, 1);
});

// ---- Transport watchdog (firstEventTimeoutMs / idleTimeoutMs) ----

/**
 * Mimics a pi-ai stream that goes silent: yields `events`, then waits for its
 * request signal to abort and ends with pi-ai's abort terminal. With
 * `terminalEvent: false` it ends iteration without a terminal and only exposes
 * the final message through result().
 */
function createSilentStream(signal, events, { partialText, terminalEvent = true } = {}) {
  const aborted = createAssistant(partialText, "aborted", { errorMessage: "Request was aborted" });
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
      await new Promise((resolve) => {
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      if (terminalEvent) yield { type: "error", reason: "aborted", error: aborted };
    },
    async result() {
      return aborted;
    },
  };
}

function startEvent() {
  return { type: "start", partial: createAssistant(undefined, "stop") };
}

function textDeltaEvent(text) {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: createAssistant(text, "stop"),
  };
}

/**
 * Tracks setTimeout handles created while active so a test can assert the
 * watchdog leaves no timer behind (a leaked one would keep node alive).
 */
function trackPendingTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Set();
  globalThis.setTimeout = (callback, ms, ...args) => {
    const handle = realSetTimeout(() => {
      pending.delete(handle);
      callback(...args);
    }, ms);
    pending.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    pending.delete(handle);
    realClearTimeout(handle);
  };
  return {
    pending,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test("withStreamRetry without timers hands the factory no attempt signal", async () => {
  const received = [];
  const controller = new AbortController();
  const wrapped = withStreamRetry(
    (...args) => {
      received.push(args);
      return createSuccessStream("ok");
    },
    // Non-positive values count as unset, too.
    { signal: controller.signal, firstEventTimeoutMs: 0, idleTimeoutMs: -1 },
  );
  await collectEvents(wrapped);
  // Called with no argument at all — exactly the pre-watchdog call shape.
  assert.deepEqual(received, [[]]);
});

test("withStreamRetry with a timer hands each attempt its own signal linked to the parent", async () => {
  const controller = new AbortController();
  let attemptSignal;
  const wrapped = withStreamRetry(
    (signal) => {
      attemptSignal = signal;
      return createSilentStream(signal, [startEvent()]);
    },
    { signal: controller.signal, firstEventTimeoutMs: 60_000 },
  );
  assert.ok(attemptSignal instanceof AbortSignal);
  assert.notEqual(attemptSignal, controller.signal);
  assert.equal(attemptSignal.aborted, false);
  controller.abort();
  assert.equal(attemptSignal.aborted, true);
  await collectEvents(wrapped);
});

test("withStreamRetry first-event timeout rewrites the uncommitted terminal and does not retry by default", async () => {
  let calls = 0;
  const signals = [];
  const retryCalls = [];
  const wrapped = withStreamRetry(
    (signal) => {
      calls += 1;
      signals.push(signal);
      return createSilentStream(signal, [startEvent()]);
    },
    { maxAttempts: 3, firstEventTimeoutMs: 20, onRetry: (...args) => retryCalls.push(args) },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 1);
  assert.deepEqual(retryCalls, []);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "error"],
  );
  assert.equal(events[1].reason, "error");
  assert.equal(events[1].error.stopReason, "error");
  assert.match(events[1].error.errorMessage, /^stream stalled: no content for 20ms/);
  const final = await wrapped.result();
  assert.equal(final.stopReason, "error");
  assert.equal(isStreamStallError(final), true);
  // Not a user stop: nothing upstream may read it as a cancellation.
  assert.doesNotMatch(final.errorMessage, /abort|cancel/i);
});

test("withStreamRetry retries a first-event stall only with retryOnStall", async () => {
  let calls = 0;
  const signals = [];
  const retryCalls = [];
  let recovered = 0;
  const wrapped = withStreamRetry(
    (signal) => {
      calls += 1;
      signals.push(signal);
      if (calls === 1) return createSilentStream(signal, [startEvent()]);
      return createSuccessStream("second try");
    },
    {
      maxAttempts: 3,
      firstEventTimeoutMs: 20,
      retryOnStall: true,
      onRetry: (attempt, maxAttempts, errorMessage) =>
        retryCalls.push([attempt, maxAttempts, errorMessage]),
      onRetryRecovered: () => {
        recovered += 1;
      },
    },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 2);
  // The stalled attempt's buffered events never reach the consumer.
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_delta", "done"],
  );
  assert.equal(retryCalls.length, 1);
  assert.deepEqual(retryCalls[0].slice(0, 2), [1, 2]);
  assert.match(retryCalls[0][2], /^stream stalled:/);
  assert.equal(recovered, 1);
  assert.equal((await wrapped.result()).stopReason, "stop");
  // The retry runs on a fresh attempt signal, not the stalled attempt's aborted one.
  assert.equal(signals[0].aborted, true);
  assert.notEqual(signals[1], signals[0]);
  assert.equal(signals[1].aborted, false);
});

test("withStreamRetry re-arms the idle timer on every event", async () => {
  const wrapped = withStreamRetry(
    (signal) => {
      const assistant = createAssistant("x".repeat(8), "stop");
      const aborted = createAssistant("x", "aborted", { errorMessage: "Request was aborted" });
      return {
        async *[Symbol.asyncIterator]() {
          yield startEvent();
          // Total silence-free span (~360ms) outlasts the idle timeout; only a
          // per-event re-arm keeps it alive. Each 30ms gap leaves a wide margin
          // against the 300ms timeout so a loaded test runner cannot stall it.
          for (let index = 0; index < 12; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            if (signal.aborted) {
              yield { type: "error", reason: "aborted", error: aborted };
              return;
            }
            yield textDeltaEvent("x");
          }
          yield { type: "done", message: assistant };
        },
        async result() {
          return assistant;
        },
      };
    },
    { idleTimeoutMs: 300 },
  );

  const events = await collectEvents(wrapped);
  assert.equal(events.at(-1).type, "done");
  assert.equal((await wrapped.result()).stopReason, "stop");
});

test("withStreamRetry does not reset the first-event timer on non-committing events", async () => {
  const wrapped = withStreamRetry(
    (signal) => {
      const aborted = createAssistant(undefined, "aborted", {
        errorMessage: "Request was aborted",
      });
      return {
        async *[Symbol.asyncIterator]() {
          // `start` keeps arriving every 10ms for 100ms, but nothing commits.
          for (let index = 0; index < 10 && !signal.aborted; index += 1) {
            yield startEvent();
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (signal.aborted) yield { type: "error", reason: "aborted", error: aborted };
        },
        async result() {
          return aborted;
        },
      };
    },
    { firstEventTimeoutMs: 40 },
  );

  const events = await collectEvents(wrapped);
  assert.equal(events.at(-1).type, "error");
  const final = await wrapped.result();
  assert.equal(isStreamStallError(final), true);
  assert.match(final.errorMessage, /^stream stalled: no content for 40ms/);
});

test("withStreamRetry clamps an oversized timeout instead of firing it at once", async () => {
  // setTimeout treats delays above 2^31-1 as ~1ms; a huge value meaning "no
  // limit" must not turn into an instant stall.
  const timers = trackPendingTimers();
  try {
    const controller = new AbortController();
    const wrapped = withStreamRetry(
      (signal) => {
        setTimeout(() => controller.abort(), 20);
        return createSilentStream(signal, [startEvent()]);
      },
      { signal: controller.signal, firstEventTimeoutMs: 2 ** 40 },
    );

    await collectEvents(wrapped);
    const final = await wrapped.result();
    assert.equal(final.stopReason, "aborted");
    assert.equal(isStreamStallError(final), false);
    assert.equal(timers.pending.size, 0);
  } finally {
    timers.restore();
  }
});

test("a stall's failover eligibility does not depend on the digits of its timeout", () => {
  // "500s" would match pi-ai's unanchored 5xx pattern, "300s" nothing at all.
  for (const timeoutMs of [300_000, 500_000, 502_000, 524_000]) {
    const seconds = timeoutMs / 1000;
    for (const errorMessage of [
      `stream stalled: no content for ${seconds}s after the request was sent`,
      `stream stalled: no events for ${seconds}s`,
    ]) {
      const message = createAssistant(undefined, "error", { errorMessage });
      assert.equal(isStreamStallError(message), true, errorMessage);
      assert.equal(isFailoverEligibleAssistantError(message), false, errorMessage);
    }
  }
});

test("withStreamRetry idle timeout after commit ends with a stall error in both the event and result()", async () => {
  const timers = trackPendingTimers();
  try {
    let calls = 0;
    const wrapped = withStreamRetry(
      (signal) => {
        calls += 1;
        return createSilentStream(signal, [startEvent(), textDeltaEvent("partial")], {
          partialText: "partial",
        });
      },
      // retryOnStall must not matter once content has been committed.
      { maxAttempts: 3, idleTimeoutMs: 20, retryOnStall: true },
    );

    const events = await collectEvents(wrapped);
    assert.equal(calls, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_delta", "error"],
    );
    const terminal = events[2];
    assert.equal(terminal.reason, "error");
    assert.equal(terminal.error.stopReason, "error");
    assert.match(terminal.error.errorMessage, /^stream stalled: no events for 20ms$/);
    const final = await wrapped.result();
    assert.equal(final.stopReason, "error");
    assert.equal(final.errorMessage, terminal.error.errorMessage);
    assert.equal(final.content[0].text, "partial");
    assert.equal(timers.pending.size, 0);
  } finally {
    timers.restore();
  }
});

test("withStreamRetry rewrites result() for a stalled stream that yields no terminal event", async () => {
  const wrapped = withStreamRetry(
    (signal) =>
      createSilentStream(signal, [startEvent(), textDeltaEvent("partial")], {
        partialText: "partial",
        terminalEvent: false,
      }),
    { idleTimeoutMs: 20 },
  );

  const events = await collectEvents(wrapped);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_delta"],
  );
  const final = await wrapped.result();
  assert.equal(final.stopReason, "error");
  assert.equal(isStreamStallError(final), true);
});

test("withStreamRetry keeps a parent abort as aborted with no stall rewrite and no leaked timer", async () => {
  const timers = trackPendingTimers();
  try {
    const controller = new AbortController();
    const retryCalls = [];
    const wrapped = withStreamRetry(
      (signal) => {
        setTimeout(() => controller.abort(), 10);
        return createSilentStream(signal, [startEvent(), textDeltaEvent("partial")], {
          partialText: "partial",
        });
      },
      {
        signal: controller.signal,
        firstEventTimeoutMs: 60_000,
        idleTimeoutMs: 60_000,
        retryOnStall: true,
        onRetry: (...args) => retryCalls.push(args),
      },
    );

    const events = await collectEvents(wrapped);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_delta", "error"],
    );
    assert.equal(events[2].reason, "aborted");
    const final = await wrapped.result();
    assert.equal(final.stopReason, "aborted");
    assert.equal(isStreamStallError(final), false);
    assert.deepEqual(retryCalls, []);
    // Both 60s watchdog timers were cleared when the attempt ended.
    assert.equal(timers.pending.size, 0);
  } finally {
    timers.restore();
  }
});

test("withStreamRetry keeps a parent abort that lands after a stall as aborted", async () => {
  const controller = new AbortController();
  const wrapped = withStreamRetry(
    (signal) => {
      const events = [startEvent()];
      const aborted = createAssistant(undefined, "aborted", { errorMessage: "Request was aborted" });
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          // The user stops before the stalled attempt's terminal is observed.
          controller.abort();
          yield { type: "error", reason: "aborted", error: aborted };
        },
        async result() {
          return aborted;
        },
      };
    },
    { signal: controller.signal, firstEventTimeoutMs: 20, retryOnStall: true },
  );

  const events = await collectEvents(wrapped);
  assert.equal(events.at(-1).reason, "aborted");
  assert.equal((await wrapped.result()).stopReason, "aborted");
});

test("withStreamRetry reports a cancelled retry through onRetry in watchdog mode too", async () => {
  // A source that ignores its signal and still fails retryably after the stop.
  // Same contract as without timers: the retry is recorded, then the backoff
  // sees the stop and the terminal is aborted.
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const retryCalls = [];
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createErrorStream("502 bad gateway");
    },
    {
      maxAttempts: 5,
      signal: controller.signal,
      idleTimeoutMs: 60_000,
      onRetry: (attempt, maxAttempts, errorMessage) =>
        retryCalls.push([attempt, maxAttempts, errorMessage]),
    },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 1);
  assert.deepEqual(retryCalls, [[1, 4, "502 bad gateway"]]);
  assert.equal(events.at(-1).reason, "aborted");
  assert.equal((await wrapped.result()).stopReason, "aborted");
});

test("withStreamRetry watchdog leaves a healthy stream untouched", async () => {
  const timers = trackPendingTimers();
  try {
    const wrapped = withStreamRetry(() => createSuccessStream("fine"), {
      firstEventTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    const events = await collectEvents(wrapped);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_delta", "done"],
    );
    assert.equal((await wrapped.result()).stopReason, "stop");
    assert.equal(timers.pending.size, 0);
  } finally {
    timers.restore();
  }
});
