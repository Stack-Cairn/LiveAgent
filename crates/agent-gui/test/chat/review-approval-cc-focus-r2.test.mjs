import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Second review round of feat-approval-card-cc: the real ChatComposerBar with the REAL
// MentionComposer (so composerIsEmpty / data-composer-draft come from the editor itself,
// including the synchronous clear() every send path calls) and the real ToolApprovalBar in
// the approvalBar slot. Assertions compare strings and booleans only.

const locale = { locale: "en-US", t: (key) => key };
const EmptyIcon = () => null;
const icons = new Proxy(
  {},
  {
    get: (_target, name) =>
      name === "__esModule"
        ? true
        : String(name).endsWith("_SVG_MARKUP")
          ? "<svg></svg>"
          : EmptyIcon,
  },
);
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": icons,
    "@liveagent/ui/components/chat/fileTypeIcons": icons,
  },
});
window.HTMLElement.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
document.execCommand = () => true;

const { React, act, createRoot } = env;
const { ChatComposerBar } = env.loadModule("@liveagent/ui/pages/chat/ChatComposerBar.tsx");
const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
const noop = () => {};

function mountPane(conversationId) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const composerRef = { current: null };
  const render = async (approvalBar, extra) => {
    const props = {
      surface: "desktop",
      conversationId,
      composerRef,
      isSending: true,
      isUploadingFiles: false,
      isInputDisabled: false,
      inputPlaceholder: "Ask",
      workdir: "",
      enabledSkills: [],
      executionMode: "tools",
      hasModels: true,
      currentModelLabel: "m",
      modelOptions: [],
      chatRuntimeControls: { planModeEnabled: false },
      reasoningOptions: [],
      thinkingAlwaysOn: false,
      commandSafetyMode: "ask",
      onCommandSafetyModeChange: noop,
      onSend: noop,
      onStop: noop,
      onComposerBusyChange: noop,
      onSelectModel: noop,
      onSelectExecutionMode: noop,
      onChatRuntimeControlsChange: noop,
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
      approvalBar,
    };
    await act(async () => {
      extra?.();
      root.render(React.createElement(ChatComposerBar, props));
    });
  };
  const editor = () => container.querySelector('[role="textbox"]');
  const panel = () => container.querySelector("[aria-keyshortcuts='Escape 3']")?.closest("section") ?? null;
  const type = async (text) => {
    const el = editor();
    await act(async () => {
      el.focus();
      el.textContent = text;
      const range = document.createRange();
      if (el.firstChild) range.setStart(el.firstChild, text.length);
      else range.setStart(el, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { render, editor, panel, type, composerRef, container, unmount };
}

const decisions = [];
const approvalBar = (pending) =>
  React.createElement(ToolApprovalBar, {
    pending,
    onDecide: async (toolCallId, decision, options) => {
      decisions.push(options ? `${toolCallId}:${decision}:${options.scope ?? ""}` : `${toolCallId}:${decision}`);
      return { ok: true };
    },
    onDecideAll: async () => {},
  });
const item = (id, rule) => ({
  toolCallId: id,
  toolName: "Bash",
  summary: rule,
  allowSession: true,
  sessionScope: rule,
  rememberRules: [rule],
  defaultScope: "project",
});

async function press(key, init = {}) {
  const target = document.activeElement;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

async function clickInside(el) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    el.focus();
    el.click();
    await Promise.resolve();
  });
}

const where = (pane) =>
  document.activeElement === pane.panel()
    ? "panel"
    : document.activeElement === pane.editor()
      ? "editor"
      : document.activeElement === document.body
        ? "body"
        : (document.activeElement?.tagName ?? "null");

// Coordinator's question: a send clears the editor and the first approval of the turn
// arrives right after. composerIsEmpty must be true by then or the card loses its focus
// (Enter/Esc dead right after sending, the common case). Every send path calls
// composer.clear() before the turn starts; clear() reports empty synchronously.
test("right after a send, the first approval card still takes the caret", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  try {
    await pane.render(null);
    await pane.type("run the tests");
    assert.equal(pane.container.querySelector("[data-composer-draft]") !== null, true, "draft is marked");
    await act(async () => pane.composerRef.current.clear());
    assert.equal(pane.container.querySelector("[data-composer-draft]") === null, true, "mark cleared by clear()");
    await pane.render(approvalBar([item("c1", "Bash(npm test:*)")]));
    assert.equal(where(pane), "panel");
    await press("1");
    assert.deepEqual(decisions, ["c1:approve"]);
  } finally {
    await pane.unmount();
  }
});

