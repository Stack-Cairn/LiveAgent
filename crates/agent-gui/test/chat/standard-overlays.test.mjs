import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// @tanstack/virtual-core 是 workspace 内的 TS 源码包（exports 直指 src/index.ts），宿主
// Node 的 ESM 解析不认其无扩展名的相对 import。和 floor-nav-scroll 一样：经 TS loader
// 预加载 core，再让 react-virtual 也走 loader（这样它对 core 的 import 才能命中 mock）。
const virtualCore = createTsModuleLoader().loadModule(
  new URL("../../../virtual-core/src/index.ts", import.meta.url).pathname,
);
let realUseVirtualizer;
const locale = { locale: "en-US", t: (key) => key };
const env = await createDomTestEnv({ mocks: {
  "@tanstack/virtual-core": virtualCore,
  "@tanstack/react-virtual": { useVirtualizer: (...args) => realUseVirtualizer(...args) },
  "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  "@liveagent/ui/i18n/index": { useLocale: () => locale },
} });
realUseVirtualizer = env.loadModule(
  createRequire(new URL("../../package.json", import.meta.url)).resolve("@tanstack/react-virtual"),
).useVirtualizer;
globalThis.DOMRect = window.DOMRect;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
window.HTMLElement.prototype.scrollIntoView = () => {};
// FloorNavRail 是虚拟列表：jsdom 里滑动容器 clientHeight 为 0 时一个楼层都不会挂载。
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 396 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 40 });
HTMLElement.prototype.scrollTo = function ({ top = 0 } = {}) { this.scrollTop = top; };
const { React, act, createRoot } = env;
const { ProviderHeaderNameInput } = env.loadModule("@liveagent/ui/pages/settings/ProviderHeaderNameInput.tsx");
const { Popup, CommitMentionTooltip } = env.loadModule("@liveagent/ui/components/chat/MentionComposerOverlays.tsx");
const { PreviewCard, PreviewCardTrigger, PreviewCardContent } = env.loadModule("@liveagent/ui/components/ui/preview-card.tsx");
const { FloorNavRail } = env.loadModule("@liveagent/ui/pages/chat/transcript/FloorNavRail.tsx");

async function mount(Component) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Component)));
  return async () => { await act(async () => root.unmount()); container.remove(); };
}
async function key(value) {
  await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}

test("header autocomplete portals, selects by keyboard and advances focus", async () => {
  let value = "";
  function Harness() {
    const [current, setCurrent] = React.useState("");
    const next = React.useRef(null);
    return React.createElement("div", { style: { overflow: "hidden" } },
      React.createElement(ProviderHeaderNameInput, {
        value: current, suggestions: ["Authorization", "X-Api-Key"],
        onValueChange: (text) => { value = text; setCurrent(text); },
        onComplete: () => next.current.focus(),
      }), React.createElement("input", { ref: next, "data-next": true }));
  }
  const cleanup = await mount(Harness);
  try {
    const input = document.querySelector('[role="combobox"]');
    await act(async () => { input.focus(); input.click(); });
    await key("ArrowDown");
    assert.ok(document.querySelector('[role="listbox"]').closest('[data-base-ui-portal]'));
    await key("ArrowDown");
    await key("Enter");
    assert.ok(["Authorization", "X-Api-Key"].includes(value));
    assert.equal(document.activeElement, document.querySelector('[data-next]'));
    assert.equal(document.querySelector('[role="listbox"]'), null);
  } finally { await cleanup(); }
});

test("free-form header names remain valid and Enter advances without a preset", async () => {
  let completed = 0;
  const cleanup = await mount(() => React.createElement(ProviderHeaderNameInput, {
    value: "X-My-Custom-Header", suggestions: [], onValueChange: () => {}, onComplete: () => completed++,
  }));
  try {
    await act(async () => document.querySelector("input").focus());
    await key("Enter");
    assert.equal(completed, 1);
    assert.equal(document.querySelector("input").value, "X-My-Custom-Header");
  } finally { await cleanup(); }
});

test("header autocomplete opens by mouse and accepts a preset", async () => {
  let selected;
  let completed = 0;
  const cleanup = await mount(() => React.createElement(ProviderHeaderNameInput, {
    value: "", suggestions: ["X-Api-Key"], onValueChange: (value) => { selected = value; }, onComplete: () => completed++,
  }));
  try {
    const input = document.querySelector("input");
    await act(async () => {
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      input.focus();
      input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      input.click();
    });
    const option = document.querySelector('[role="option"]');
    assert.ok(option);
    await act(async () => option.click());
    assert.equal(selected, "X-Api-Key");
    assert.equal(completed, 1);
  } finally { await cleanup(); }
});

