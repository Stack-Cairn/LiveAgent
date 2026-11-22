import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveStreamingRenderDelay } = loader.loadModule(
  "@liveagent/ui/lib/chat/streamingRenderPolicy.ts",
);
const { scheduleLiveTranscriptFlush } = loader.loadModule(
  "src/pages/chat/hooks/useLiveTranscriptController.ts",
);

test("streaming render cadence stays immediate for short replies and scales gradually", () => {
  assert.equal(resolveStreamingRenderDelay(0), 0);
  assert.equal(resolveStreamingRenderDelay(11_999), 0);
  assert.equal(resolveStreamingRenderDelay(12_000), 32);
  assert.equal(resolveStreamingRenderDelay(47_999), 32);
  assert.equal(resolveStreamingRenderDelay(48_000), 64);
  assert.equal(resolveStreamingRenderDelay(159_999), 64);
  assert.equal(resolveStreamingRenderDelay(160_000), 96);
});

test("long-stream flush waits for its budget and then aligns the commit to a frame", () => {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  const frames = [];
  const clearedTimers = [];
  let calls = 0;

  try {
    globalThis.document = { visibilityState: "visible" };
    globalThis.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return 41;
    };
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setTimeout = (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    };
    globalThis.clearTimeout = (timerId) => clearedTimers.push(timerId);

    scheduleLiveTranscriptFlush(() => {
      calls += 1;
    }, 64);

    assert.deepEqual(
      timers.map((timer) => timer.delay),
      [64],
      "the expensive transcript must not commit on the next frame",
    );
    assert.equal(frames.length, 0);

    timers[0].callback();
    assert.equal(frames.length, 1);
    assert.deepEqual(timers.map((timer) => timer.delay), [64, 96]);

    frames[0]();
    assert.equal(calls, 1);
    assert.ok(clearedTimers.includes(2), "the rAF commit cancels its fallback timer");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("a flush whose frame is late runs from the fallback timer and cancels the frame on the window", () => {
  // WebKitGTK under a virtual display can deliver frames later than the
  // fallback timer. The fallback then cancels the queued frame, and WebKit
  // rejects cancelAnimationFrame unless it is called on the window.
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  const cancelledFrames = [];
  let calls = 0;
  const assertWindowReceiver = (receiver, name) => {
    if (receiver !== undefined && receiver !== globalThis) {
      throw new TypeError(`Can only call Window.${name} on instances of Window`);
    }
  };

  try {
    globalThis.document = { visibilityState: "visible" };
    globalThis.requestAnimationFrame = function requestAnimationFrame() {
      assertWindowReceiver(this, "requestAnimationFrame");
      return 77;
    };
    globalThis.cancelAnimationFrame = function cancelAnimationFrame(id) {
      assertWindowReceiver(this, "cancelAnimationFrame");
      cancelledFrames.push(id);
    };
    globalThis.setTimeout = (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    };
    globalThis.clearTimeout = () => {};

    scheduleLiveTranscriptFlush(() => {
      calls += 1;
    });
    const fallback = timers.find((timer) => timer.delay === 96);
    assert.ok(fallback, "a fallback timer backs up the frame");

    fallback.callback();
    assert.equal(calls, 1);
    assert.deepEqual(cancelledFrames, [77], "the late frame is cancelled");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
