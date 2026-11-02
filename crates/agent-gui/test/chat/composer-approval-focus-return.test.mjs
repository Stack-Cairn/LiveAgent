import assert from "node:assert/strict";
import test from "node:test";
import React0 from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Like Claude Code: after an approval is answered (the bar that replaced the composer goes
// away) the caret is back in the composer, so the user can type what to do next.

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

const focusCalls = [];
const composerRef = { current: { focus: () => focusCalls.push("composer") } };
const approvalBar = () =>
  React.createElement("section", { tabIndex: -1, "data-test-approval": "" }, "approval");

test("the composer gets the caret back when the answered approval bar goes away", async () => {
  focusCalls.length = 0;
  await render({ composerRef, approvalBar: approvalBar() });
  const bar = container.querySelector("[data-test-approval]");
  bar.focus();
  assert.equal(doc.activeElement === bar, true);
  await render({ composerRef, approvalBar: null });
  assert.deepEqual(focusCalls, ["composer"]);
});

test("a caret the user moved elsewhere meanwhile is left alone", async () => {
  focusCalls.length = 0;
  const other = doc.createElement("input");
  doc.body.appendChild(other);
  try {
    await render({ composerRef, approvalBar: approvalBar() });
    other.focus();
    await render({ composerRef, approvalBar: null });
    assert.deepEqual(focusCalls, []);
  } finally {
    other.remove();
  }
});

test("rendering without an approval bar never grabs focus", async () => {
  focusCalls.length = 0;
  await render({ composerRef, approvalBar: null });
  await render({ composerRef, approvalBar: null, inputPlaceholder: "Ask again" });
  assert.deepEqual(focusCalls, []);
});
