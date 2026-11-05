import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// K-brain sends tool.call before question.requested; AI review or an approval can
// sit in between. The card must not be answerable until the host has the question
// pending, or a submit only gets "Question is not pending".

// Assertions compare strings and booleans, never DOM nodes.
async function renderRunningAsk({ pending, deadlineAt }) {
  const icons = new Proxy({}, { get: () => () => null });
  const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));
  const cards = [];
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [iconPath]: icons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/ui/components/Markdown": { Markdown: () => null },
    "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: () => null },
    "@liveagent/ui/components/chat/FileToolArgs": { FileToolArgsDisplay: () => null },
    "@liveagent/ui/components/chat/AskUserQuestionCard": {
      AskUserQuestionCard: (props) => {
        cards.push({ interactive: props.interactive, deadlineAt: props.deadlineAt });
        return null;
      },
    },
    "@liveagent/ui/components/chat/PlanModeCard": { PlanModeCard: () => null },
    "@liveagent/adapters/assistantBubble": {
      readAskUserQuestionDeadline: () => deadlineAt,
      useAskUserQuestionPending: () => pending,
      usePlanDecisionState: () => ({ pending: false, approved: false }),
      retainRunningToolContent: false,
      submitAskUserQuestionAnswers() {},
      submitPlanDecision() {},
      usePendingToolApproval: () => false,
      usePermissionAutoResolved: () => null,
      deferLargeToolImages: false,
    },
  } });
  const { MemoToolCallItem } = env.loadModule("@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const item = {
    toolCall: {
      type: "toolCall",
      id: "call-ask",
      name: "AskUserQuestion",
      arguments: { questions: [{ id: "q1", prompt: "Pick one", options: [{ label: "A" }, { label: "B" }] }] },
    },
  };
  await env.act(async () => root.render(env.React.createElement(MemoToolCallItem, { item, isRunning: true })));
  const text = host.textContent;
  await env.act(async () => root.unmount());
  host.remove();
  env.cleanup();
  return { card: cards.at(-1), text };
}

test("a running question the host has not registered is shown but not answerable", async () => {
  const { card, text } = await renderRunningAsk({ pending: false, deadlineAt: 123 });
  assert.equal(card?.interactive, false);
  assert.equal(card?.deadlineAt, undefined);
  assert.match(text, /chat\.askUser\.preparing/);
  assert.doesNotMatch(text, /chat\.askUser\.waiting/);
});

test("a registered question is answerable with the host deadline", async () => {
  const { card, text } = await renderRunningAsk({ pending: true, deadlineAt: 123 });
  assert.equal(card?.interactive, true);
  assert.equal(card?.deadlineAt, 123);
  assert.match(text, /chat\.askUser\.waiting/);
});

test("the desktop adapter follows its pending table and WebUI follows the synced marker", () => {
  const react = { useSyncExternalStore: (_subscribe, get) => get() };
  const gui = createTsModuleLoader({ mocks: { react } });
  const askTools = gui.loadModule("src/lib/tools/askUserQuestionTools.ts");
  const guiAdapter = gui.loadModule("src/agent-ui-adapters/assistantBubble.ts");
  assert.equal(guiAdapter.useAskUserQuestionPending("gui-ask", {}), false);
  const controller = new AbortController();
  const pending = askTools.requestBackendQuestion({
    toolCallId: "gui-ask",
    conversationId: "conv-gui",
    questions: [{ id: "q1", prompt: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    deadlineAt: Date.now() + 60_000,
    signal: controller.signal,
  });
  assert.equal(guiAdapter.useAskUserQuestionPending("gui-ask", {}), true);
  controller.abort();
  pending.catch(() => undefined);
  assert.equal(guiAdapter.useAskUserQuestionPending("gui-ask", {}), false);

  const web = createTsModuleLoader({ rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)), mocks: { react } });
  const webAdapter = web.loadModule("src/agent-ui-adapters/assistantBubble.ts");
  assert.equal(webAdapter.useAskUserQuestionPending("x", { __askUserQuestionPending: false }), false);
  assert.equal(webAdapter.useAskUserQuestionPending("x", { __askUserQuestionPending: true }), true);
  // Desktops without the marker keep the old behavior.
  assert.equal(webAdapter.useAskUserQuestionPending("x", { questions: [] }), true);
});
