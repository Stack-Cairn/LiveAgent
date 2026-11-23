import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Long edit diffs: collapsed to a preview with an expand control, expanded
// rows mounted only near the viewport, and re-diffing throttled while the
// edited text keeps changing.

const EmptyIcon = () => null;
const messages = {
  "chat.editDiff.expand": "Show {count} more lines",
  "chat.editDiff.collapse": "Show fewer lines",
};

// IntersectionObserver stand-in: tests decide when an element is near.
const observers = [];
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.elements = new Set();
    observers.push(this);
  }
  observe(element) {
    this.elements.add(element);
  }
  disconnect() {
    this.elements.clear();
    observers.splice(observers.indexOf(this), 1);
  }
}

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": { ChevronDown: EmptyIcon, ChevronUp: EmptyIcon },
    "@liveagent/ui/i18n/index": {
      useLocale: () => ({ locale: "en", t: (key) => messages[key] ?? key }),
    },
  },
});
const { React, act, createRoot } = env;
globalThis.IntersectionObserver = FakeIntersectionObserver;
const { EditDiffView } = env.loadModule("@liveagent/ui/components/chat/EditDiffView.tsx");
// The diff engine is a lazy chunk; load it up front so every mount renders at once.
await env.loadModule("@liveagent/ui/lib/chat/diffEngine.ts").diffEngine.load();

function lines(count, prefix) {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}`).join("\n");
}

/** Fires the enter (near) or leave (far) observer of an element. */
function intersect(element, kind, isIntersecting) {
  const margin = kind === "enter" ? "600px 0px" : "1600px 0px";
  for (const observer of [...observers]) {
    if (observer.options.rootMargin === margin && observer.elements.has(element)) {
      act(() => observer.callback([{ target: element, isIntersecting }]));
    }
  }
}

function mount(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(React.createElement(EditDiffView, props)));
  return {
    container,
    rerender: (next) => act(() => root.render(React.createElement(EditDiffView, next))),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const codeRows = (container) => container.querySelectorAll("code").length;

test("a short diff renders every line without an expand control", () => {
  const view = mount({ beforeText: "", afterText: lines(120, "added"), filePath: "a.ts" });
  try {
    assert.equal(codeRows(view.container), 120);
    assert.equal(view.container.querySelector("[data-diff-expand]"), null);
  } finally {
    view.unmount();
  }
});

test("a long diff collapses to a preview and expands into lazily mounted groups", () => {
  const view = mount({ beforeText: "", afterText: lines(1000, "added"), filePath: "a.ts" });
  try {
    const button = view.container.querySelector("[data-diff-expand]");
    assert.equal(codeRows(view.container), 300, "collapsed: the first 300 lines");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(button.textContent, "Show 700 more lines");

    act(() => button.click());
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(button.textContent, "Show fewer lines");
    const groups = [...view.container.querySelectorAll("[data-diff-row-group]")];
    assert.equal(groups.length, 4, "700 more lines in groups of 200");
    // Until a group comes near the viewport it is a spacer of estimated height.
    assert.equal(codeRows(view.container), 300);
    assert.equal(groups[0].firstElementChild.style.height, "4000px");
    assert.equal(groups[3].firstElementChild.style.height, "2000px");

    intersect(groups[0], "enter", true);
    assert.equal(groups[0].dataset.diffRowGroup, "mounted");
    assert.equal(codeRows(view.container), 500);
    assert.match(groups[0].textContent, /added line 301/);

    // Far away again: the rows leave the DOM, the spacer keeps their height.
    groups[0].getBoundingClientRect = () => ({ height: 4321 });
    intersect(groups[0], "leave", false);
    assert.equal(groups[0].dataset.diffRowGroup, "placeholder");
    assert.equal(groups[0].firstElementChild.style.height, "4321px");
    assert.equal(codeRows(view.container), 300);

    // A group holding focus stays mounted when it scrolls away.
    intersect(groups[1], "enter", true);
    const code = groups[1].querySelector("code");
    code.tabIndex = 0;
    code.focus();
    intersect(groups[1], "leave", false);
    assert.equal(groups[1].dataset.diffRowGroup, "mounted");

    act(() => button.click());
    assert.equal(codeRows(view.container), 300);
    assert.equal(view.container.querySelectorAll("[data-diff-row-group]").length, 0);
  } finally {
    view.unmount();
  }
});

test("an expensive diff is recomputed at most once per throttle window", async () => {
  // Each clock read by the diff hook advances 20 ms, so every diff "costs"
  // 20 ms and the next recomputation is due 200 ms after the last one. Other
  // readers (React's scheduler) see a still clock.
  const realNow = performance.now.bind(performance);
  let clock = 0;
  performance.now = () => {
    if (new Error().stack.includes("useThrottledDiff")) clock += 20;
    return clock;
  };
  const view = mount({ beforeText: "", afterText: "first draft", filePath: "a.ts" });
  try {
    assert.match(view.container.textContent, /first draft/);
    view.rerender({ beforeText: "", afterText: "second draft", filePath: "a.ts" });
    view.rerender({ beforeText: "", afterText: "third draft", filePath: "a.ts" });
    assert.match(view.container.textContent, /first draft/, "within the window: last diff shown");

    // The trailing recomputation shows the latest text, not an intermediate one.
    performance.now = realNow;
    await act(() => new Promise((resolve) => setTimeout(resolve, 260)));
    assert.match(view.container.textContent, /third draft/);
    assert.doesNotMatch(view.container.textContent, /first draft|second draft/);
  } finally {
    performance.now = realNow;
    view.unmount();
  }
});

test.after(() => {
  delete globalThis.IntersectionObserver;
  env.cleanup();
});
