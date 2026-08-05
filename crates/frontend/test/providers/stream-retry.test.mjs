import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { withStreamRetry, computeStreamRetryBackoffMs, DEFAULT_STREAM_RETRY_MAX_ATTEMPTS } =
  loader.loadModule("src/lib/providers/runtime/streamRetry.ts");

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
  assert.equal(events[0].type, "error");
  assert.match(events[0].error.errorMessage, /503/);
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
