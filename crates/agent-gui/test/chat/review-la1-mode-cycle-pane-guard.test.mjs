import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React0 from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Review LA-1: real ChatComposerBar + real MentionComposer, driven by real
// Shift+Tab keydown events, with a stateful host that applies settings the way
// both hosts do (functional setSettings).
//
// Background panes: both hosts give a non-focused conversation pane an
// onChatRuntimeControlsChange that only focuses the pane and drops the patch,
// while onCommandSafetyModeChange stays the global setter:
//   - GUI  ChatPage.tsx buildBackgroundPaneBinding: onChatRuntimeControlsChange: focusGuard(...),
//          onCommandSafetyModeChange: setSettings(...) (no guard),
//          guardModeCycle: (apply) => focusGuard(apply)()
//   - WebUI GatewayConversationPaneHost.tsx: onChatRuntimeControlsChange
//          `usePrimary && primary ? ... : () => onFocusPane()`, global onCommandSafetyModeChange,
//          guardModeCycle={usePrimary && primary ? undefined : () => onFocusPane()}
// PaneFrame.tsx only focuses a pane on pointerdown, so keyboard focus (Tab into
// the other pane's editor, tabIndex=0) reaches the background state. Once the
// pane is focused, the GUI registers it with primaryPaneBinding (no guard) and
// WebUI renders it with usePrimary, so the host below switches to the primary
// handlers after a focus request.

const svgIcons = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule"
        ? true
        : String(key).endsWith("_SVG_MARKUP")
          ? "<svg></svg>"
          : (props) => React0.createElement("svg", { className: props?.className }),
  },
);
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": svgIcons,
    "@liveagent/ui/components/chat/fileTypeIcons": svgIcons,
  },
});
window.HTMLElement.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
});
document.execCommand = () => true;

const { React, act, createRoot } = env;
const { ChatComposerBar } = env.loadModule("@liveagent/ui/pages/chat/ChatComposerBar.tsx");
const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
const tr = (key) => translate(key, "en-US");
const noop = () => {};

let container;
let root;
let hostState;
let focusRequests;

// The two guard shapes the hosts pass for a background pane.
const GUARDS = {
  // GUI: focusGuard(fn) runs fn when the pane is focused, else focuses it.
  gui: (isFocused, requestFocus) => (apply) => {
    const focusGuard =
      (fn) =>
      (...args) => {
        if (!isFocused()) {
          requestFocus();
          return;
        }
        fn(...args);
      };
    focusGuard(apply)();
  },
  // WebUI: () => onFocusPane(), apply is never run.
  web: (_isFocused, requestFocus) => () => requestFocus(),
};

function Host({ initial, backgroundGuard }) {
  const [settings, setSettings] = React.useState(initial);
  const [focused, setFocused] = React.useState(!backgroundGuard);
  hostState = { ...settings, focused };
  const requestFocus = () => {
    focusRequests += 1;
    setFocused(true);
  };
  const background = !focused;
  const props = {
    surface: "desktop",
    conversationId: "c-pane-b",
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
    chatRuntimeControls: { planModeEnabled: settings.planModeEnabled },
    reasoningOptions: [],
    thinkingAlwaysOn: false,
    commandSafetyMode: settings.commandSafetyMode,
    // Global setter in both hosts, for every pane.
    onCommandSafetyModeChange: (mode) =>
      setSettings((prev) =>
        prev.commandSafetyMode === mode ? prev : { ...prev, commandSafetyMode: mode },
      ),
    onChatRuntimeControlsChange: background
      ? () => requestFocus()
      : (patch) =>
          setSettings((prev) => ({
            ...prev,
            planModeEnabled: patch.planModeEnabled ?? prev.planModeEnabled,
          })),
    guardModeCycle: background ? GUARDS[backgroundGuard](() => focused, requestFocus) : undefined,
    onSend: noop,
    onStop: noop,
    onComposerBusyChange: noop,
    onSelectModel: noop,
    onSelectExecutionMode: noop,
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
  };
  return React.createElement(ChatComposerBar, props);
}

async function mount(initial, backgroundGuard = null) {
  focusRequests = 0;
  if (root) {
    await act(async () => root.unmount());
    container.remove();
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        LocaleContext.Provider,
        { value: { locale: "en-US", t: tr } },
        React.createElement(Host, { initial, backgroundGuard }),
      ),
    );
  });
  const editor = container.querySelector('[role="textbox"]');
  assert.ok(editor, "real MentionComposer editor is rendered");
  return editor;
}

// One act per key press: each real keydown is its own task, so React flushes
// the discrete update before the next press.
async function shiftTab(editor) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    code: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    editor.focus();
    editor.dispatchEvent(event);
  });
  return event;
}

const notice = () => container.querySelector("[data-mode-cycle-notice]")?.textContent ?? null;
const planPill = () =>
  container.querySelector(`button[aria-label="${tr("chat.runtime.planModeSlashOff")}"]`);
const settingsOf = () => ({
  commandSafetyMode: hostState.commandSafetyMode,
  planModeEnabled: hostState.planModeEnabled,
});

