// Review check (expected to pass): the reveal hands StreamingSplitMarkdown
// arbitrary character prefixes — cut inside fences, table rows, $$ blocks,
// inline math, list markers. Frozen segments are never re-derived, so every
// segment frozen from a prefix must still be a valid segment of the full text.
//
// Why it holds: advanceBoundary only takes a cut at "\n\n" at or before
// text.length - TAIL_KEEP_CHARS (2048), and its fence/math parity and
// next-line checks read only characters before cut + 8. A prefix and the full
// text agree on all of those, so the decision is prefix-independent.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const markdownCalls = [];
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/Markdown": {
      Markdown: (props) => {
        markdownCalls.push({ content: props.content, renderMode: props.renderMode });
        return null;
      },
    },
  },
});
const { React, act, createRoot } = env;
const { RoundBlockContent } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/RoundContent.tsx",
);
const { useStreamingReveal } = env.loadModule("@liveagent/ui/lib/chat/streamingReveal.ts");

function lastRender() {
  let end = markdownCalls.length - 1;
  while (end >= 0 && markdownCalls[end].renderMode !== "streaming") end -= 1;
  let start = end;
  while (start > 0 && markdownCalls[start - 1].renderMode === "static") start -= 1;
  const segments = markdownCalls.slice(start, end).map((call) => call.content);
  return { segments, shown: segments.join("") + markdownCalls[end].content };
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
    run(advance);
  } finally {
    performance.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

const UNIT = [
  "彩虹是阳光经过水滴折射与反射形成的光谱，**颜色顺序**固定为红橙黄绿蓝靛紫。\n\n",
  "```ts\nconst spectrum = [\"red\", \"orange\"];\n\nconsole.log(spectrum.length);\n```\n\n",
  "折射率满足 $n = c / v$，色散让不同波长分开 😀 [链接](https://example.com/a)。\n\n",
  "| 颜色 | 波长 nm |\n|---|---|\n| 红 | 700 |\n\n| 紫 | 400 |\n\n",
  "$$\n\\theta = 42^\\circ\n\n\\phi = 40^\\circ\n$$\n\n",
  "1. 第一步：太阳在观察者身后\n2. 第二步：前方有雨幕\n\n",
  "普通段落收尾，长度足够让切分器在这里找到安全边界。".repeat(4) + "\n\n",
];
const FULL = UNIT.join("").repeat(60); // ~30k chars, several freezes

function assertValidSegment(segment, index) {
  assert.equal((segment.split("```").length - 1) % 2, 0, `segment ${index}: unbalanced fence`);
  assert.equal((segment.split("$$").length - 1) % 2, 0, `segment ${index}: unbalanced $$`);
  if (index > 0) {
    assert.doesNotMatch(segment.slice(0, 8), /^(?:[-*+>=#|`$\s]|\d{1,3}[.)](?:\s|$))/, `segment ${index} opens on a non-paragraph line`);
  }
}

test("revealed prefixes freeze only segments that are valid for the full text", () => {
  markdownCalls.length = 0;
  withFrameClock((advance) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (text, revealText = true) =>
      act(() =>
        root.render(
          React.createElement(RoundBlockContent, {
            block: { kind: "text", text },
            isLive: revealText,
            revealText,
            renderMode: "streaming",
            runningToolCallIds: [],
            thinkingOpen: false,
          }),
        ),
      );

    // Store commits land in their own batch (no same-frame collision, which
    // is a separate finding); 37 chars per 16ms keeps a backlog so the cursor
    // stops at every possible offset, including mid-construct.
    let arrived = 1;
    render(FULL.slice(0, arrived));
    let frozenSeen = 0;
    while (arrived < FULL.length) {
      arrived = Math.min(FULL.length, arrived + 37);
      render(FULL.slice(0, arrived));
      advance(16);
      const { segments, shown } = lastRender();
      assert.ok(FULL.startsWith(shown), "what is drawn is always a prefix of the reply");
      for (let index = frozenSeen; index < segments.length; index += 1) {
        assertValidSegment(segments[index], index);
      }
      frozenSeen = segments.length;
    }
    for (let frame = 0; frame < 400 && lastRender().shown.length < FULL.length; frame += 1) {
      advance(16);
    }
    const revealedEnd = lastRender();
    assert.equal(revealedEnd.shown, FULL, "the reveal reaches the full text");
    assert.ok(revealedEnd.segments.length >= 2, `expected freezes, got ${revealedEnd.segments.length}`);
    revealedEnd.segments.forEach(assertValidSegment);

    render(FULL, false);
    assert.equal(lastRender().shown, FULL, "settled render is the full text");
    act(() => root.unmount());
  });
});

function Probe({ text, enabled }) {
  return React.createElement("p", null, useStreamingReveal(text, enabled));
}

test("StrictMode double render: no skipped or repeated characters", () => {
  withFrameClock((advance) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (text) =>
      act(() =>
        root.render(
          React.createElement(React.StrictMode, null, React.createElement(Probe, { text, enabled: true })),
        ),
      );
    render("ab");
    render("abcdefghij");
    const seen = [container.textContent];
    for (let frame = 0; frame < 60 && container.textContent.length < 10; frame += 1) {
      advance(16);
      seen.push(container.textContent);
    }
    assert.equal(container.textContent, "abcdefghij");
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index].startsWith(seen[index - 1]), `not monotonic: ${seen}`);
      assert.ok(seen[index].length - seen[index - 1].length <= 1, `skipped: ${seen}`);
    }
    act(() => root.unmount());
  });
});

test("enabled true→false→true mid-reveal, and rewrite+growth in one render, show full text", () => {
  withFrameClock((advance) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (text, enabled = true) =>
      act(() => root.render(React.createElement(Probe, { text, enabled })));
    render("abc");
    render("abcdefghijkl");
    advance(16);
    render("abcdefghijkl", false);
    assert.equal(container.textContent, "abcdefghijkl");
    render("abcdefghijkl", true);
    assert.equal(container.textContent, "abcdefghijkl", "re-enable does not replay");
    render("abcdefghijklmnop");
    for (let frame = 0; frame < 60 && container.textContent.length < 16; frame += 1) advance(16);
    assert.equal(container.textContent, "abcdefghijklmnop", "reveal resumes after re-enable");
    render("abcdefghijklmnopqr");
    advance(16);
    render("ABCDEFGHIJKLMNOPQRSTUV"); // reconciliation rewrite that is also longer
    assert.equal(container.textContent, "ABCDEFGHIJKLMNOPQRSTUV");
    act(() => root.unmount());
  });
});

test.after(() => env.cleanup());
