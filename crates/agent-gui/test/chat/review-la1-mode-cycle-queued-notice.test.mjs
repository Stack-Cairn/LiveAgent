import assert from "node:assert/strict";
import test from "node:test";
import React0 from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Review LA-1: queued turns keep the mode they were queued with:
//   - useChatTurnQueue.ts   createQueuedChatTurn({ commandSafetyMode: settings.system.commandSafetyMode,
//                            runtimeControls: settings.chatRuntimeControls })
//   - useChatTurnQueue.ts   commandSafetyModeOverride: queuedTurn.commandSafetyMode
//     (asserted by chat-stop-timing.test.mjs: "a queued local turn must snapshot the selected mode")
//   - useSendChatTurn.ts    strictestCommandSafetyMode(override, settings.system.commandSafetyMode)
//   - useSendChatTurn.ts    plan = settings plan || runtimeControlsOverride.planModeEnabled === true
// With a queue the Shift+Tab notice must not promise the next turn; it names
// new messages instead. Without a queue a running turn still says next turn.

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
const { strictestCommandSafetyMode } = env.loadModule("@liveagent/ui/lib/settings/index.ts");
const { resolveKBrainPermissionMode } = env.loadModule(
  "@liveagent/ui/lib/chat/permissionModes.ts",
);
const { createQueuedChatTurn } = env.loadModule(
  "@liveagent/app/pages/chat/queue/chatTurnQueue.ts",
);
const tr = (key) => translate(key, "en-US");
const noop = () => {};

let container;
let root;
let hostState;

function Host({ initial, queuedTurns, isSending }) {
  const [settings, setSettings] = React.useState(initial);
  hostState = settings;
  return React.createElement(ChatComposerBar, {
    surface: "desktop",
    conversationId: "c1",
    composerRef: { current: null },
    isSending,
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
    onCommandSafetyModeChange: (mode) =>
      setSettings((prev) => ({ ...prev, commandSafetyMode: mode })),
    onChatRuntimeControlsChange: (patch) =>
      setSettings((prev) => ({
        ...prev,
        planModeEnabled: patch.planModeEnabled ?? prev.planModeEnabled,
      })),
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
    queuedTurns,
    queuePaused: false,
    onQueuePausedChange: noop,
    onRunQueuedTurnNow: noop,
    onMoveQueuedTurnUp: noop,
    onEditQueuedTurn: noop,
    onRemoveQueuedTurn: noop,
  });
}

async function mount(initial, queuedTurns, isSending = true) {
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
        React.createElement(Host, { initial, queuedTurns, isSending }),
      ),
    );
  });
  return container.querySelector('[role="textbox"]');
}

async function shiftTab(editor) {
  await act(async () => {
    editor.focus();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        code: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

const notice = () => container.querySelector("[data-mode-cycle-notice]")?.textContent ?? null;

// The dispatch-time merge for a queued local turn (useSendChatTurn.ts:356-366).
function nextQueuedTurnPermissionMode(queuedTurn, settings) {
  const mode = strictestCommandSafetyMode(queuedTurn.commandSafetyMode, settings.commandSafetyMode);
  const plan = settings.planModeEnabled || queuedTurn.runtimeControls.planModeEnabled === true;
  return resolveKBrainPermissionMode(mode, plan);
}

const queuedPreview = (turn) => [{ id: turn.id, previewText: "follow-up", fileCount: 0 }];
const queue = (before) =>
  createQueuedChatTurn({
    conversationId: "c1",
    draft: { text: "follow-up", conversationMentions: [] },
    uploadedFiles: [],
    executionMode: "tools",
    workdir: "/w",
    commandSafetyMode: before.commandSafetyMode,
    runtimeControls: { planModeEnabled: before.planModeEnabled },
  });

for (const scenario of [
  {
    name: "plan -> ask",
    before: { commandSafetyMode: "autoEdit", planModeEnabled: true },
    label: "chat.safety.ask",
    queuedRunsAs: "plan",
  },
  {
    name: "ask -> auto edit",
    before: { commandSafetyMode: "ask", planModeEnabled: false },
    label: "chat.safety.autoEdit",
    queuedRunsAs: "normal",
  },
]) {
  test(`running with a queued turn, ${scenario.name}: notice names new messages, not the next turn`, async () => {
    const queuedTurn = queue(scenario.before);
    const editor = await mount(scenario.before, queuedPreview(queuedTurn));
    await shiftTab(editor);
    const text = notice();
    assert.equal(text, `${tr(scenario.label)} · ${tr("chat.safety.cycleNewMessages")}`);
    assert.ok(!text.includes(tr("chat.safety.cycleNextTurn")), text);
    // The queued (next) turn still runs with its enqueue-time mode.
    assert.equal(nextQueuedTurnPermissionMode(queuedTurn, hostState), scenario.queuedRunsAs);
  });
}

test("queue paused, nothing running: a queued turn still makes the notice name new messages", async () => {
  const before = { commandSafetyMode: "ask", planModeEnabled: false };
  const queuedTurn = queue(before);
  const editor = await mount(before, queuedPreview(queuedTurn), false);
  await shiftTab(editor);
  assert.equal(notice(), `${tr("chat.safety.autoEdit")} · ${tr("chat.safety.cycleNewMessages")}`);
});

test("running without a queue says next turn; idle without a queue shows the mode only", async () => {
  const before = { commandSafetyMode: "ask", planModeEnabled: false };
  let editor = await mount(before, [], true);
  await shiftTab(editor);
  assert.equal(notice(), `${tr("chat.safety.autoEdit")} · ${tr("chat.safety.cycleNextTurn")}`);
  editor = await mount(before, [], false);
  await shiftTab(editor);
  assert.equal(notice(), tr("chat.safety.autoEdit"));
});

test("the notice keys exist in both locales", () => {
  for (const key of [
    "chat.safety.cycleShortcut",
    "chat.safety.cycleNextTurn",
    "chat.safety.cycleNewMessages",
  ]) {
    for (const locale of ["en-US", "zh-CN"]) {
      const value = translate(key, locale);
      assert.ok(value && value !== key, `${locale} ${key}`);
    }
  }
});

test.after(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  env.cleanup();
});
