import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const piAiEventStream = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
    import.meta.url,
  ).href
);

const loader = createTsModuleLoader();
const {
  failoverBreakerKey,
  isFailoverTargetAvailable,
  recordFailoverTargetResult,
  resetFailoverBreakers,
  isFailoverEligibleAssistantError,
  withProviderFailover,
} = loader.loadModule("src/lib/providers/runtime/providerFailover.ts");

const BREAKER_CONFIG = { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 };

function makeAssistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeErrorMessage(errorMessage) {
  return makeAssistantMessage({ stopReason: "error", errorMessage });
}

/** Builds a source stream that replays the given events. */
function makeSourceStream(events) {
  const stream = piAiEventStream.createAssistantMessageEventStream();
  for (const event of events) {
    stream.push(event);
  }
  return stream;
}

function successEvents(text = "hello") {
  const message = makeAssistantMessage({ content: [{ type: "text", text }] });
  return [
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "done", reason: "stop", message },
  ];
}

function uncommittedErrorEvents(errorMessage) {
  const message = makeErrorMessage(errorMessage);
  return [
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ];
}

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function makeCandidate(key, events, extra = {}) {
  return {
    key,
    label: key,
    model: { api: "anthropic-messages", provider: "anthropic", id: key },
    start: () => makeSourceStream(typeof events === "function" ? events() : events),
    ...extra,
  };
}

test.beforeEach(() => {
  resetFailoverBreakers();
});

/* ── circuit breaker ── */

test("breaker stays closed below the failure threshold", () => {
  const key = failoverBreakerKey("provider-a", "model-1");
  recordFailoverTargetResult(key, false, BREAKER_CONFIG, 1_000);
  recordFailoverTargetResult(key, false, BREAKER_CONFIG, 2_000);
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 3_000), true);
});

test("breaker opens at the threshold and half-opens after the cooldown", () => {
  const key = failoverBreakerKey("provider-a", "model-1");
  for (const at of [1_000, 2_000, 3_000]) {
    recordFailoverTargetResult(key, false, BREAKER_CONFIG, at);
  }
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 3_001), false);
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 3_000 + 59_000), false);
  // Cooldown elapsed → half-open probe allowed.
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 3_000 + 60_000), true);
});

test("a failed half-open probe re-opens the breaker from now", () => {
  const key = failoverBreakerKey("provider-a", "model-1");
  for (const at of [1_000, 2_000, 3_000]) {
    recordFailoverTargetResult(key, false, BREAKER_CONFIG, at);
  }
  // Probe at cooldown boundary fails → re-opens with a fresh cooldown window.
  recordFailoverTargetResult(key, false, BREAKER_CONFIG, 63_000);
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 64_000), false);
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 123_000), true);
});

test("success closes the breaker and clears failure counts", () => {
  const key = failoverBreakerKey("provider-a", "model-1");
  for (const at of [1_000, 2_000, 3_000]) {
    recordFailoverTargetResult(key, false, BREAKER_CONFIG, at);
  }
  recordFailoverTargetResult(key, true, BREAKER_CONFIG, 63_000);
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 63_001), true);
  // A single new failure must not immediately re-open.
  recordFailoverTargetResult(key, false, BREAKER_CONFIG, 64_000);
  assert.equal(isFailoverTargetAvailable(key, BREAKER_CONFIG, 64_001), true);
});

/* ── error eligibility ── */

test("transient provider errors are failover-eligible", () => {
  assert.equal(isFailoverEligibleAssistantError(makeErrorMessage("503 Service Unavailable")), true);
  assert.equal(isFailoverEligibleAssistantError(makeErrorMessage("connection refused")), true);
  assert.equal(isFailoverEligibleAssistantError(makeErrorMessage("Request timed out")), true);
});

test("quota and auth errors fail over even though same-provider retry would not", () => {
  assert.equal(
    isFailoverEligibleAssistantError(makeErrorMessage("insufficient_quota: billing hard limit")),
    true,
  );
  assert.equal(isFailoverEligibleAssistantError(makeErrorMessage("401 Unauthorized")), true);
  assert.equal(isFailoverEligibleAssistantError(makeErrorMessage("invalid api key provided")), true);
});

