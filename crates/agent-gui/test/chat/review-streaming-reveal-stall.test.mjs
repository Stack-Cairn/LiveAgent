// Review regression: the reveal loop dies when new text lands in the same frame
// the cursor catches up, and the reply stops typing until the turn settles.
//
// Both live stores flush on requestAnimationFrame (WebUI transcriptStore
// `requestAnimationFrame(commit)`, desktop scheduleLiveTranscriptFlush), so the
// reveal's own rAF tick and a store flush routinely run in the same frame. The
// tick writes the caught-up cursor into the ref and stops rescheduling; the
// flush then renders a longer text before the tick's rerender commits. That
// render reads `behind === true` again, the effect deps `[active, behind]` are
// unchanged from the last commit (also `true`), so no new loop starts.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

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
  // One browser frame: every queued rAF callback runs in registration order,
  // and React commits once afterwards (act batches like the real frame does).
  const advance = (ms) => {
    clock += ms;
    const due = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of due) callback(clock);
    });
  };
  try {
    run({ advance, requestFrame: (cb) => globalThis.requestAnimationFrame(cb), pending: () => frames.size });
  } finally {
    performance.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

test("a store flush in the frame where the cursor catches up must not stall the reveal", () => {
  withFrameClock(({ advance, requestFrame, pending }) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (text) => root.render(React.createElement(Probe, { text, enabled: true }));

    act(() => render("彩虹是"));
    act(() => render("彩虹是阳光"));
    assert.equal(container.textContent, "彩虹是");

    // Walk the cursor until the next frame would finish the backlog.
    for (let index = 0; index < 200 && container.textContent.length < 4; index += 1) {
      advance(16);
    }
    assert.equal(container.textContent, "彩虹是阳", "one character left to type");
    assert.equal(pending(), 1, "the reveal loop is still scheduled");

    // Next frame: the reveal tick (queued first) types the last character and
    // stops; the store flush (queued after it, same frame) appends a delta.
    // 0.64 chars/frame at the minimum pace, so give it a frame long enough to
    // finish: 250ms is the hook's own per-frame cap and certainly covers 1 char.
    requestFrame(() => render("彩虹是阳光经过水滴折射"));
    advance(250);

    // From here on nothing else arrives; the cursor has 6 characters to type.
    for (let index = 0; index < 200 && container.textContent.length < 11; index += 1) {
      advance(16);
    }
    assert.equal(
      container.textContent,
      "彩虹是阳光经过水滴折射",
      `reveal stalled at "${container.textContent}" with ${pending()} frame(s) queued`,
    );

    act(() => root.unmount());
  });
});

// A steady 2-character token every 4 frames (~31 chars/s, a CJK reply at
// ~20 tokens/s) for 480 frames, then 2 s of silence. Fixed schedule, no
// randomness. Below the 40 chars/s minimum pace the cursor catches up on the
// very frame each token is flushed, so the collision happens on the first one.
const GAPS = [4];

function streamWithPauses({ advance, requestFrame }, render, deliver) {
  let text = "Hello";
  act(() => render(text));
  let gapIndex = 0;
  let nextDeltaFrame = 0;
  let shownWhenStreamEnded = 0;
  const container = render.container;
  for (let frame = 0; frame < 600; frame += 1) {
    if (frame === nextDeltaFrame && frame < 480) {
      text += "ab";
      deliver(text);
      nextDeltaFrame = frame + GAPS[gapIndex++ % GAPS.length];
    }
    advance(16);
    if (frame === 479) shownWhenStreamEnded = container.textContent.length;
  }
  return { text, shown: container.textContent, shownWhenStreamEnded };
}

function mountProbe() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (text) => root.render(React.createElement(Probe, { text, enabled: true }));
  render.container = container;
  return { root, render };
}

test("steady 31 chars/s stream at 60fps: the reveal stalls and never resumes until the turn ends", () => {
  withFrameClock((clock) => {
    const { root, render } = mountProbe();
    // Store flush = rAF requested when the delta arrives between frames, i.e.
    // after the reveal's own next-frame request: same frame, tick first.
    const result = streamWithPauses(clock, render, (next) => clock.requestFrame(() => render(next)));
    // Two seconds of silence after the last token: a live reveal at >= 40
    // chars/s has long since caught up. The stalled one is still frozen.
    assert.equal(
      result.shown.length,
      result.text.length,
      `shown ${result.shown.length} of ${result.text.length} (was ${result.shownWhenStreamEnded} when the stream stopped)`,
    );
    act(() => root.unmount());
  });
});

test("control: the same stream committed outside the reveal's frame types out completely", () => {
  // Identical text sequence; only the commit timing differs (its own batch
  // before the frame). Passing here pins the failure above on the same-frame
  // collision, not on the harness.
  withFrameClock((clock) => {
    const { root, render } = mountProbe();
    const result = streamWithPauses(clock, render, (next) => act(() => render(next)));
    assert.equal(result.shown, result.text);
    act(() => root.unmount());
  });
});

test.after(() => env.cleanup());
