// Review round 2: does the reveal undo resolveStreamingRenderDelay?
//
// Both live stores slow their commits down as a reply grows (0 / 32 / 64 /
// 96 ms at 12k / 48k / 160k chars) because the live Markdown tail is
// re-parsed on every commit. StreamingSplitMarkdown bounds that tail to ~10k
// chars only when it finds a safe boundary; inside one long open code fence
// (a model writing a whole file) there is none, so the whole text is the tail.
// The reveal then hands that tail to Markdown on every frame a character
// becomes visible, regardless of the store's cadence.
//
// Measured through the real RoundBlockContent → StreamingSplitMarkdown path;
// only the leaf Markdown renderer is a recorder. Markdown is React.memo, so a
// "parse" here is a streaming-tail content change, not a call.
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
const { resolveStreamingRenderDelay } = env.loadModule(
  "@liveagent/ui/lib/chat/streamingRenderPolicy.ts",
);

const FRAME_MS = 16;
const ARRIVAL_CHARS_PER_SECOND = 120; // ~30-60 tokens/s of code
const WINDOW_MS = 3_000;

function codeFileOf(length) {
  const line = "  const value = compute(input, options); // keep going\n";
  return `下面是完整文件：\n\n\`\`\`ts\n${line.repeat(Math.ceil(length / line.length))}`.slice(0, length);
}

/**
 * Streams ARRIVAL_CHARS_PER_SECOND into a block that already holds `initial`
 * chars, committing at the store's own cadence for that size, and reports
 * what Markdown(renderMode="streaming") received per second.
 */
function measure(initial, revealText) {
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
  try {
    const full = codeFileOf(initial + ARRIVAL_CHARS_PER_SECOND * (WINDOW_MS / 1000) + 64);
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (length) =>
      act(() =>
        root.render(
          React.createElement(RoundBlockContent, {
            block: { kind: "text", text: full.slice(0, length) },
            isLive: true,
            revealText,
            renderMode: "streaming",
            runningToolCallIds: [],
            thinkingOpen: false,
          }),
        ),
      );
    let arrived = initial;
    render(arrived);
    markdownCalls.length = 0;
    let commits = 0;
    let sinceCommit = 0;
    let owed = 0;
    for (let elapsed = 0; elapsed < WINDOW_MS; elapsed += FRAME_MS) {
      owed += (ARRIVAL_CHARS_PER_SECOND * FRAME_MS) / 1000;
      sinceCommit += FRAME_MS;
      if (sinceCommit >= Math.max(FRAME_MS, resolveStreamingRenderDelay(arrived)) && owed >= 1) {
        arrived += Math.floor(owed);
        owed -= Math.floor(owed);
        sinceCommit = 0;
        commits += 1;
        render(arrived);
      }
      clock += FRAME_MS;
      const due = [...frames.values()];
      frames.clear();
      act(() => {
        for (const callback of due) callback(clock);
      });
    }
    // Markdown is React.memo: a render with an unchanged tail costs nothing, so
    // count only calls whose content differs from the previous tail.
    const streaming = [];
    let previousTail = null;
    for (const call of markdownCalls) {
      if (call.renderMode !== "streaming") continue;
      if (call.content !== previousTail) streaming.push(call.content.length);
      previousTail = call.content;
    }
    act(() => root.unmount());
    const seconds = WINDOW_MS / 1000;
    return {
      commitsPerSecond: commits / seconds,
      parsesPerSecond: streaming.length / seconds,
      charsPerSecond: streaming.reduce((sum, length) => sum + length, 0) / seconds,
    };
  } finally {
    performance.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

const TIERS = [
  { initial: 8_000, delay: 0 },
  { initial: 20_000, delay: 32 },
  { initial: 60_000, delay: 64 },
  { initial: 200_000, delay: 96 },
];

test("measure: Markdown re-parses per second, store cadence vs reveal, one long open code fence", (t) => {
  const rows = [];
  for (const { initial, delay } of TIERS) {
    assert.equal(resolveStreamingRenderDelay(initial), delay);
    const settled = measure(initial, false); // pre-change behaviour: one parse per commit
    const revealed = measure(initial, true);
    rows.push({ initial, delay, settled, revealed });
    t.diagnostic(
      `${initial} chars, store delay ${delay}ms: commits ${settled.commitsPerSecond.toFixed(1)}/s; ` +
        `parses ${settled.parsesPerSecond.toFixed(1)}/s → ${revealed.parsesPerSecond.toFixed(1)}/s ` +
        `(×${(revealed.parsesPerSecond / settled.parsesPerSecond).toFixed(1)}); ` +
        `chars parsed ${(settled.charsPerSecond / 1e6).toFixed(2)}M/s → ${(revealed.charsPerSecond / 1e6).toFixed(2)}M/s`,
    );
  }
  measured = rows;
});

let measured = [];

test("the reveal must not re-parse a long unsplittable tail more often than the store's throttle allows", () => {
  for (const { initial, delay, settled, revealed } of measured) {
    if (delay === 0) continue; // short replies: per-frame updates are the policy
    assert.ok(
      revealed.parsesPerSecond <= settled.parsesPerSecond * 1.25,
      `${initial} chars (store delay ${delay}ms): ${revealed.parsesPerSecond.toFixed(1)} parses/s with the reveal vs ` +
        `${settled.parsesPerSecond.toFixed(1)}/s at the store cadence, ` +
        `${(revealed.charsPerSecond / 1e6).toFixed(2)}M chars/s of Markdown`,
    );
  }
});

test.after(() => env.cleanup());
