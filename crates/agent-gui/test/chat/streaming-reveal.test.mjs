import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const {
  STREAMING_REVEAL_MAX_LAG_MS,
  STREAMING_REVEAL_MIN_CHARS_PER_SECOND,
  isStreamingAppend,
  nextStreamingRevealPosition,
  streamingRevealCut,
} = createTsModuleLoader().loadModule("@liveagent/ui/lib/chat/streamingReveal.ts");

test("a small backlog is typed out at the minimum pace, one character after another", () => {
  // 16ms frame at the minimum pace moves well under one character.
  const step = nextStreamingRevealPosition(0, 5, 16);
  assert.ok(step > 0 && step < 1, `step ${step}`);
  // Five characters at the minimum pace take 5 / min-rate seconds.
  let position = 0;
  let frames = 0;
  while (position < 5) {
    position = nextStreamingRevealPosition(position, 5, 16);
    frames += 1;
  }
  const expectedFrames = Math.ceil((5 * 1000) / STREAMING_REVEAL_MIN_CHARS_PER_SECOND / 16);
  assert.ok(Math.abs(frames - expectedFrames) <= 1, `${frames} vs ${expectedFrames}`);
});

test("a large backlog speeds up so the cursor stays within the lag budget", () => {
  let position = 0;
  let elapsed = 0;
  while (position < 3_000 * 0.95) {
    position = nextStreamingRevealPosition(position, 3_000, 16);
    elapsed += 16;
  }
  // Proportional catch-up: 95% of any backlog is drained in about 3 lag windows.
  assert.ok(elapsed <= STREAMING_REVEAL_MAX_LAG_MS * 3.2, `took ${elapsed}ms`);
});

test("the cursor never passes the arrived text and ignores negative or huge frames", () => {
  assert.equal(nextStreamingRevealPosition(10, 10, 16), 10);
  assert.equal(nextStreamingRevealPosition(12, 10, 16), 10);
  assert.equal(nextStreamingRevealPosition(3, 10, -50), 3);
  // A late frame is clamped, so one stall cannot dump the whole backlog at once.
  assert.ok(nextStreamingRevealPosition(0, 100_000, 60_000) < 100_000);
});

test("cut points never split a surrogate pair", () => {
  const text = "ab😀cd";
  assert.equal(streamingRevealCut(text, 2), 2);
  // Position 3 lands between the emoji's two code units: include the whole emoji.
  assert.equal(streamingRevealCut(text, 3), 4);
  assert.equal(streamingRevealCut(text, 3.9), 4);
  assert.equal(streamingRevealCut(text, 99), text.length);
  assert.equal(streamingRevealCut(text, -1), 0);
});

test("append detection accepts growth and rejects rewrites and shrinks", () => {
  assert.equal(isStreamingAppend("", "abc"), true);
  assert.equal(isStreamingAppend("abc", "abcdef"), true);
  assert.equal(isStreamingAppend("abc", "abc"), true);
  assert.equal(isStreamingAppend("abcdef", "abc"), false);
  assert.equal(isStreamingAppend("abc", "abXdef"), false);
});

// --- the hook, rendered for real with a controlled frame clock ---

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { useStreamingReveal } = env.loadModule("@liveagent/ui/lib/chat/streamingReveal.ts");

function Probe({ text, enabled }) {
  return React.createElement("p", null, useStreamingReveal(text, enabled));
}

function withFrameClock(run) {
  const frames = new Map();
  let nextId = 1;
  let clock = 1_000;
  const originalNow = performance.now;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  performance.now = () => clock;
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const advance = (ms) => {
    clock += ms;
    const due = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of due) callback(clock);
    });
  };
  try {
    run(advance, () => frames.size);
  } finally {
    performance.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

test("text present at mount shows at once; text that arrives later is typed out", () => {
  withFrameClock((advance, pending) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (text, enabled = true) =>
      act(() => root.render(React.createElement(Probe, { text, enabled })));

    render("彩虹是");
    assert.equal(container.textContent, "彩虹是");
    assert.equal(pending(), 0, "nothing to reveal, no frame loop");

    render("彩虹是阳光经过水滴");
    assert.equal(container.textContent, "彩虹是", "new text waits for the cursor");

    const seen = [];
    for (let index = 0; index < 40 && container.textContent.length < 9; index += 1) {
      advance(16);
      seen.push(container.textContent.length);
    }
    assert.equal(container.textContent, "彩虹是阳光经过水滴");
    // Monotonic, one character at a time at this backlog.
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index] - seen[index - 1] <= 1, `jump at frame ${index}: ${seen}`);
      assert.ok(seen[index] >= seen[index - 1]);
    }
    assert.equal(pending(), 0, "the loop stops once caught up");

    act(() => root.unmount());
  });
});

test("disabling the reveal (turn settled) or rewriting the text shows the full text", () => {
  withFrameClock((advance) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (text, enabled = true) =>
      act(() => root.render(React.createElement(Probe, { text, enabled })));

    render("abc");
    render("abcdefghij");
    advance(16);
    assert.ok(container.textContent.length < 10);
    render("abcdefghij", false);
    assert.equal(container.textContent, "abcdefghij");

    render("abcdefghij", true);
    render("abcdefghijklmn");
    assert.equal(container.textContent, "abcdefghij");
    render("xyz rewritten");
    assert.equal(container.textContent, "xyz rewritten");

    act(() => root.unmount());
  });
});

test("reduced motion shows text as it arrives", () => {
  const originalMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({ matches: query.includes("reduce") });
  try {
    withFrameClock(() => {
      const container = document.createElement("div");
      const root = createRoot(container);
      act(() => root.render(React.createElement(Probe, { text: "ab", enabled: true })));
      act(() => root.render(React.createElement(Probe, { text: "abcdef", enabled: true })));
      assert.equal(container.textContent, "abcdef");
      act(() => root.unmount());
    });
  } finally {
    globalThis.matchMedia = originalMatchMedia;
  }
});

test.after(() => env.cleanup());