test("mention popup keeps editor focus, portals and dismisses with Escape", async () => {
  const editor = document.createElement("textarea");
  document.body.append(editor);
  editor.focus();
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(Popup, {
      anchorRef: { current: editor }, trigger: "mention", mode: "root", suggestions: [],
      highlightIndex: 0, isLoading: false, error: null, showEmpty: true, emptyLabel: "No matches",
      onBack: () => {}, onSelect: () => {}, onClose: () => setOpen(false),
    }) : null;
  }
  const cleanup = await mount(Harness);
  try {
    assert.ok(document.querySelector('[role="listbox"]').closest('[data-base-ui-portal]'));
    assert.equal(document.activeElement, editor);
    await key("Escape");
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.equal(document.activeElement, editor);
  } finally { await cleanup(); editor.remove(); }
});

test("preview card supports keyboard focus, portals and Escape", async () => {
  const cleanup = await mount(() => React.createElement(PreviewCard, null,
    React.createElement(PreviewCardTrigger, { render: React.createElement("button"), delay: 0 }, "Details"),
    React.createElement(PreviewCardContent, { "data-preview": true }, "Task details")));
  try {
    await act(async () => document.querySelector("button").focus());
    assert.ok(document.querySelector('[data-preview]').closest('[data-base-ui-portal]'));
    await key("Escape");
    assert.equal(document.querySelector('[data-preview]'), null);
  } finally { await cleanup(); }
});

test("commit preview supports an imperative editor chip anchor and dismissal", async () => {
  const anchor = document.createElement("span");
  document.body.append(anchor);
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(CommitMentionTooltip, {
      anchor, onClose: () => setOpen(false), onMouseEnter: () => {}, onMouseLeave: () => {},
      commit: { sha: "abcdef1234", shortSha: "abcdef1", subject: "Fix the popup", body: "Details", authorName: "Dev", authorEmail: "", authorDate: "", filesChanged: 2, insertions: 3, deletions: 1 },
    }) : null;
  }
  const cleanup = await mount(Harness);
  try {
    assert.match(document.querySelector('[data-base-ui-portal]').textContent, /Fix the popup/);
    await key("Escape");
    assert.equal(document.querySelector('[data-base-ui-portal]'), null);
  } finally { await cleanup(); anchor.remove(); }
});

const floors = ["First", "Second"].map((preview, index) => ({ rowKey: String(index), messageId: String(index), preview, responsePreview: "Reply" }));
test("desktop floor preview supports focus, pin and jump", async () => {
  let jumped;
  const cleanup = await mount(() => React.createElement(FloorNavRail, { conversationId: "test", floors, activeRowKey: "0", onJump: (key) => { jumped = key; } }));
  try {
    await act(async () => document.querySelector('button[aria-label="First"]').focus());
    const portal = document.querySelector('[data-base-ui-portal]');
    assert.match(portal.textContent, /First.*Reply/);
    await act(async () => portal.querySelector('[aria-label="Pin"]').click());
    assert.ok(portal.querySelector('[aria-label="Unpin"]'));
    await act(async () => portal.querySelector("button").click());
    assert.equal(jumped, "0");
  } finally { await cleanup(); }
});

test("touch floor popover opens by touch, closes outside and after jumping", async () => {
  window.matchMedia = (query) => ({ matches: query.includes("pointer: coarse"), addEventListener() {}, removeEventListener() {} });
  let jumped;
  const cleanup = await mount(() => React.createElement(FloorNavRail, { conversationId: "touch", floors, activeRowKey: "0", onJump: (key) => { jumped = key; } }));
  async function open() {
    await act(async () => document.querySelector('button[aria-label="First"]').dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true })));
  }
  try {
    await open();
    assert.ok(document.querySelector(".floor-nav-panel").closest('[data-base-ui-portal]'));
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      document.body.click();
    });
    assert.equal(!!document.querySelector(".floor-nav-panel"), false);
    await open();
    await act(async () => document.querySelector(".floor-nav-panel button").click());
    assert.equal(jumped, "0");
    assert.equal(!!document.querySelector(".floor-nav-panel"), false);
  } finally { await cleanup(); delete window.matchMedia; }
});

test.after(() => env.cleanup());
