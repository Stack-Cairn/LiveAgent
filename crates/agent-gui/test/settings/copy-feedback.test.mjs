import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function fakeTimers() {
  const set = window.setTimeout;
  const clear = window.clearTimeout;
  const timers = new Map();
  let now = 0, id = 100000;
  window.setTimeout = (callback, delay) => {
    const key = ++id;
    timers.set(key, {callback, due: now + delay});
    return key;
  };
  window.clearTimeout = (key) => { timers.delete(key); };
  return {
    timers,
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) {
        if (timer.due <= now) { timers.delete(key); timer.callback(); }
      }
    },
    restore() { window.setTimeout = set; window.clearTimeout = clear; },
  };
}

test("clipboard fallback handles rejection and always removes its temporary textarea", async () => {
  const env = await createDomTestEnv();
  const { copyTextToClipboard } = env.loadModule("@liveagent/ui/lib/shared/clipboard.ts");
  const copied = [];
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: async (text) => copied.push(text)}});
  let fallbackCalls = 0;
  document.execCommand = () => { fallbackCalls++; return true; };
  try {
    assert.equal(await copyTextToClipboard("native"), true);
    assert.deepEqual(copied, ["native"]);
    assert.equal(fallbackCalls, 0);
    navigator.clipboard.writeText = async () => { throw Error("denied"); };
    assert.equal(await copyTextToClipboard("fallback"), true);
    assert.equal(fallbackCalls, 1);
    assert.equal(document.querySelector("textarea"), null);
    document.execCommand = () => { throw Error("unsupported"); };
    assert.equal(await copyTextToClipboard("failure"), false);
    assert.equal(document.querySelector("textarea"), null);
    Object.defineProperty(navigator, "clipboard", {configurable: true, value: undefined});
    document.execCommand = () => false;
    assert.equal(await copyTextToClipboard("unavailable"), false);
  } finally { env.cleanup(); }
});

test("global pointer styles compose overlapping owners and restore the original body style", async () => {
  const env = await createDomTestEnv();
  const { acquireGlobalPointerStyle } = env.loadModule(
    "@liveagent/ui/lib/shared/globalPointerStyle.ts",
  );
  document.body.style.cursor = "default";
  document.body.style.userSelect = "text";
  try {
    const releaseResize = acquireGlobalPointerStyle({
      cursor: "col-resize",
      userSelect: "none",
    });
    const releaseReorder = acquireGlobalPointerStyle({ cursor: "grabbing" });
    assert.equal(document.body.style.cursor, "grabbing");
    assert.equal(document.body.style.userSelect, "none");

    releaseResize();
    assert.equal(document.body.style.cursor, "grabbing");
    assert.equal(document.body.style.userSelect, "text");

    releaseReorder();
    releaseReorder();
    assert.equal(document.body.style.cursor, "default");
    assert.equal(document.body.style.userSelect, "text");

    acquireGlobalPointerStyle({ cursor: "grabbing", userSelect: "none" });
    window.dispatchEvent(new Event("blur"));
    assert.equal(document.body.style.cursor, "default");
    assert.equal(document.body.style.userSelect, "text");
  } finally {
    env.cleanup();
  }
});

test("copy feedback restarts its deadline, keeps the latest identity and cancels on reset/unmount", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { useCopyFeedback, COPY_FEEDBACK_DURATION } = env.loadModule("@liveagent/ui/lib/shared/useCopyFeedback.ts");
  const clock = fakeTimers();
  let feedback, expirations = 0;
  function Fixture({duration}) {
    feedback = useCopyFeedback("", duration, () => expirations++);
    return React.createElement("span", null, feedback.copied);
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    for (const duration of Object.values(COPY_FEEDBACK_DURATION)) {
      await act(async () => root.render(React.createElement(Fixture, {duration})));
      await act(async () => feedback.showCopied("a"));
      await act(async () => clock.advance(duration - 1));
      assert.equal(container.textContent, "a");
      await act(async () => feedback.showCopied("b"));
      await act(async () => clock.advance(1));
      assert.equal(container.textContent, "b");
      await act(async () => clock.advance(duration - 1));
      assert.equal(container.textContent, "");
    }
    assert.equal(expirations, 4);
    await act(async () => feedback.showCopied("same"));
    await act(async () => clock.advance(1000));
    await act(async () => feedback.showCopied("same"));
    await act(async () => clock.advance(1000));
    assert.equal(container.textContent, "same");
    await act(async () => feedback.resetCopied());
    assert.equal(clock.timers.size, 0);
    assert.equal(container.textContent, "");
    await act(async () => feedback.showCopied("last"));
    const lateResult = feedback.showCopied;
    await act(async () => root.unmount());
    assert.equal(clock.timers.size, 0);
    lateResult("resolved after unmount");
    assert.equal(clock.timers.size, 0);
  } finally { clock.restore(); env.cleanup(); }
});

test("settings copy buttons preserve their surfaces and show success only after the write succeeds", async () => {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": {
      Copy: (props) => env.React.createElement("svg", { ...props, "data-icon": "copy" }),
      Check: (props) => env.React.createElement("svg", { ...props, "data-icon": "check" }),
    },
  }});
  const {React, act, createRoot} = env;
  const {SettingsCopyButton} = env.loadModule("@liveagent/ui/components/settings/SettingsCopyButton.tsx");
  const clock = fakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  let resolveCopy;
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: () => new Promise(resolve => {resolveCopy = resolve;})}});
  document.execCommand = () => false;
  try {
    for (const size of ["compact", "default"]) {
      const ref = React.createRef();
      await act(async () => root.render(React.createElement(SettingsCopyButton, {ref, size, value: "secret", title: "original title"})));
      const button = container.firstElementChild;
      assert.equal(ref.current, button);
      assert.equal(button.tagName, "BUTTON");
      assert.equal(button.title, "original title");
      assert.equal(button.hasAttribute("size"), false);
      assert.ok(button.classList.contains(size === "compact" ? "size-7" : "size-8"));
      await act(async () => button.click());
      assert.equal(button.querySelector(".text-emerald-500"), null);
      await act(async () => resolveCopy());
      assert.ok(button.querySelector(".text-emerald-500"));
      await act(async () => clock.advance(2000));
      assert.equal(button.querySelector(".text-emerald-500"), null);
    }
    navigator.clipboard.writeText = async () => { throw Error("denied"); };
    await act(async () => container.firstElementChild.click());
    assert.equal(container.querySelector(".text-emerald-500"), null);
    assert.equal(clock.timers.size, 0);
  } finally {
    await act(async () => root.unmount());
    clock.restore();
    env.cleanup();
  }
});
