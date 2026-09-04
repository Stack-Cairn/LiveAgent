import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const EmptyIcon = () => null;

// The duration store is mocked so the settled label is deterministic; the
// real module is unit-tested separately below.
const durationState = { settledMs: null };

// The follow engine is unit-tested in scroll-follow-core.test.mjs; here we
// only assert the disclosure hands it the right elements and gates.
const scrollFollowCalls = [];

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/Markdown": {
      Markdown: ({ content }) => content,
    },
    "@liveagent/ui/lib/chat/thinkingDurations": {
      resolveThinkingDurationMs: (_key, active) => (active ? null : durationState.settledMs),
    },
    "@liveagent/ui/lib/chat-scroll/useScrollFollow": {
      useScrollFollow: (args) => {
        scrollFollowCalls.push(args);
        return { handle: {}, following: true };
      },
    },
    "@liveagent/ui/i18n/index": {
      useLocale: () => ({
        locale: "zh-CN",
        t: (key) =>
          ({
            "chat.thinking": "思考中",
            "chat.thoughtFor": "思考了",
            "chat.thinkingProcess": "思考过程",
            "chat.work.running": "处理中",
            "chat.work.activity": "已处理",
          })[key] ?? key,
      }),
    },
    "@liveagent/ui/lib/shared/utils": {
      cn: (...values) => values.filter(Boolean).join(" "),
    },
    "../../lib/shared/utils": {
      cn: (...values) => values.filter(Boolean).join(" "),
    },
    "@liveagent/ui/components/IconSet": { ChevronDown: EmptyIcon },
    "../../IconSet": { Brain: EmptyIcon, ChevronRight: EmptyIcon },
  },
});
const { React, act, createRoot } = env;

const { ThinkingDisclosure } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ThinkingDisclosure.tsx",
);

function renderDisclosure(root, props = {}) {
  act(() => {
    root.render(
      React.createElement(ThinkingDisclosure, {
        text: "先读取文件，再检查测试。",
        trackKey: "turn-1:r1:thinking-1",
        active: true,
        ...props,
      }),
    );
  });
}

function click(element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

test("a streaming segment shows 思考中 with its reasoning open, then folds into 思考了 Xs", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderDisclosure(root, { active: true });
  const button = container.querySelector("button");
  assert.match(button.textContent, /思考中/);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.match(container.textContent, /先读取文件/);
  assert.ok(container.querySelector("[data-thinking-disclosure]"));
  assert.ok(container.querySelector("[data-thinking-active]"));

  durationState.settledMs = 23_000;
  renderDisclosure(root, { active: false });
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.match(button.textContent, /思考了 23s/);
  assert.equal(container.querySelector("[data-thinking-active]"), null);

  act(() => root.unmount());
});

test("manual disclosure ownership survives the active-to-settled transition", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  // User expands a settled segment: later renders must not steal it back.
  durationState.settledMs = 5_000;
  renderDisclosure(root, { active: false });
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "false");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  renderDisclosure(root, { active: false });
  assert.equal(button.getAttribute("aria-expanded"), "true");

  act(() => root.unmount());
});

test("collapsing a still-streaming segment sticks through settle", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderDisclosure(root, { active: true });
  const button = container.querySelector("button");
  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  renderDisclosure(root, { active: true });
  assert.equal(button.getAttribute("aria-expanded"), "false");

  durationState.settledMs = 1_000;
  renderDisclosure(root, { active: false });
  assert.equal(button.getAttribute("aria-expanded"), "false");

  act(() => root.unmount());
});

test("a history-loaded segment without a measured duration reads 思考过程", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  durationState.settledMs = null;
  renderDisclosure(root, { active: false });
  const button = container.querySelector("button");
  assert.match(button.textContent, /思考过程/);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  act(() => root.unmount());
});

test("a streaming segment pins its scroller through the follow engine, not column-reverse", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderDisclosure(root, { active: true });
  const scroller = container.querySelector("[data-thinking-scroll]");
  assert.ok(scroller);
  // The CSS-only pin is unreliable in WebKit (no bottom anchoring while
  // streaming, scrollTop <= 0 confuses nested-wheel detection).
  assert.doesNotMatch(scroller.className, /flex-col-reverse/);
  assert.match(scroller.className, /overflow-y-auto/);

  const wiring = scrollFollowCalls.at(-1);
  assert.equal(wiring.enabled, true);
  assert.equal(wiring.viewport, scroller);
  // The growth target must be the inner wrapper: once max-h clamps the
  // scroller its own border box stops changing while scrollHeight grows.
  assert.equal(wiring.content, scroller.firstElementChild);
  assert.notEqual(wiring.content, scroller);
  assert.equal(wiring.config.reattachZonePx, 0);

  act(() => root.unmount());
});

test("scroll follow disengages once the segment settles or is collapsed", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderDisclosure(root, { active: true });
  assert.equal(scrollFollowCalls.at(-1).enabled, true);

  // User folds the streaming block: no pinning against a hidden body.
  click(container.querySelector("button"));
  assert.equal(scrollFollowCalls.at(-1).enabled, false);

  click(container.querySelector("button"));
  assert.equal(scrollFollowCalls.at(-1).enabled, true);

  // Settled segments read top-down, even while the user keeps them open.
  durationState.settledMs = 2_000;
  renderDisclosure(root, { active: false });
  assert.equal(container.querySelector("button").getAttribute("aria-expanded"), "true");
  assert.equal(scrollFollowCalls.at(-1).enabled, false);

  act(() => root.unmount());
});

test.after(() => env.cleanup());

// --- real duration tracker ---

const { resolveThinkingDurationMs } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/chat/thinkingDurations.ts",
);

test("thinking durations settle once and stay stable across reads", () => {
  assert.equal(resolveThinkingDurationMs("seg-1", true, 1_000), null);
  // A later active read keeps the original start instead of restarting.
  assert.equal(resolveThinkingDurationMs("seg-1", true, 2_500), null);
  assert.equal(resolveThinkingDurationMs("seg-1", false, 4_000), 3_000);
  assert.equal(resolveThinkingDurationMs("seg-1", false, 9_000), 3_000);
  // A segment never observed streaming (history reload) has no duration.
  assert.equal(resolveThinkingDurationMs("seg-2", false, 9_000), null);
});
