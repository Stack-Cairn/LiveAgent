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

function createErrorStreamWithHangingResult(errorMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "error", error: createAssistant(undefined, "error", { errorMessage }) };
      await new Promise(() => {});
    },
    async result() {
      return await new Promise(() => {});
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

function createNeverYieldingStream() {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
    async result() {
      return await new Promise(() => {});
    },
  };
}

function createCommittedIdleStream(text) {
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
      await new Promise(() => {});
    },
    async result() {
      return await new Promise(() => {});
    },
  };
}

function createNeverResolvingResultStream() {
  return {
    async *[Symbol.asyncIterator]() {
      return;
    },
    async result() {
      return await new Promise(() => {});
    },
  };
}

function createRejectingIteratorStream(errorMessage) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw new Error(errorMessage);
        },
        async return() {
          return { done: true };
        },
      };
    },
    async result() {
      throw new Error(errorMessage);
    },
  };
}

function createRejectingIteratorWithHangingResultStream(errorMessage) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw new Error(errorMessage);
        },
        async return() {
          return { done: true };
        },
      };
    },
    async result() {
      return await new Promise(() => {});
    },
  };
}

function createRejectingResultStream(errorMessage) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      throw new Error(errorMessage);
    },
  };
}

function createResultOnlyErrorStream(errorMessage) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return createAssistant(undefined, "error", { errorMessage });
    },
  };
}

function createBufferedEventStream(events) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          return index < events.length
            ? { value: events[index++], done: false }
            : { done: true };
        },
        async return() {
          return { done: true };
        },
      };
    },
    async result() {
      return createAssistant(undefined, "aborted");
    },
  };
}

async function collectEvents(eventStream) {
  const events = [];
  for await (const event of eventStream) events.push(event);
  return events;
}

async function resolveWithin(promise, timeoutMs = 250) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
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

test("withStreamRetry retries a provider iterator rejection before content commits", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return calls === 1 ? createRejectingIteratorStream("fetch failed") : createSuccessStream("recovered");
    },
    { maxAttempts: 3 },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "done"]);
  assert.equal((await wrapped.result()).content[0].text, "recovered");
});

test("withStreamRetry does not await result after an iterator rejection", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return calls === 1
        ? createRejectingIteratorWithHangingResultStream("network connection reset")
        : createSuccessStream("recovered");
    },
    { maxAttempts: 2, idleTimeoutMs: 5_000 },
  );

  const events = await resolveWithin(collectEvents(wrapped), 1_500);
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "done"]);
  assert.equal((await wrapped.result()).content[0].text, "recovered");
});

test("withStreamRetry retries an explicit terminal error without awaiting a hanging result", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return calls === 1
        ? createErrorStreamWithHangingResult("network connection reset")
        : createSuccessStream("recovered");
    },
    { maxAttempts: 2, idleTimeoutMs: 5_000 },
  );

  const events = await resolveWithin(collectEvents(wrapped), 1_500);
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "done"]);
  assert.equal((await wrapped.result()).content[0].text, "recovered");
});

test("withStreamRetry retries a synchronous provider construction failure", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      if (calls === 1) throw new Error("network unavailable");
      return createSuccessStream("recovered");
    },
    { maxAttempts: 3 },
  );

  await collectEvents(wrapped);
  assert.equal(calls, 2);
  assert.equal((await wrapped.result()).content[0].text, "recovered");
});

test("withStreamRetry retries a provider result rejection before content commits", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return calls === 1 ? createRejectingResultStream("network timeout") : createSuccessStream("recovered");
    },
    { maxAttempts: 3 },
  );

  await collectEvents(wrapped);
  assert.equal(calls, 2);
  assert.equal((await wrapped.result()).content[0].text, "recovered");
});

test("withStreamRetry retries a result-only provider error before content commits", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return calls === 1
        ? createResultOnlyErrorStream("503 service unavailable")
        : createSuccessStream("recovered");
    },
    { maxAttempts: 3 },
  );

  const events = await collectEvents(wrapped);
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "done"]);
  assert.equal((await wrapped.result()).content[0].text, "recovered");
});

test("withStreamRetry retries an uncommitted idle provider stream", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return calls === 1 ? createNeverYieldingStream() : createSuccessStream("recovered");
    },
    { maxAttempts: 2, idleTimeoutMs: 5 },
  );

  await collectEvents(wrapped);
  assert.equal(calls, 2);
  assert.equal((await wrapped.result()).content[0].text, "recovered");
});

test("withStreamRetry drops buffered ordinary events after an already-aborted stop", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const assistant = createAssistant("late", "stop");
  const wrapped = withStreamRetry(
    () =>
      createBufferedEventStream([
        { type: "text_delta", contentIndex: 0, delta: "late", partial: assistant },
        { type: "done", message: assistant },
      ]),
    { signal: controller.signal },
  );

  const events = await collectEvents(wrapped);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  assert.equal(events[0].reason, "aborted");
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

test("withStreamRetry ends a committed stream that becomes idle without retrying it", async () => {
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createCommittedIdleStream("partial");
    },
    { maxAttempts: 2, idleTimeoutMs: 5 },
  );

  const events = await resolveWithin(collectEvents(wrapped), 1_500);
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "error"]);
  const final = await wrapped.result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage, /idle timeout/i);
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

test("withStreamRetry aborts a provider iterator that never yields", async () => {
  const controller = new AbortController();
  let calls = 0;
  const wrapped = withStreamRetry(
    () => {
      calls += 1;
      return createNeverYieldingStream();
    },
    { signal: controller.signal },
  );
  const eventsPromise = collectEvents(wrapped);

  controller.abort(new Error("cancelled by user"));

  const events = await resolveWithin(eventsPromise);
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  assert.equal(events[0].reason, "aborted");
  assert.equal((await resolveWithin(wrapped.result())).stopReason, "aborted");
});

test("withStreamRetry aborts a provider result that never resolves", async () => {
  const controller = new AbortController();
  const wrapped = withStreamRetry(() => createNeverResolvingResultStream(), {
    signal: controller.signal,
  });
  const eventsPromise = collectEvents(wrapped);

  // Let the eager pump reach source.result() before simulating Stop.
  await Promise.resolve();
  controller.abort(new Error("cancelled by user"));

  const events = await resolveWithin(eventsPromise);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  assert.equal(events[0].reason, "aborted");
  assert.equal((await resolveWithin(wrapped.result())).stopReason, "aborted");
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
