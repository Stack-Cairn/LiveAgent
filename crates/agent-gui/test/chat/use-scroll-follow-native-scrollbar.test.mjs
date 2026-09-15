import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Regression for the "scrollbar thumb glued to the bottom" bug: the transcript
// (GUI) and the Base UI viewport (WebUI, native bar hidden but still the
// scroller) both run useScrollFollow on a native-scrollbar viewport. A native
// thumb drag emits scroll events only — no pointermove reaches the page — so
// the hook must promote a press inside the scrollbar gutter to a drag on
// pointerdown, otherwise the corrector re-pins on every drag frame.

const env = await createDomTestEnv();
const { useScrollFollow } = env.loadModule("@liveagent/ui/lib/chat-scroll/useScrollFollow");
const React = env.React;

// jsdom has no layout: fake a 300x400 viewport with a 6px vertical scrollbar
// and 2000px of content, and make scrollTop writable + scroll-event driven.
function installGeometry(el, { width = 300, height = 400, barWidth = 6, scrollHeight = 2000 }) {
  let scrollTop = 0;
  Object.defineProperties(el, {
    clientWidth: { value: width - barWidth, configurable: true },
    clientHeight: { value: height, configurable: true },
    clientLeft: { value: 0, configurable: true },
    clientTop: { value: 0, configurable: true },
    scrollHeight: { value: scrollHeight, configurable: true },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Math.max(0, Math.min(scrollHeight - height, value));
      },
    },
  });
  el.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    width,
    height,
    right: 100 + width,
    bottom: 50 + height,
    x: 100,
    y: 50,
    toJSON() {},
  });
}

function pointer(type, target, init) {
  const Ctor = env.dom.window.PointerEvent ?? env.dom.window.MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  if (!("pointerType" in event) || event.pointerType === undefined) {
    Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  }
  if (event.button === undefined || event.button !== (init.button ?? 0)) {
    Object.defineProperty(event, "button", { value: init.button ?? 0 });
  }
  if (init.buttons !== undefined && event.buttons !== init.buttons) {
    Object.defineProperty(event, "buttons", { value: init.buttons });
  }
  target.dispatchEvent(event);
  return event;
}

function mount() {
  const container = env.dom.window.document.createElement("div");
  env.dom.window.document.body.appendChild(container);
  const root = env.createRoot(container);
  const captured = { handle: null, following: null, viewport: null };

  function Harness() {
    const [viewport, setViewport] = React.useState(null);
    const setRef = React.useCallback((el) => {
      if (el) installGeometry(el, {});
      setViewport(el);
    }, []);
    const { handle, following } = useScrollFollow({
      viewport,
      listenerRoot: viewport,
    });
    captured.handle = handle;
    captured.following = following;
    captured.viewport = viewport;
    return React.createElement(
      "div",
      { ref: setRef, "data-scroll-viewport": "" },
      React.createElement("div", null, "content"),
    );
  }

  env.act(() => {
    root.render(React.createElement(Harness));
  });
  return { root, container, captured };
}

// Simulate a native thumb drag: the browser moves scrollTop and emits scroll
// events; no pointermove reaches the page.
function nativeDragTo(viewport, ...tops) {
  for (const top of tops) {
    env.act(() => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new env.dom.window.Event("scroll"));
    });
  }
}

test("a mouse press inside the native scrollbar gutter lets a thumb drag detach follow", () => {
  const { root, captured } = mount();
  const viewport = captured.viewport;
  assert.ok(viewport);
  assert.equal(captured.following, true);
  // Mount pin.
  assert.equal(viewport.scrollTop, 1600);

  // Press at x=397: inside the 300px border box (100..400) but past the
  // 294px client box — the vertical scrollbar column.
  env.act(() => {
    pointer("pointerdown", viewport, { clientX: 397, clientY: 200, pointerType: "mouse" });
  });
  nativeDragTo(viewport, 1400, 1100, 600);

  assert.equal(captured.following, false, "thumb drag must detach follow");
  assert.equal(viewport.scrollTop, 600, "drag position must not be corrected back to the bottom");

  // Release far from the bottom stays detached.
  env.act(() => {
    pointer("pointerup", env.dom.window, { clientX: 397, clientY: 120, pointerType: "mouse" });
  });
  assert.equal(captured.following, false);
  assert.equal(viewport.scrollTop, 600);
  env.act(() => root.unmount());
});

test("dragging the native thumb back to the bottom and releasing re-engages follow", () => {
  const { root, captured } = mount();
  const viewport = captured.viewport;

  env.act(() => {
    pointer("pointerdown", viewport, { clientX: 397, clientY: 200, pointerType: "mouse" });
  });
  nativeDragTo(viewport, 900, 300);
  assert.equal(captured.following, false);
  nativeDragTo(viewport, 1200, 1550);
  // Still held: no attach mid-drag.
  assert.equal(captured.following, false);
  env.act(() => {
    pointer("pointerup", env.dom.window, { clientX: 397, clientY: 380, pointerType: "mouse" });
  });
  assert.equal(captured.following, true);
  assert.equal(viewport.scrollTop, 1600, "release inside the zone pins to the bottom");
  env.act(() => root.unmount());
});

test("a static content press followed by a layout echo is still corrected", () => {
  // The slop gate for content clicks is unchanged: a press inside the client
  // box never counts as a scrollbar press, so a scroll event that opens a gap
  // with no drag is treated as noise and re-pinned.
  const { root, captured } = mount();
  const viewport = captured.viewport;

  env.act(() => {
    pointer("pointerdown", viewport, { clientX: 200, clientY: 200, pointerType: "mouse" });
  });
  nativeDragTo(viewport, 1500);
  assert.equal(captured.following, true);
  assert.equal(viewport.scrollTop, 1600, "content press + gap is corrected back to the bottom");
  env.act(() => {
    pointer("pointerup", env.dom.window, { clientX: 200, clientY: 200, pointerType: "mouse" });
  });
  env.act(() => root.unmount());
});

test("a touch press in the gutter column is not a scrollbar press", () => {
  // Touch never grabs a native thumb; a finger landing over the gutter is a
  // content touch and goes through the touchmove path instead.
  const { root, captured } = mount();
  const viewport = captured.viewport;

  env.act(() => {
    pointer("pointerdown", viewport, { clientX: 397, clientY: 200, pointerType: "touch" });
  });
  nativeDragTo(viewport, 1500);
  assert.equal(captured.following, true);
  assert.equal(viewport.scrollTop, 1600);
  env.act(() => {
    pointer("pointerup", env.dom.window, { clientX: 397, clientY: 200, pointerType: "touch" });
  });
  env.act(() => root.unmount());
});

test.after(() => {
  env.cleanup();
});
