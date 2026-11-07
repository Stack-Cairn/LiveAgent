import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// One K-brain tool call is one running row for its whole life: requested, awaiting
// approval, running with live output, finished, and after a reconnect replays the
// run's events. The events go through the real K-brain turn, the live round helpers,
// the round grouping and the real tool batch and tool row components.

// Assertions compare strings and numbers, never DOM nodes: a failing assert would
// try to print a whole jsdom tree.
const icons = new Proxy({}, { get: () => () => null });
const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));
const pendingApprovals = new Set();
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [iconPath]: icons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/ui/components/Markdown": { Markdown: () => null },
    "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: () => null },
    "@liveagent/ui/components/chat/FileToolArgs": { FileToolArgsDisplay: () => null },
    "@liveagent/ui/components/chat/AskUserQuestionCard": { AskUserQuestionCard: () => null },
    "@liveagent/ui/components/chat/PlanModeCard": { PlanModeCard: () => null },
    "@liveagent/ui/components/chat/AssistantStatus": {
      AssistantStatus: ({ children }) => children,
    },
    "@liveagent/ui/components/chat/LazyCollapse": {
      LazyCollapse: ({ children, open }) => (open ? children() : null),
    },
    "@liveagent/adapters/assistantBubble": {
      readAskUserQuestionDeadline: () => undefined,
      useAskUserQuestionPending: () => false,
      usePlanDecisionState: () => ({ pending: false, approved: false }),
      retainRunningToolContent: false,
      submitAskUserQuestionAnswers() {},
      submitPlanDecision() {},
      usePendingToolApproval: (id) => pendingApprovals.has(id),
      usePermissionAutoResolved: () => null,
      useSubagentCard: () => null,
      deferLargeToolImages: false,
    },
  },
});
const { React, act, createRoot } = env;
const { ToolTraceGroup } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ToolTraceGroup.tsx",
);
const { groupRoundBlocks } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);

const loader = createTsModuleLoader();
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const { attachToolResultToRound, setToolLiveOutputInRound, upsertToolCallToRound } =
  loader.loadModule("src/lib/chat/messages/uiMessages.ts");

const COMMAND = "for i in 1 2 3 4 5; do echo $i; sleep 1; done";

function sse(seq, type, payload) {
  return `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", seq, type, payload })}\n\n`;
}

// The run as K-brain v0.107.24 sends it under "Always ask": the call, its approval,
// running snapshots that replace each other, then the result.
const runEvents = [
  ["tool.call", { tool_call: { id: "bash-1", name: "Bash", arguments: { command: COMMAND } } }],
  [
    "permission.requested",
    { permission_id: "perm-1", tool: "Bash", command: COMMAND, tool_call_id: "bash-1" },
  ],
  ["permission.resolved", { permission_id: "perm-1", decision: "allow_once" }],
  ["tool.status", { tool_call_id: "bash-1", status: "running", message: "1\n" }],
  ["tool.status", { tool_call_id: "bash-1", status: "running", message: "1\n2\n" }],
  ["tool.status", { tool_call_id: "bash-1", status: "running", message: "1\n2\n3\n" }],
  [
    "tool.result",
    {
      tool_result: {
        id: "bash-1",
        name: "Bash",
        output: "1\n2\n3\n4\n5\n",
        exit_code: 0,
        duration_ms: 5012,
      },
    },
  ],
  ["assistant.text.delta", { text: "done" }],
  ["run.completed", {}],
].map(([type, payload], index) => ({ seq: index + 2, type, payload }));