test("client-request-class errors never fail over", () => {
  assert.equal(isFailoverEligibleAssistantError(makeErrorMessage("prompt is too long")), false);
  assert.equal(
    isFailoverEligibleAssistantError(
      makeErrorMessage("400 input length and max_tokens exceed context length"),
    ),
    false,
  );
  assert.equal(isFailoverEligibleAssistantError(makeErrorMessage("400 invalid request")), false);
  assert.equal(isFailoverEligibleAssistantError(undefined), false);
});

/* ── withProviderFailover ── */

test("primary success passes events through without failover", async () => {
  const switches = [];
  const stream = withProviderFailover(
    [makeCandidate("primary", successEvents("primary-answer"))],
    {
      config: BREAKER_CONFIG,
      onFailover: (event) => switches.push(event),
    },
  );
  const events = await collectEvents(stream);
  assert.equal(switches.length, 0);
  assert.equal(events.some((event) => event.type === "text_delta"), true);
  const result = await stream.result();
  assert.equal(result.content[0].text, "primary-answer");
});

test("uncommitted eligible failure switches to the next candidate", async () => {
  const switches = [];
  const committed = [];
  const stream = withProviderFailover(
    [
      makeCandidate("primary", uncommittedErrorEvents("503 service unavailable")),
      makeCandidate("fallback-1", successEvents("fallback-answer")),
    ],
    {
      config: BREAKER_CONFIG,
      onFailover: (event) => switches.push(event),
      onCommitted: (index) => committed.push(index),
    },
  );
  const events = await collectEvents(stream);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].toIndex, 1);
  assert.match(switches[0].errorMessage, /503/);
  assert.deepEqual(committed, [1]);
  // The failed attempt's events are fully discarded.
  assert.equal(events.some((event) => event.type === "error"), false);
  const result = await stream.result();
  assert.equal(result.content[0].text, "fallback-answer");
});

test("non-eligible errors surface immediately without switching", async () => {
  const switches = [];
  const stream = withProviderFailover(
    [
      makeCandidate("primary", uncommittedErrorEvents("prompt is too long: 250000 tokens")),
      makeCandidate("fallback-1", successEvents()),
    ],
    {
      config: BREAKER_CONFIG,
      onFailover: (event) => switches.push(event),
    },
  );
  const events = await collectEvents(stream);
  assert.equal(switches.length, 0);
  assert.equal(events.at(-1)?.type, "error");
  // Client-class failures must not poison the breaker.
  assert.equal(isFailoverTargetAvailable("primary", BREAKER_CONFIG), true);
});

test("errors after content committed do not switch providers", async () => {
  const message = makeErrorMessage("503 mid-stream failure");
  const stream = withProviderFailover(
    [
      makeCandidate("primary", [
        { type: "start", partial: message },
        { type: "text_delta", contentIndex: 0, delta: "partial answer", partial: message },
        { type: "error", reason: "error", error: message },
      ]),
      makeCandidate("fallback-1", successEvents()),
    ],
    { config: BREAKER_CONFIG },
  );
  const events = await collectEvents(stream);
  assert.equal(events.some((event) => event.type === "text_delta"), true);
  assert.equal(events.at(-1)?.type, "error");
});

test("maxSwitches caps how many candidates are attempted", async () => {
  let thirdStarted = false;
  const stream = withProviderFailover(
    [
      makeCandidate("primary", uncommittedErrorEvents("502 bad gateway")),
      makeCandidate("fallback-1", uncommittedErrorEvents("502 bad gateway")),
      makeCandidate("fallback-2", () => {
        thirdStarted = true;
        return successEvents();
      }),
    ],
    { config: { ...BREAKER_CONFIG, maxSwitches: 1 } },
  );
  const events = await collectEvents(stream);
  assert.equal(thirdStarted, false);
  assert.equal(events.at(-1)?.type, "error");
});

test("an open-breaker primary is skipped up front", async () => {
  for (const at of [1_000, 2_000, 3_000]) {
    recordFailoverTargetResult("primary", false, BREAKER_CONFIG, at);
  }
  const switches = [];
  const stream = withProviderFailover(
    [
      makeCandidate("primary", successEvents("never used")),
      makeCandidate("fallback-1", successEvents("fallback-answer")),
    ],
    {
      config: BREAKER_CONFIG,
      now: () => 10_000, // well within the cooldown window
      onFailover: (event) => switches.push(event),
    },
  );
  const result = await stream.result();
  assert.equal(result.content[0].text, "fallback-answer");
  assert.equal(switches.length, 1);
  assert.equal(switches[0].errorMessage, "circuit breaker open");
});

