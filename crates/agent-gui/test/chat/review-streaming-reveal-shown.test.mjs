// Review round 3 (c270ad980): renders draw `shownCut`, which only the loop
// moves — per frame for short texts, at most every resolveStreamingRenderDelay
// ms for long ones, and always on the frame the cursor catches up.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { useStreamingReveal } = env.loadModule("@liveagent/ui/lib/chat/streamingReveal.ts");

// Every drawn value, in commit order (one entry per render of the probe).
let drawn = [];
function Probe({ text, enabled = true }) {
  const shown = useStreamingReveal(text, enabled);
  drawn.push(shown);
  return React.createElement("p", null, shown.length);
}

function withFrameClock(frameMs, run) {
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
  const frame = () => {
    clock += frameMs;
    const due = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of due) callback(clock);
    });
  };
  try {
    run({ frame, now: () => clock, pending: () => frames.size });
  } finally {
    performance.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

function mount(strict = false) {
  const root = createRoot(document.createElement("div"));
  const render = (text, enabled = true) => {
    const probe = React.createElement(Probe, { text, enabled });
    act(() => root.render(strict ? React.createElement(React.StrictMode, null, probe) : probe));
  };
  return { root, render, last: () => drawn.at(-1) };
}

const LONG = "长".repeat(20_000); // resolveStreamingRenderDelay(20k) = 32ms

test("long text: the catch-up frame draws the tail even when the 32ms budget is not yet due", () => {
  drawn = [];
  // 100Hz frames: at 40 chars/s the 2nd char lands 20ms after the 1st was drawn.
  withFrameClock(10, ({ frame, pending }) => {
    const { root, render, last } = mount();
    render(LONG);
    render(`${LONG}ab`);
    assert.equal(last(), LONG);
    for (let index = 0; index < 20 && pending() > 0; index += 1) frame();
    assert.equal(pending(), 0, "loop stopped");
    assert.equal(last(), `${LONG}ab`, "the last characters are drawn");
    act(() => root.unmount());
  });
});

test("long text: draws are spaced by the store budget while behind, and store flushes redraw nothing new", () => {
  drawn = [];
  withFrameClock(16, ({ frame, now, pending }) => {
    const { root, render, last } = mount();
    render(LONG);
    let text = `${LONG}${"x".repeat(60)}`;
    render(text);
    const drawTimes = [];
    let previous = last();
    for (let index = 0; index < 400 && (pending() > 0 || last() !== text); index += 1) {
      if (index % 3 === 0 && index < 60) {
        // A store flush mid-reveal: same drawn prefix (Markdown memo skips it).
        const before = last();
        text += "y";
        render(text);
        assert.equal(last(), before, "a flush render must draw the same prefix");
      }
      frame();
      if (last() !== previous) {
        drawTimes.push({ at: now(), length: last().length, full: last() === text });
        previous = last();
      }
    }
    assert.equal(last(), text);
    for (let index = 1; index < drawTimes.length; index += 1) {
      const gap = drawTimes[index].at - drawTimes[index - 1].at;
      if (!drawTimes[index].full) assert.ok(gap >= 32, `draws ${gap}ms apart: ${JSON.stringify(drawTimes)}`);
    }
    act(() => root.unmount());
  });
});

test("short text (delay 0): still one character per draw, a draw for every character", () => {
  drawn = [];
  withFrameClock(16, ({ frame, pending }) => {
    const { root, render, last } = mount();
    render("彩虹");
    render("彩虹是阳光经过水滴折射");
    for (let index = 0; index < 100 && pending() > 0; index += 1) frame();
    assert.equal(last(), "彩虹是阳光经过水滴折射");
    const distinct = drawn.filter((value, index) => index === 0 || value !== drawn[index - 1]);
    const lengths = distinct.map((value) => value.length);
    // Mount "彩虹", then the prefix grows 2 → 11 one char at a time.
    assert.deepEqual(lengths, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    act(() => root.unmount());
  });
});

test("reset: disable or rewrite in the middle of a throttled reveal draws the full text", () => {
  drawn = [];
  withFrameClock(16, ({ frame, pending }) => {
    const { root, render, last } = mount();
    render(LONG);
    render(`${LONG}${"x".repeat(80)}`);
    frame();
    frame();
    frame();
    assert.ok(last().length < LONG.length + 80, "mid-reveal");
    render(`${LONG}${"x".repeat(80)}`, false);
    assert.equal(last(), `${LONG}${"x".repeat(80)}`, "disabled: full text");
    render(`${LONG}${"x".repeat(80)}`, true);
    assert.equal(last(), `${LONG}${"x".repeat(80)}`, "re-enabled: no replay");
    render(`${LONG}${"x".repeat(160)}`);
    frame();
    frame();
    const rewritten = `REWRITE${LONG}${"z".repeat(200)}`;
    render(rewritten);
    assert.equal(last(), rewritten, "rewrite: full text at once");
    for (let index = 0; index < 50 && pending() > 0; index += 1) frame();
    assert.equal(last(), rewritten, "the retired loop does not redraw an old prefix");
    act(() => root.unmount());
  });
});

test("StrictMode on a long text: monotonic draws, no skipped tail, one loop", () => {
  drawn = [];
  withFrameClock(16, ({ frame, pending }) => {
    const { root, render, last } = mount(true);
    render(LONG);
    let text = `${LONG}${"x".repeat(40)}`;
    render(text);
    for (let index = 0; index < 300 && (pending() > 0 || last() !== text); index += 1) {
      if (index === 5) {
        text += "tail";
        render(text);
      }
      frame();
      assert.ok(pending() <= 1, `${pending()} frames queued`);
    }
    assert.equal(last(), text);
    for (let index = 1; index < drawn.length; index += 1) {
      assert.ok(drawn[index].length >= drawn[index - 1].length, "drawn prefix went backwards");
      assert.ok(text.startsWith(drawn[index]), "drawn value is not a prefix");
    }
    act(() => root.unmount());
  });
});

test.after(() => env.cleanup());
