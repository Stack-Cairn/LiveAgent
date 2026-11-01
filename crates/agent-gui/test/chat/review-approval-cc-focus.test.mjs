import assert from "node:assert/strict";
import test from "node:test";
import React0 from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Review of the Claude-Code-style approval card (feat-approval-card-cc): the real
// ChatComposerBar hosting the real ToolApprovalBar in its approvalBar slot, the way
// ConversationPaneHost (GUI) and useGatewayChatPresentation / GatewayConversationPaneHost
// (WebUI) wire it. MentionComposer is replaced by a plain textarea so the caret is real.
// Assertions compare strings and booleans only.

const svgIcons = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule"
        ? true
        : (props) => React0.createElement("svg", { className: props?.className }),
  },
);
const composerPropsById = new Map();
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": svgIcons,
    "@liveagent/ui/components/chat/fileTypeIcons": svgIcons,
    "@liveagent/ui/components/chat/MentionComposer": {
      MentionComposer: (props) => {
        composerPropsById.set(props.currentConversationId, props);
        return React0.createElement("textarea", {
          "data-test-composer": props.currentConversationId,
          ref: (el) => {
            if (!props.ref) return;
            props.ref.current = el
              ? {
                  focus: () => el.focus(),
                  getDraft: () => ({ segments: [{ type: "text", text: el.value }] }),
                }
              : null;
          },
        });
      },
    },
  },
});
const { React, act, createRoot } = env;
const doc = env.dom.window.document;
const { ChatComposerBar } = env.loadModule("@liveagent/ui/pages/chat/ChatComposerBar.tsx");
const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
const noop = () => {};

function mountPane(conversationId) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const composerRef = { current: null };
  const render = async (approvalBar) => {
    const props = {
      surface: "desktop",
      conversationId,
      composerRef,
      isSending: true,
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
      root.render(
        React.createElement(
          LocaleContext.Provider,
          { value: { locale: "en-US", t: (key) => translate(key, "en-US") } },
          React.createElement(ChatComposerBar, props),
        ),
      );
    });
  };
  const textarea = () => container.querySelector(`[data-test-composer="${conversationId}"]`);
  const panel = () => container.querySelector("[aria-keyshortcuts='Escape 3']")?.closest("section") ?? null;
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { render, textarea, panel, unmount };
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

const npmTest = {
  toolCallId: "c1",
  toolName: "Bash",
  summary: "npm test",
  allowSession: true,
  sessionScope: "Bash(npm test:*)",
  rememberRules: ["Bash(npm test:*)"],
  defaultScope: "project",
};
// What the model tries right after being told "no": another command, another approval.
const rmRf = {
  toolCallId: "c2",
  toolName: "Bash",
  summary: "rm -rf build && npm run build",
  allowSession: true,
  sessionScope: "Bash(rm:*)",
  rememberRules: ["Bash(rm:*)"],
  defaultScope: "project",
};

async function press(key) {
  const target = doc.activeElement;
  await act(async () => {
    target.dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function typeIntoComposer(pane, conversationId, text) {
  const el = pane.textarea();
  await act(async () => {
    el.value = text;
    el.dispatchEvent(new env.dom.window.Event("input", { bubbles: true }));
    composerPropsById.get(conversationId)?.onEmptyChange?.(text.length === 0);
  });
}

// Design doc 2026-10-31-approval-experience.md §2.6: "按键只在卡片有焦点或输入框为空时生效，
// 不抢正在输入的文字" and the test list: "输入框有文字时数字键不触发". The deny now hands the
// caret to the composer so the user writes what to do next; when the turn goes on and the
// model's next tool call needs approval mid-sentence, the card takes the caret from the
// half-written draft and the user's next keystrokes answer it.
for (const [key, expected] of [
  ["2", "c2:approve_session:project"],
  ["Enter", "c2:approve"],
]) {
  test(`after a deny, ${key} typed into the composer draft does not answer the next approval (${expected})`, async () => {
    decisions.length = 0;
    const pane = mountPane("conv-a");
    try {
      await pane.render(approvalBar([npmTest]));
      assert.equal(doc.activeElement === pane.panel(), true, "the first card has the caret");
      await press("3");
      assert.deepEqual(decisions, ["c1:deny"]);
      await pane.render(null);
      assert.equal(doc.activeElement === pane.textarea(), true, "the composer has the caret back");

      await typeIntoComposer(pane, "conv-a", "use pnpm instead, see step ");
      // The model's next attempt arrives while the user is still writing.
      await pane.render(approvalBar([rmRf]));
      await press(key);

      assert.deepEqual(
        decisions,
        ["c1:deny"],
        `a ${key} meant for the draft answered the next approval`,
      );
    } finally {
      await pane.unmount();
    }
  });
}

// Risk 1 (verification, expected to pass): with two approvals queued, answering the first
// keeps the bar mounted, so the composer must not take the caret and the next card keeps
// the shortcuts.
test("answering the first of two queued approvals keeps the caret on the card", async () => {
  decisions.length = 0;
  const pane = mountPane("conv-a");
  try {
    await pane.render(approvalBar([npmTest, rmRf]));
    await press("3");
    await pane.render(approvalBar([rmRf]));
    assert.equal(doc.activeElement === pane.panel(), true, "the second card has the caret");
    assert.equal(doc.activeElement === pane.textarea(), false);
    await press("1");
    assert.deepEqual(decisions, ["c1:deny", "c2:approve"]);
  } finally {
    await pane.unmount();
  }
});

// Two panes (GUI workbench / WebUI GatewayConversationPaneHost). The user works in pane B
// and clicks on transcript text there (focus falls to <body>). Pane A's approval then goes
// away without the user touching it (answered from the other client of a mirrored session,
// run stopped, timeout). Pane A's composer takes the caret although its approval bar never
// held it at that point, so the user's next keystrokes land in a pane they are not using.
test("an approval that goes away while the user is elsewhere does not pull the caret into its pane", async () => {
  decisions.length = 0;
  const paneA = mountPane("conv-a");
  const paneB = mountPane("conv-b");
  try {
    await paneA.render(approvalBar([npmTest]));
    await paneB.render(null);
    // The user moves to pane B, types, then clicks on its transcript text.
    paneB.textarea().focus();
    paneB.textarea().blur();
    assert.equal(doc.activeElement === doc.body, true, "focus is on nothing in pane B");

    await paneA.render(null);

    assert.equal(
      doc.activeElement?.getAttribute?.("data-test-composer") ?? "body",
      "body",
      "pane A's composer took the caret",
    );
  } finally {
    await paneA.unmount();
    await paneB.unmount();
  }
});
