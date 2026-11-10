import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// A K-brain `subagent` call renders as one subagent card once the host links it,
// and as the plain tool row when it cannot (older backends, WebUI).

// Assertions compare strings and booleans, never DOM nodes.
const icons = new Proxy({}, { get: () => () => null });
const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));

function adapter(binding) {
  return {
    readAskUserQuestionDeadline: () => undefined,
    useAskUserQuestionPending: () => false,
    usePlanDecisionState: () => ({ pending: false, approved: false }),
    retainRunningToolContent: false,
    submitAskUserQuestionAnswers() {},
    submitPlanDecision() {},
    usePendingToolApproval: () => false,
    usePermissionAutoResolved: () => null,
    deferLargeToolImages: false,
    useSubagentCard: (id) => (id === "call-1" ? binding : null),
  };
}

async function render(element, binding) {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": icons,
      [iconPath]: icons,
      // Keys keep their placeholder so counts stay visible.
      "@liveagent/ui/i18n/index": {
        useLocale: () => ({ locale: "en-US", t: (key) => `${key}({count})` }),
      },
      "@liveagent/ui/components/Markdown": { Markdown: () => null },
      "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: () => null },
      "@liveagent/ui/components/chat/FileToolArgs": { FileToolArgsDisplay: () => null },
      "@liveagent/ui/components/chat/AskUserQuestionCard": { AskUserQuestionCard: () => null },
      "@liveagent/ui/components/chat/PlanModeCard": { PlanModeCard: () => null },
      "@liveagent/adapters/assistantBubble": adapter(binding),
    },
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => root.render(element(env)));
  return {
    host,
    env,
    async cleanup() {
      await env.act(async () => root.unmount());
      host.remove();
      env.cleanup();
    },
  };
}

const item = (id) => ({
  toolCall: { type: "toolCall", id, name: "subagent", arguments: { description: "Survey" } },
});

const runningView = {
  id: "task-1",
  description: "Survey the parser",
  status: "running",
  model: "fixture-model",
  startedAtMs: Date.now() - 65_000,
  tokens: 1500,
  toolCount: 3,
  latestTool: { name: "Read", arguments: { path: "src/parser.go" } },
};

test("a linked subagent call is one card that opens the subagent", async () => {
  let opened = 0;
  const binding = { view: runningView, open: () => (opened += 1) };
  const toolCall = (env) => {
    const { MemoToolCallItem } = env.loadModule(
      "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
    );
    return env.React.createElement(MemoToolCallItem, { item: item("call-1"), isRunning: true });
  };
  const { host, env, cleanup } = await render(toolCall, binding);
  try {
    const card = host.querySelector("[data-subagent-card]");
    assert.equal(card?.getAttribute("data-subagent-card"), "task-1");
    const text = card.textContent;
    assert.ok(text.includes("Survey the parser"));
    assert.ok(text.includes("fixture-model"));
    // Elapsed time counts from startedAtMs, so a slow runner adds a few seconds.
    assert.match(text, /1m \d\ds/);
    assert.ok(text.includes("1.5k"), text);
    assert.ok(text.includes("Read · src/parser.go"), text);
    assert.ok(text.includes("chat.tool.running"));
    await env.act(async () => card.click());
    assert.equal(opened, 1);
  } finally {
    await cleanup();
  }
});

test("an unlinked subagent call, or a redacted one, keeps the plain tool row", async () => {
  const binding = { view: runningView, open() {} };
  for (const props of [{ item: item("call-2") }, { item: item("call-1"), redactToolContent: true }]) {
    const { host, cleanup } = await render((env) => {
      const { MemoToolCallItem } = env.loadModule(
        "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
      );
      return env.React.createElement(MemoToolCallItem, props);
    }, binding);
    try {
      assert.equal(host.querySelector("[data-subagent-card]"), null);
      assert.ok(host.textContent.length > 0);
    } finally {
      await cleanup();
    }
  }
});

