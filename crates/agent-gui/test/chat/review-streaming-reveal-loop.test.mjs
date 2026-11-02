// Review round 2 (a1a8b7ef0): the reveal loop now lives in the ref
// (`frame`/`last`) and an every-commit effect starts it when the cursor is
// behind and no frame is pending. These pin its lifecycle edges.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { useStreamingReveal } = env.loadModule("@liveagent/ui/lib/chat/streamingReveal.ts");

function Probe({ text, enabled = true }) {
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
  // Time passes with no frames at all (hidden tab: rAF callbacks are held).
  const skip = (ms) => {
    clock += ms;
  };
  try {
    run({ advance, skip, pending: () => frames.size });
  } finally {
    performance.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

function mount(wrapStrict = false) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (text, enabled = true) => {
    const probe = React.createElement(Probe, { text, enabled });
    act(() => root.render(wrapStrict ? React.createElement(React.StrictMode, null, probe) : probe));
  };
  return { container, root, render };
}

function assertTypedOut(seen) {
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index].startsWith(seen[index - 1]), `not a growing prefix: ${JSON.stringify(seen)}`);
    assert.ok(seen[index].length - seen[index - 1].length <= 1, `jumped: ${JSON.stringify(seen)}`);
  }
}

test("StrictMode: never two loops, and the loop survives the mount-time effect replay", () => {
  withFrameClock(({ advance, pending }) => {
    const { container, root, render } = mount(true);
    render("ab");
    render("abcdefghij");
    assert.equal(pending(), 1, "exactly one frame queued after the first growth");
    const seen = [container.textContent];
    for (let frame = 0; frame < 60 && container.textContent.length < 20; frame += 1) {
      if (frame === 3) render("abcdefghijklmnopqrst"); // re-render mid-loop
      advance(16);
      assert.ok(pending() <= 1, `parallel loops: ${pending()} frames queued`);
      seen.push(container.textContent);
    }
    assert.equal(container.textContent, "abcdefghijklmnopqrst");
    assertTypedOut(seen);
    act(() => root.unmount());
    assert.equal(pending(), 0, "unmount cancels the pending frame");
  });
});

test("disable → enable and rewrite: the retired tick never advances the new state", () => {
  withFrameClock(({ advance, pending }) => {
    const { container, root, render } = mount();
    render("abc");
    render("abcdefghijkl");
    advance(16);
    // Disable mid-reveal: the old frame stays queued but is stale.
    render("abcdefghijkl", false);
    render("abcdefghijkl", true);
    render("abcdefghijklMNOP");
    assert.equal(container.textContent, "abcdefghijkl");
    // Old stale frame + the new loop's frame.
    assert.ok(pending() <= 2, `${pending()} frames queued`);
    const seen = [container.textContent];
    // One 16ms frame at the minimum pace moves < 1 char: if the stale tick
    // advanced the new state too, the cursor would move twice as fast.
    advance(16);
    seen.push(container.textContent);
    assert.ok(pending() <= 1, "the stale tick does not reschedule itself");
    for (let frame = 0; frame < 60 && container.textContent.length < 16; frame += 1) {
      advance(16);
      seen.push(container.textContent);
    }
    assert.equal(container.textContent, "abcdefghijklMNOP");
    assertTypedOut(seen);

    // Rewrite mid-reveal, then grow: reveal restarts from the rewritten text.
    render("abcdefghijklMNOPqrstuvwx");
    advance(16);
    render("REWRITTEN-REPLY");
    assert.equal(container.textContent, "REWRITTEN-REPLY");
    render("REWRITTEN-REPLY-more");
    assert.equal(container.textContent, "REWRITTEN-REPLY");
    for (let frame = 0; frame < 60 && container.textContent.length < 20; frame += 1) advance(16);
    assert.equal(container.textContent, "REWRITTEN-REPLY-more");
    assert.equal(pending(), 0);
    act(() => root.unmount());
  });
});

test("hidden tab: no frames for 5 s, then a capped, proportional catch-up", () => {
  withFrameClock(({ advance, skip, pending }) => {
    const { container, root, render } = mount();
    let text = "起";
    render(text);
    text += "x".repeat(10);
    render(text);
    advance(16);
    // Hidden: the store keeps committing (desktop falls back to setTimeout)
    // while rAF callbacks are held.
    for (let index = 0; index < 50; index += 1) {
      skip(100);
      text += "光".repeat(10);
      render(text);
    }
    const before = container.textContent.length;
    assert.ok(before < 15, "nothing typed while hidden");
    assert.equal(pending(), 1, "still one held frame, not one per commit");
    advance(16); // first visible frame: elapsed 5 s, capped at 250ms
    const firstStep = container.textContent.length - before;
    assert.ok(firstStep < text.length - before, `dumped the whole backlog in one frame (${firstStep})`);
    let frames = 1;
    while (container.textContent.length < text.length && frames < 200) {
      advance(16);
      frames += 1;
    }
    assert.equal(container.textContent, text);
    assert.ok(frames * 16 <= 1_500, `catch-up took ${frames * 16}ms`);
    act(() => root.unmount());
  });
});

test("no requestAnimationFrame: arrived text must still be shown", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = undefined;
  try {
    const { container, root, render } = mount();
    render("ab");
    render("abcdef");
    // The hook's own guard skips the loop without rAF, but the render still
    // returns the cursor's prefix, so the new text is never drawn.
    assert.equal(container.textContent, "abcdef");
    act(() => root.unmount());
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
  }
});

test.after(() => env.cleanup());
