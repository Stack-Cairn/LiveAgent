import assert from "node:assert/strict";
import test from "node:test";
import React0 from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// The real ChatComposerBar wires Shift+Tab to the permission picker and plan switch,
// and briefly names the new mode beside the picker.

const svgIcons = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule"
        ? true
        : (props) => React0.createElement("svg", { className: props?.className }),
  },
);
let composerProps = null;
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": svgIcons,
    "@liveagent/ui/components/chat/fileTypeIcons": svgIcons,
    "@liveagent/ui/components/chat/MentionComposer": {
      MentionComposer: (props) => {
        composerProps = props;
        return null;
      },
    },
  },
});
const { React, act, createRoot } = env;
const doc = env.dom.window.document;
const { ChatComposerBar } = env.loadModule("@liveagent/ui/pages/chat/ChatComposerBar.tsx");
const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
const noop = () => {};

let container;
let root;
let modeChanges;
let controlChanges;

async function render(overrides = {}) {
  modeChanges = [];
  controlChanges = [];
  composerProps = null;
  if (!root) {
    container = doc.createElement("div");
    doc.body.appendChild(container);
    root = createRoot(container);
  }
  const props = {
    surface: "desktop",
    conversationId: "c1",
    composerRef: { current: null },
    isSending: false,
    isUploadingFiles: false,
    isInputDisabled: false,
    inputPlaceholder: "Ask",
    workdir: "/w",
    enabledSkills: [],
    executionMode: "tools",
    hasModels: true,
    currentModelLabel: "m",
    modelOptions: [],
    chatRuntimeControls: { planModeEnabled: false },
    reasoningOptions: [],
    thinkingAlwaysOn: false,
    commandSafetyMode: "ask",
    onCommandSafetyModeChange: (mode) => modeChanges.push(mode),
    onSend: noop,
    onStop: noop,
    onComposerBusyChange: noop,
    onSelectModel: noop,
    onSelectExecutionMode: noop,
    onChatRuntimeControlsChange: (patch) => controlChanges.push(patch),
    onPickReadableFiles: noop,
    onPickWorkspaceFolder: noop,
    onPasteFiles: noop,
    pendingUploadedFiles: [],
    onRemovePendingUpload: noop,
    queuedTurns: [],
    queuePaused: false,
    onQueuePausedChange: noop,
    onRunQueuedTurnNow: noop,
    onMoveQueuedTurnUp: noop,
    onEditQueuedTurn: noop,
    onRemoveQueuedTurn: noop,
    ...overrides,
  };
  await act(async () => {
    root.render(
      React.createElement(
        LocaleContext.Provider,
        { value: { locale: "en-US", t: (key) => translate(key, "en-US") } },
        React.createElement(ChatComposerBar, props),
      ),
    );
  });
}

async function cycle() {
  assert.equal(typeof composerProps?.onCycleMode, "function", "composer gets a cycle handler");
  await act(async () => composerProps.onCycleMode());
}

const notice = () => container.querySelector("[data-mode-cycle-notice]")?.textContent ?? null;

test("ask moves to auto edit and names it beside the picker", async () => {
  await render({ commandSafetyMode: "ask" });
  await cycle();
  assert.deepEqual(modeChanges, ["autoEdit"]);
  assert.deepEqual(controlChanges, []);
  assert.equal(notice(), translate("chat.safety.autoEdit", "en-US"));
});

test("auto edit turns plan on and keeps the permission mode", async () => {
  await render({ commandSafetyMode: "autoEdit" });
  await cycle();
  assert.deepEqual(modeChanges, []);
  assert.deepEqual(controlChanges, [{ planModeEnabled: true }]);
  assert.equal(notice(), translate("chat.runtime.planMode", "en-US"));
});

test("plan turns off and returns to ask", async () => {
  await render({ commandSafetyMode: "autoEdit", chatRuntimeControls: { planModeEnabled: true } });
  await cycle();
  assert.deepEqual(modeChanges, ["ask"]);
  assert.deepEqual(controlChanges, [{ planModeEnabled: false }]);
  assert.equal(notice(), translate("chat.safety.ask", "en-US"));
});

test("while a turn runs the notice says the mode applies from the next turn", async () => {
  await render({ commandSafetyMode: "always", isSending: true });
  await cycle();
  assert.deepEqual(modeChanges, ["ask"]);
  const text = notice();
  assert.ok(text?.includes(translate("chat.safety.ask", "en-US")), text);
  assert.ok(text?.includes(translate("chat.safety.cycleNextTurn", "en-US")), text);
});

test("the notice is announced and goes away", async () => {
  await render({ commandSafetyMode: "ask" });
  await cycle();
  const node = container.querySelector("[data-mode-cycle-notice]");
  // The live region stays mounted so screen readers announce each new mode.
  assert.equal(node?.parentElement?.getAttribute("role"), "status");
  assert.equal(node?.parentElement?.getAttribute("aria-live"), "polite");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1700)));
  assert.equal(notice(), null);
});

test("the picker tells how to cycle", async () => {
  await render({ commandSafetyMode: "ask" });
  const trigger = container.querySelector(
    `[aria-label^="${translate("chat.safety.label", "en-US")}"]`,
  );
  assert.ok(trigger?.getAttribute("title")?.includes("Shift+Tab"), trigger?.getAttribute("title"));
});

test("no cycling outside agent mode, while disabled or without a picker", async () => {
  for (const overrides of [
    { executionMode: "text" },
    { isInputDisabled: true },
    { onCommandSafetyModeChange: undefined },
    { commandSafetyMode: undefined },
  ]) {
    await render(overrides);
    assert.equal(composerProps?.onCycleMode, undefined, JSON.stringify(Object.keys(overrides)));
  }
});

test.after(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  env.cleanup();
});