test("verification: three quick Shift+Tab presses walk ask -> auto edit -> plan -> ask", async () => {
  const editor = await mount({ commandSafetyMode: "ask", planModeEnabled: false });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const event = await shiftTab(editor);
    assert.equal(event.defaultPrevented, true);
    seen.push({ ...settingsOf(), notice: notice() });
  }
  assert.deepEqual(seen, [
    { commandSafetyMode: "autoEdit", planModeEnabled: false, notice: tr("chat.safety.autoEdit") },
    { commandSafetyMode: "autoEdit", planModeEnabled: true, notice: tr("chat.runtime.planMode") },
    { commandSafetyMode: "ask", planModeEnabled: false, notice: tr("chat.safety.ask") },
  ]);
});

for (const guard of Object.keys(GUARDS)) {
  test(`background pane (${guard} guard): first press only focuses, no plan announced`, async () => {
    const editor = await mount({ commandSafetyMode: "autoEdit", planModeEnabled: false }, guard);
    const event = await shiftTab(editor);
    assert.equal(event.defaultPrevented, true);
    assert.equal(focusRequests, 1);
    assert.deepEqual(settingsOf(), { commandSafetyMode: "autoEdit", planModeEnabled: false });
    assert.equal(notice(), null);
    // Focused now: the next press runs the whole step.
    await shiftTab(editor);
    assert.deepEqual(settingsOf(), { commandSafetyMode: "autoEdit", planModeEnabled: true });
    assert.equal(notice(), tr("chat.runtime.planMode"));
    assert.ok(planPill());
  });

  test(`background pane (${guard} guard): leaving plan applies all of the step or none of it`, async () => {
    const editor = await mount({ commandSafetyMode: "autoEdit", planModeEnabled: true }, guard);
    await shiftTab(editor);
    assert.deepEqual(settingsOf(), { commandSafetyMode: "autoEdit", planModeEnabled: true });
    assert.equal(notice(), null);
    await shiftTab(editor);
    assert.deepEqual(settingsOf(), { commandSafetyMode: "ask", planModeEnabled: false });
    assert.equal(notice(), tr("chat.safety.ask"));
    assert.equal(planPill(), null);
  });
}

test("live region is mounted before the first notice and holds the floating pill", async () => {
  const editor = await mount({ commandSafetyMode: "ask", planModeEnabled: false });
  const region = container.querySelector('[role="status"][aria-live="polite"]');
  assert.ok(region, "status region exists before any Shift+Tab");
  assert.equal(region.childElementCount, 0);
  await shiftTab(editor);
  const pill = container.querySelector("[data-mode-cycle-notice]");
  assert.equal(pill?.parentElement, region, "the pill is inserted into the same region");
  // The pill is positioned against the picker wrapper; that wrapper sits inside
  // the left control group, which clips (overflow-hidden). jsdom has no layout,
  // so this only pins the structure the width estimate in the review relies on.
  const anchor = region.parentElement;
  assert.match(anchor.className, /\brelative\b/);
  assert.match(pill.className, /\babsolute\b/);
  assert.match(anchor.parentElement.className, /\boverflow-hidden\b/);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));
  assert.equal(container.querySelector('[role="status"][aria-live="polite"]'), region);
  assert.equal(region.childElementCount, 0);
});

// Source contract: every host path that can render a composer for a pane that
// is not the focused conversation passes a guard, and the guard keys on the
// same condition as the pane's onChatRuntimeControlsChange.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("GUI: background pane binding guards the cycle; only the current conversation gets the unguarded binding", () => {
  const source = read("../../src/pages/ChatPage.tsx");
  const start = source.indexOf("const buildBackgroundPaneBinding = (");
  assert.ok(start > 0);
  const end = source.indexOf("\n  };\n", start);
  const background = source.slice(start, end);
  assert.match(background, /onChatRuntimeControlsChange: focusGuard\(handleChatRuntimeControlsChange\)/);
  assert.match(background, /guardModeCycle: \(apply\) => focusGuard\(apply\)\(\)/);
  // The unguarded primary binding only goes to the current conversation's pane,
  // and the guard's own check (currentConversationIdRef) uses the same id.
  assert.match(
    source,
    /surface\.conversationId === currentConversationId\s*\?\s*primaryPaneBinding\s*:\s*buildBackgroundPaneBinding\(surface\)/,
  );
  assert.match(background, /if \(currentConversationIdRef\.current !== conversationId\) \{\s*focusWorkbenchConversationPane\(conversationId\);\s*return;/);
});

test("WebUI: pane host guards the cycle under the same condition as its runtime controls", () => {
  const source = read("../../../agent-gateway/web/src/app/workbench/GatewayConversationPaneHost.tsx");
  assert.match(
    source,
    /onChatRuntimeControlsChange=\{\s*usePrimary && primary \? primary\.onChatRuntimeControlsChange : \(\) => onFocusPane\(\)\s*\}/,
  );
  assert.match(source, /guardModeCycle=\{usePrimary && primary \? undefined : \(\) => onFocusPane\(\)\}/);
  // GatewayAppView's own composer always edits the displayed conversation.
  const app = read("../../../agent-gateway/web/src/app/GatewayAppView.tsx");
  assert.match(app, /onChatRuntimeControlsChange=\{handleChatRuntimeControlsChange\}/);
});

test.after(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  env.cleanup();
});