// Drives one K-brain turn into a live round the way the desktop chat does, and keeps
// the round after every event the UI would have rendered. Each subscription serves
// the next list of events from after_seq on, as K-brain does, then closes.
async function runTurn(eventStreams) {
  const subscriptions = [];
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/v1/sessions") return Response.json({ id: "s" });
    if (pathname === "/v1/health") return Response.json({});
    if (pathname.endsWith("/runs"))
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 });
    if (pathname.includes("/permissions/") && init?.method === "POST") return Response.json({});
    if (pathname.endsWith("/events")) {
      const afterSeq = Number(searchParams.get("after_seq"));
      subscriptions.push(afterSeq);
      const events = eventStreams[subscriptions.length - 1];
      if (events === undefined) throw new Error("no more event streams");
      const body = events
        .filter((event) => event.seq > afterSeq)
        .map((event) => sse(event.seq, event.type, event.payload))
        .join("");
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected request ${pathname}`);
  };

  let round = { round: 1, key: "r1", blocks: [], runningToolCallIds: [] };
  const snapshots = [];
  const update = (stage, apply) => {
    round = apply(round);
    snapshots.push({ stage, round });
  };
  const result = await runKBrainTurn({
    baseUrl: "http://fixture.test",
    fetch,
    model: { provider: "fixture", model: "test" },
    sessionId: "frontend",
    conversationId: "single-row",
    cwd: "/tmp",
    context: { messages: [] },
    prompt: "run the counter",
    signal: new AbortController().signal,
    onStatus() {},
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall: (call) =>
      update("call", (target) => ({
        ...upsertToolCallToRound(target, call),
        runningToolCallIds: [...new Set([...target.runningToolCallIds, call.id])],
      })),
    onToolOutput: (id, output) =>
      update("output", (target) => setToolLiveOutputInRound(target, id, output)),
    onToolResult: (call, toolResult) =>
      update("result", (target) => ({
        ...attachToolResultToRound(target, call, toolResult),
        runningToolCallIds: target.runningToolCallIds.filter((id) => id !== call.id),
      })),
    onPermissionRequest: async (request) => {
      pendingApprovals.add(request.tool_call_id);
      snapshots.push({ stage: "approval", round });
      pendingApprovals.delete(request.tool_call_id);
      return "allow_once";
    },
  });
  return { result, snapshots, subscriptions };
}

function countMatches(text, pattern) {
  return text.split(pattern).length - 1;
}

// Renders the round as the transcript does and reads what the reader sees, with the
// tool batch collapsed and then expanded.
function renderRound(round, { approvalPending = false } = {}) {
  if (approvalPending) pendingApprovals.add("bash-1");
  try {
    const groups = groupRoundBlocks(round.blocks);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          groups.map((group) =>
            React.createElement(ToolTraceGroup, {
              key: group.key,
              items: group.items,
              runningToolCallIds: round.runningToolCallIds,
              showTurnStatus: true,
            }),
          ),
        ),
      ),
    );
    const read = () => {
      const text = host.textContent;
      return {
        running: countMatches(text, "chat.tool.running"),
        waitingApproval: countMatches(text, "chat.toolApproval.waitingStatus"),
        headerNamesCommand: countMatches(
          host.querySelector("button[aria-expanded]")?.textContent ?? "",
          COMMAND,
        ),
      };
    };
    const collapsed = read();
    const header = host.querySelector("button[aria-expanded]");
    act(() => header.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const expanded = {
      ...read(),
      rows: host.querySelectorAll("[data-tool-trace-scroll] > *").length,
    };
    act(() => root.unmount());
    host.remove();
    return { groups: groups.map((group) => [group.kind, group.items.map((item) => item.toolCall.id)]), collapsed, expanded };
  } finally {
    pendingApprovals.delete("bash-1");
  }
}

test.after(() => env.cleanup());

test("a running K-brain command shows one running row, collapsed or expanded", async () => {
  const { result, snapshots } = await runTurn([runEvents]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.stage),
    ["call", "approval", "output", "output", "output", "result"],
  );

  for (const { stage, round } of snapshots) {
    assert.equal(round.blocks.length, 1, `${stage}: one block for bash-1`);
    const view = renderRound(round, { approvalPending: stage === "approval" });
    assert.deepEqual(view.groups, [["toolGroup", ["bash-1"]]], stage);
    assert.equal(view.expanded.rows, 1, `${stage}: one row inside the batch`);

    if (stage === "result") {
      assert.deepEqual(view.collapsed, { running: 0, waitingApproval: 0, headerNamesCommand: 0 });
      assert.equal(view.expanded.running, 0);
      continue;
    }
    // Collapsed, the batch header stands in for the call.
    assert.equal(view.collapsed.running, 1, `${stage}: collapsed status`);
    assert.equal(view.collapsed.headerNamesCommand, 1, `${stage}: collapsed header`);
    // Expanded, the call's own row carries its status and the header no longer
    // repeats the running command.
    assert.equal(view.expanded.headerNamesCommand, 0, `${stage}: expanded header`);
    if (stage === "approval") {
      assert.equal(view.expanded.waitingApproval, 1, "approval: the row waits");
      assert.equal(view.expanded.running, 0, "approval: nothing else says running");
    } else {
      assert.equal(view.expanded.running, 1, `${stage}: one running status`);
    }
  }

  const live = snapshots.findLast((snapshot) => snapshot.stage === "output").round;
  assert.equal(live.blocks[0].item.liveOutput, "1\n2\n3\n");
});

test("a reconnect that replays the run keeps one block and one running row", async () => {
  // The first stream drops right after the first running snapshot; the turn
  // resubscribes from the last seq it saw and K-brain replays the rest of the run.
  const { result, snapshots, subscriptions } = await runTurn([runEvents.slice(0, 4), runEvents]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(subscriptions, [1, 5]);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.stage),
    ["call", "approval", "output", "output", "output", "result"],
  );

  for (const { stage, round } of snapshots) {
    assert.equal(round.blocks.length, 1, `${stage}: one block for bash-1`);
    assert.deepEqual(round.runningToolCallIds, stage === "result" ? [] : ["bash-1"], stage);
    const view = renderRound(round, { approvalPending: stage === "approval" });
    assert.equal(view.expanded.rows, 1, `${stage}: one row inside the batch`);
    if (stage === "output") {
      assert.equal(view.collapsed.running, 1, `${stage}: collapsed status`);
      assert.equal(view.expanded.running, 1, `${stage}: expanded status`);
    }
  }

  // A client that applies the replayed call and snapshots again (history reload over a
  // live round) still updates the one block in place.
  const settled = snapshots.at(-1).round;
  const call = { type: "toolCall", id: "bash-1", name: "Bash", arguments: { command: COMMAND } };
  const reapplied = setToolLiveOutputInRound(upsertToolCallToRound(settled, call), "bash-1", "1\n");
  assert.equal(reapplied.blocks.length, 1);
  assert.ok(reapplied.blocks[0].item.toolResult, "the result stays attached");
});