test("the pane lists running subagents first and stops the one in front", async () => {
  const ended = { id: "task-0", description: "Old survey", status: "done", durationMs: 8_000 };
  const calls = [];
  const pane = (env) => {
    const { SubagentPane } = env.loadModule("@liveagent/ui/components/subagents/SubagentPane.tsx");
    return env.React.createElement(SubagentPane, {
      tabs: [runningView],
      activeId: null,
      directory: { running: [runningView], ended: [ended], endedTotal: 1, hasMoreEnded: false },
      onShowDirectory: () => calls.push("directory"),
      onSelectTab: (id) => calls.push(`select:${id}`),
      onCloseTab: (id) => calls.push(`close:${id}`),
      onClose: () => calls.push("close-pane"),
      onShowMore() {},
      onStop: async (id) => calls.push(`stop:${id}`),
      onRetryTranscript() {},
    });
  };
  const { host, env, cleanup } = await render(pane, null);
  try {
    const rows = [...host.querySelectorAll("[data-subagent-row]")].map((row) =>
      row.getAttribute("data-subagent-row"),
    );
    assert.deepEqual(rows, ["task-1", "task-0"]);
    await env.act(async () => host.querySelector('[data-subagent-row="task-0"]').click());
    assert.deepEqual(calls, ["select:task-0"]);
  } finally {
    await cleanup();
  }

  const open = (env) => {
    const { SubagentPane } = env.loadModule("@liveagent/ui/components/subagents/SubagentPane.tsx");
    return env.React.createElement(SubagentPane, {
      tabs: [runningView],
      activeId: "task-1",
      directory: { running: [runningView], ended: [], endedTotal: 0, hasMoreEnded: false },
      transcript: { status: "loading", items: [] },
      onShowDirectory() {},
      onSelectTab() {},
      onCloseTab() {},
      onClose() {},
      onShowMore() {},
      onStop: async (id) => calls.push(`stop:${id}`),
      onRetryTranscript() {},
    });
  };
  const second = await render(open, null);
  try {
    assert.ok(second.host.textContent.includes("chat.subagent.pane.loading"));
    await second.env.act(async () =>
      second.host.querySelector('[data-subagent-stop="task-1"]').click(),
    );
    assert.deepEqual(calls.at(-1), "stop:task-1");
  } finally {
    await second.cleanup();
  }
});

test("a subagent running in kn offers no stop button; the pane says to stop it there", async () => {
  const external = { ...runningView, external: true };
  const pane = (env) => {
    const { SubagentPane } = env.loadModule("@liveagent/ui/components/subagents/SubagentPane.tsx");
    return env.React.createElement(SubagentPane, {
      tabs: [external],
      activeId: "task-1",
      directory: { running: [external], ended: [], endedTotal: 0, hasMoreEnded: false },
      transcript: { status: "ready", items: [] },
      onShowDirectory() {},
      onSelectTab() {},
      onCloseTab() {},
      onClose() {},
      onShowMore() {},
      onStop: async () => assert.fail("an external subagent cannot be stopped here"),
      onRetryTranscript() {},
    });
  };
  const { host, cleanup } = await render(pane, null);
  try {
    assert.equal(host.querySelector('[data-subagent-stop="task-1"]'), null);
    const note = host.querySelector('[data-subagent-external="task-1"]');
    assert.ok(note?.textContent.includes("chat.subagent.pane.external"));
  } finally {
    await cleanup();
  }
});

test("the running chip counts subagents and hides at zero", async () => {
  let opened = 0;
  const chip = (count) => (env) => {
    const { SubagentRunningChip } = env.loadModule(
      "@liveagent/ui/components/subagents/SubagentPane.tsx",
    );
    return env.React.createElement(SubagentRunningChip, { count, onOpen: () => (opened += 1) });
  };
  const shown = await render(chip(2), null);
  try {
    const button = shown.host.querySelector("[data-subagent-running-chip]");
    assert.ok(button);
    await shown.env.act(async () => button.click());
    assert.equal(opened, 1);
  } finally {
    await shown.cleanup();
  }
  const hidden = await render(chip(0), null);
  try {
    assert.equal(hidden.host.querySelector("[data-subagent-running-chip]"), null);
  } finally {
    await hidden.cleanup();
  }
});

test("the latest child tool names what it searched for, and one tool is singular", async () => {
  const { env, cleanup } = await render((env) => env.React.createElement("div"), null);
  try {
    const { subagentLatestToolText, subagentMetaParts } = env.loadModule(
      "@liveagent/ui/components/chat/assistant-bubble/SubagentToolCard.tsx",
    );
    const text = (name, args) => subagentLatestToolText({ latestTool: { name, arguments: args } });
    assert.match(text("Grep", { pattern: "garden", path: "." }), / · garden$/);
    assert.match(text("Read", { path: "notes.txt" }), / · notes\.txt$/);
    assert.equal(text("Read", {}).includes("·"), false);
    const t = (key) => key;
    assert.deepEqual(subagentMetaParts({ status: "done", toolCount: 1 }, 0, t), ["chat.subagent.toolCountOne"]);
    assert.deepEqual(subagentMetaParts({ status: "done", toolCount: 3 }, 0, t), ["chat.subagent.toolCount"]);
  } finally {
    await cleanup();
  }
});
