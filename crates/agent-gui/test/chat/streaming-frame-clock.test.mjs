// Shared streaming frame clock and the streaming Markdown block frame: the two
// pieces that keep one streamed update to one React commit that re-parses
// only the growing last block.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    streamdown: { __esModule: true, Block: () => null, detectTextDirection: () => "ltr" },
  },
});
const { requestStreamingFrame, hasStreamingFrameClock } = loader.loadModule(
  "@liveagent/ui/lib/chat/streamingFrameClock.ts",
);
const { createStreamingBlockFrame, STREAMING_TAIL_PLACEHOLDER } = loader.loadModule(
  "@liveagent/ui/components/markdown/streamingTailBlock.tsx",
);

function withFakeFrames(run) {
  const previous = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  const frames = new Map();
  let nextId = 1;
  // Like the browser, reject a receiver other than the window (WebKit throws
  // "Can only call Window.cancelAnimationFrame on instances of Window").
  const assertWindowReceiver = (receiver, name) => {
    if (receiver !== undefined && receiver !== globalThis) {
      throw new TypeError(`Can only call Window.${name} on instances of Window`);
    }
  };
  globalThis.requestAnimationFrame = function requestAnimationFrame(callback) {
    assertWindowReceiver(this, "requestAnimationFrame");
    frames.set(nextId, callback);
    return nextId++;
  };
  globalThis.cancelAnimationFrame = function cancelAnimationFrame(id) {
    assertWindowReceiver(this, "cancelAnimationFrame");
    frames.delete(id);
  };
  const flush = (now = 16) => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  };
  try {
    run({ flush, pending: () => frames.size });
  } finally {
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = previous;
  }
}

test("callbacks queued for the same frame share one requestAnimationFrame", () => {
  withFakeFrames(({ flush, pending }) => {
    assert.equal(hasStreamingFrameClock(), true);
    const calls = [];
    requestStreamingFrame((now) => calls.push(["flush", now]));
    requestStreamingFrame((now) => calls.push(["reveal", now]));
    assert.equal(pending(), 1, "one browser frame for both callbacks");
    flush(42);
    assert.deepEqual(calls, [
      ["flush", 42],
      ["reveal", 42],
    ]);
    // A callback queued from inside a frame waits for the next one.
    requestStreamingFrame(() => requestStreamingFrame(() => calls.push(["next"])));
    flush();
    assert.equal(calls.length, 2);
    flush();
    assert.deepEqual(calls.at(-1), ["next"]);
  });
});

test("cancelling drops one callback and, when it was the last, the frame", () => {
  withFakeFrames(({ flush, pending }) => {
    const calls = [];
    const cancelFirst = requestStreamingFrame(() => calls.push("first"));
    const cancelSecond = requestStreamingFrame(() => calls.push("second"));
    cancelFirst();
    cancelFirst();
    assert.equal(pending(), 1);
    cancelSecond();
    assert.equal(pending(), 0, "no frame left without callbacks");
    requestStreamingFrame(() => calls.push("third"));
    flush();
    assert.deepEqual(calls, ["third"]);
  });
});

test("a throwing callback does not starve the rest of the frame", () => {
  const deferred = [];
  const previous = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (callback) => deferred.push(callback);
  try {
    withFakeFrames(({ flush }) => {
      const calls = [];
      requestStreamingFrame(() => {
        throw new Error("boom");
      });
      requestStreamingFrame(() => calls.push("after"));
      flush();
      assert.deepEqual(calls, ["after"]);
    });
  } finally {
    globalThis.queueMicrotask = previous;
  }
  assert.equal(deferred.length, 1);
  assert.throws(deferred[0], /boom/, "the error is rethrown, not swallowed");
});

test("a frame source replaced while a frame is pending gets the callbacks", () => {
  withFakeFrames(() => {
    const calls = [];
    requestStreamingFrame(() => calls.push("stale clock"));
  });
  withFakeFrames(({ flush, pending }) => {
    const calls = [];
    requestStreamingFrame(() => calls.push("fresh clock"));
    assert.equal(pending(), 1, "scheduled on the current frame source");
    flush();
    assert.ok(calls.includes("fresh clock"));
  });
});

test("the block frame changes Streamdown's input only when a block completes", () => {
  // Split on blank lines; the last block is the growing tail.
  const parse = (markdown) => markdown.split(/(?<=\n\n)/);
  const frame = createStreamingBlockFrame(parse);

  const first = frame.update("Hello");
  assert.deepEqual(first.blocks, ["Hello"]);
  assert.deepEqual(frame.parse(), [STREAMING_TAIL_PLACEHOLDER]);

  const grown = frame.update("Hello world");
  assert.equal(grown.key, first.key, "tail growth keeps Streamdown's children");
  assert.deepEqual(grown.blocks, ["Hello world"], "the context carries the new tail");

  const split = frame.update("Hello world\n\nNext");
  assert.notEqual(split.key, grown.key, "a completed block re-renders the list");
  assert.deepEqual(split.blocks, ["Hello world\n\n", "Next"]);
  assert.deepEqual(frame.parse(), ["Hello world\n\n", STREAMING_TAIL_PLACEHOLDER]);

  const again = frame.update("Hello world\n\nNext one");
  assert.equal(again.key, split.key);
  assert.deepEqual(again.blocks, ["Hello world\n\n", "Next one"]);

  // A rewrite of a completed block (final reconciliation) is a new list.
  const rewritten = frame.update("Hi world\n\nNext one");
  assert.notEqual(rewritten.key, again.key);
  assert.deepEqual(frame.parse(), ["Hi world\n\n", STREAMING_TAIL_PLACEHOLDER]);
});