test("an open-breaker primary skip consumes one unit of the switch budget", async () => {
  for (const at of [1_000, 2_000, 3_000]) {
    recordFailoverTargetResult("primary", false, BREAKER_CONFIG, at);
  }
  let secondFallbackStarted = false;
  const stream = withProviderFailover(
    [
      makeCandidate("primary", successEvents("never used")),
      makeCandidate("fallback-1", uncommittedErrorEvents("502 bad gateway")),
      makeCandidate("fallback-2", () => {
        secondFallbackStarted = true;
        return successEvents();
      }),
    ],
    { config: { ...BREAKER_CONFIG, maxSwitches: 1 }, now: () => 10_000 },
  );
  const events = await collectEvents(stream);
  // maxSwitches=1: skipping the open primary was the one allowed switch, so
  // fallback-1 is the only attempt and fallback-2 must stay untouched.
  assert.equal(secondFallbackStarted, false);
  assert.equal(events.at(-1)?.type, "error");
});

test("switch budget left after the initial skip still reaches later fallbacks", async () => {
  for (const at of [1_000, 2_000, 3_000]) {
    recordFailoverTargetResult("primary", false, BREAKER_CONFIG, at);
  }
  const stream = withProviderFailover(
    [
      makeCandidate("primary", successEvents("never used")),
      makeCandidate("fallback-1", uncommittedErrorEvents("502 bad gateway")),
      makeCandidate("fallback-2", successEvents("second-fallback-answer")),
    ],
    { config: { ...BREAKER_CONFIG, maxSwitches: 2 }, now: () => 10_000 },
  );
  const result = await stream.result();
  assert.equal(result.content[0].text, "second-fallback-answer");
});

test("all breakers open fails open on the primary", async () => {
  for (const key of ["primary", "fallback-1"]) {
    for (const at of [1_000, 2_000, 3_000]) {
      recordFailoverTargetResult(key, false, BREAKER_CONFIG, at);
    }
  }
  const stream = withProviderFailover(
    [
      makeCandidate("primary", successEvents("primary-recovered")),
      makeCandidate("fallback-1", successEvents("unused")),
    ],
    { config: BREAKER_CONFIG, now: () => 10_000 },
  );
  const result = await stream.result();
  assert.equal(result.content[0].text, "primary-recovered");
});

test("start() rejection counts as a failure and moves on", async () => {
  const stream = withProviderFailover(
    [
      {
        key: "primary",
        label: "primary",
        model: { api: "anthropic-messages", provider: "anthropic", id: "primary" },
        start: () => Promise.reject(new Error("proxy setup failed")),
      },
      makeCandidate("fallback-1", successEvents("fallback-answer")),
    ],
    { config: BREAKER_CONFIG },
  );
  const result = await stream.result();
  assert.equal(result.content[0].text, "fallback-answer");
});

test("start() rejection on the last candidate surfaces a synthetic error event", async () => {
  const stream = withProviderFailover(
    [
      {
        key: "primary",
        label: "primary",
        model: { api: "anthropic-messages", provider: "anthropic", id: "primary" },
        start: () => Promise.reject(new Error("proxy setup failed")),
      },
    ],
    { config: BREAKER_CONFIG },
  );
  const events = await collectEvents(stream);
  assert.equal(events.at(-1)?.type, "error");
  assert.match(events.at(-1)?.error?.errorMessage ?? "", /proxy setup failed/);
});

test("successful runs record breaker success for the winning candidate", async () => {
  recordFailoverTargetResult("fallback-1", false, BREAKER_CONFIG, 1_000);
  recordFailoverTargetResult("fallback-1", false, BREAKER_CONFIG, 2_000);
  const stream = withProviderFailover(
    [
      makeCandidate("primary", uncommittedErrorEvents("429 too many requests")),
      makeCandidate("fallback-1", successEvents()),
    ],
    { config: BREAKER_CONFIG },
  );
  await stream.result();
  // Two prior failures + this success → counter reset, so two more failures
  // still stay below the threshold.
  recordFailoverTargetResult("fallback-1", false, BREAKER_CONFIG, 5_000);
  recordFailoverTargetResult("fallback-1", false, BREAKER_CONFIG, 6_000);
  assert.equal(isFailoverTargetAvailable("fallback-1", BREAKER_CONFIG, 7_000), true);
});