test("clear() and the approval in the same tick: the card still takes the caret", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  try {
    await pane.render(null);
    await pane.type("run the tests");
    await pane.render(approvalBar([item("c1", "Bash(npm test:*)")]), () => pane.composerRef.current.clear());
    assert.equal(where(pane), "panel");
  } finally {
    await pane.unmount();
  }
});

// The P1 fix with the real editor: a draft keeps its caret, keystrokes stay text; a click
// into the card arms the shortcuts; answering gives the caret back with the draft intact.
test("a draft keeps the caret; clicking into the card arms it; the answer returns to the draft", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  try {
    await pane.render(null);
    await pane.type("use pnpm, see step ");
    await pane.render(approvalBar([item("c2", "Bash(rm:*)")]));
    assert.equal(where(pane), "editor", "the card did not take the caret from the draft");
    await press("2");
    await press("Enter");
    assert.deepEqual(decisions, [], "keys in the draft do not answer");
    await clickInside(pane.panel());
    await press("3");
    assert.deepEqual(decisions, ["c2:deny"]);
    await pane.render(null);
    assert.equal(where(pane), "editor", "the caret is back in the composer");
    assert.equal(pane.editor().textContent, "use pnpm, see step ", "draft intact");
  } finally {
    await pane.unmount();
  }
});

// Queue: answering the first of two keeps the slot mounted; the flag survives the card
// change and the last answer returns the caret.
test("two queued approvals answered by clicking: the caret comes back after the last one", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  try {
    await pane.render(null);
    await pane.type("x");
    await act(async () => pane.composerRef.current.clear());
    await pane.render(approvalBar([item("c1", "A"), item("c2", "B")]));
    await clickInside(pane.container.querySelector("[aria-keyshortcuts='Escape 3']"));
    await pane.render(approvalBar([item("c2", "B")]));
    assert.equal(where(pane), "panel", "the second card has the caret");
    await press("1");
    await pane.render(null);
    assert.deepEqual(decisions, ["c1:deny", "c2:approve"]);
    assert.equal(where(pane), "editor");
  } finally {
    await pane.unmount();
  }
});

// Tab / Shift+Tab out of the card to another control, then the approval goes away (remote
// answer): the caret stays where the user put it, even after that control is removed.
test("leaving the card with Tab clears the flag, even if the next control later goes away", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  const outside = document.body.appendChild(document.createElement("button"));
  try {
    await pane.render(null);
    await pane.render(approvalBar([item("c1", "A")]));
    assert.equal(where(pane), "panel");
    await act(async () => outside.focus());
    outside.remove();
    assert.equal(document.activeElement === document.body, true);
    await pane.render(null);
    assert.equal(where(pane), "body");
  } finally {
    outside.remove();
    await pane.unmount();
  }
});

// The ▾ menu (real base-ui Menu, portaled to <body>, outside the slot): "deny all" picked
// with the mouse answers every approval; the caret should come back like any other answer.
test("deny all from the ▾ menu gives the caret back to the composer", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  let decidedAll = "";
  const bar = (pending) =>
    React.createElement(ToolApprovalBar, {
      pending,
      onDecide: async () => ({ ok: true }),
      onDecideAll: async (decision) => {
        decidedAll = decision;
      },
    });
  try {
    await pane.render(null);
    await pane.render(bar([item("c1", "A"), item("c2", "B")]));
    assert.equal(where(pane), "panel");
    const trigger = pane.container.querySelector("[aria-label='chat.toolApproval.moreActions']");
    assert.equal(Boolean(trigger), true, "the ▾ trigger is rendered");
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const denyAll = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === "chat.toolApproval.denyAll",
    );
    assert.equal(Boolean(denyAll), true, "the menu opened with deny all");
    assert.equal(pane.container.contains(denyAll), false, "the menu is portaled outside the slot");
    await act(async () => {
      denyAll.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
      denyAll.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      denyAll.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
      denyAll.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      denyAll.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(decidedAll, "deny");
    await pane.render(null);
    assert.equal(where(pane), "editor");
  } finally {
    await pane.unmount();
  }
});

// A click on non-focusable text elsewhere (focus falls to body without any blur target).
test("a click on plain text outside the card clears the flag", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  const text = document.body.appendChild(document.createElement("p"));
  try {
    await pane.render(null);
    await pane.render(approvalBar([item("c1", "A")]));
    await act(async () => {
      text.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      document.activeElement?.blur();
    });
    await pane.render(null);
    assert.equal(where(pane), "body");
  } finally {
    text.remove();
    await pane.unmount();
  }
});
