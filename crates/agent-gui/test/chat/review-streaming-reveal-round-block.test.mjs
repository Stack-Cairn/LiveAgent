// Review regressions through the real composition: RoundBlockContent →
// RevealedStreamingMarkdown → useStreamingReveal → StreamingSplitMarkdown →
// streamingSplit. Only the leaf Markdown renderer is replaced by a recorder,
// so what reaches the screen is exactly what the recorder receives.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Every render of StreamingSplitMarkdown calls Markdown for each frozen
// segment (static) and then once for the live tail (streaming); the tail
// call closes one render.
const markdownCalls = [];
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/Markdown": {
      Markdown: (props) => {
        markdownCalls.push({ content: props.content, renderMode: props.renderMode });
        return null;
      },
    },
    // Icons are irrelevant here; the default loader mocks lucide with plain
    // objects that react-dom cannot render.
    "../../IconSet": new Proxy({}, { get: () => () => null, has: () => true }),
  },
});
const { React, act, createRoot } = env;
const { RoundBlockContent } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/RoundContent.tsx",
);

/** What the last render of the text block drew: frozen segments + live tail. */
function lastRender() {
  let end = markdownCalls.length - 1;
  while (end >= 0 && markdownCalls[end].renderMode !== "streaming") end -= 1;
  assert.ok(end >= 0, "no streaming render recorded");
  let start = end;
  while (start > 0 && markdownCalls[start - 1].renderMode === "static") start -= 1;
  const segments = markdownCalls.slice(start, end).map((call) => call.content);
  return { segments, tail: markdownCalls[end].content, shown: segments.join("") + markdownCalls[end].content };
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
    run({ advance, requestFrame: (cb) => globalThis.requestAnimationFrame(cb) });
  } finally {
    performance.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

function mountBlock() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (text, revealText = true) =>
    root.render(
      React.createElement(RoundBlockContent, {
        block: { kind: "text", text },
        isLive: revealText,
        revealText,
        renderMode: "streaming",
        runningToolCallIds: [],
        thinkingOpen: false,
      }),
    );
  return { root, render };
}

test("desktop/WebUI text block: a reply stops typing for the rest of the turn after a same-frame flush", () => {
  markdownCalls.length = 0;
  withFrameClock(({ advance, requestFrame }) => {
    const { root, render } = mountBlock();
    let text = "彩虹";
    act(() => render(text));
    // ~31 chars/s CJK stream: two characters per 4 frames, each committed by
    // the store's rAF flush (requested after the reveal's next-frame request).
    for (let frame = 0; frame < 480; frame += 1) {
      if (frame % 4 === 0) {
        text += "是光";
        const next = text;
        requestFrame(() => render(next));
      }
      advance(16);
    }
    for (let frame = 0; frame < 120; frame += 1) advance(16);
    const { shown } = lastRender();
    assert.equal(
      shown.length,
      text.length,
      `the block shows ${shown.length} of ${text.length} characters 2 s after the last token`,
    );
    act(() => root.unmount());
  });
});

test("verified: revealText true→false (turn settles, row.live=false twin) draws the whole block at once", () => {
  markdownCalls.length = 0;
  withFrameClock(({ advance }) => {
    const { root, render } = mountBlock();
    act(() => render("abc"));
    act(() => render("abcdefghijklmnopqrstuvwxyz"));
    advance(16);
    assert.ok(lastRender().shown.length < 26, "still revealing");
    // Same block object identity is not required: memo sees revealText change.
    act(() => render("abcdefghijklmnopqrstuvwxyz", false));
    assert.equal(lastRender().shown, "abcdefghijklmnopqrstuvwxyz");
    act(() => root.unmount());
  });
});

test("verified: even a stalled reveal is completed when the turn settles", () => {
  markdownCalls.length = 0;
  withFrameClock(({ advance, requestFrame }) => {
    const { root, render } = mountBlock();
    act(() => render("ab"));
    act(() => render("abc"));
    requestFrame(() => render("abcdefgh"));
    advance(250);
    for (let frame = 0; frame < 60; frame += 1) advance(16);
    act(() => render("abcdefgh", false));
    assert.equal(lastRender().shown, "abcdefgh");
    act(() => root.unmount());
  });
});

test("thinking area: the same hook stalls the streaming reasoning text", () => {
  markdownCalls.length = 0;
  withFrameClock(({ advance, requestFrame }) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    // Through RoundBlockContent's thinking branch → real ThinkingDisclosure.
    const render = (text) =>
      root.render(
        React.createElement(RoundBlockContent, {
          block: { kind: "thinking", key: "review-thinking", text },
          isLive: true,
          thinkingOpen: true,
          isLatestThinking: true,
          traceKey: "review-thinking",
          renderMode: "streaming",
          runningToolCallIds: [],
        }),
      );
    let text = "先看";
    act(() => render(text));
    for (let frame = 0; frame < 480; frame += 1) {
      if (frame % 4 === 0) {
        text += "折射";
        const next = text;
        requestFrame(() => render(next));
      }
      advance(16);
    }
    for (let frame = 0; frame < 120; frame += 1) advance(16);
    const shown = markdownCalls.at(-1)?.content ?? "";
    assert.equal(shown, text, `reasoning shows ${shown.length} of ${text.length} characters`);
    act(() => root.unmount());
  });
});

test.after(() => env.cleanup());
