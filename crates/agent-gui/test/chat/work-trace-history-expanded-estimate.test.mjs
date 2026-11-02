// AssistantWorkTrace mounts settled turns without an answer expanded, so the
// GUI row model must estimate those rows with their entries, not at the
// collapsed-header height (42px) used for answered turns.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const EmptyIcon = () => null;
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": { ChevronDown: EmptyIcon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "zh-CN", t: (key) => key }) },
    "@liveagent/ui/components/chat/LazyCollapse": {
      LazyCollapse: ({ children, open }) => (open ? children() : null),
    },
    "@liveagent/ui/components/chat/AssistantStatus": { LiveAssistantStatus: () => null },
    "@liveagent/ui/components/chat/RetryDetailsBlock": { RetryDetailsBlock: () => null },
    "@liveagent/ui/components/chat/assistant-bubble/RoundContent": {
      RoundBlockContent: (props) =>
        env.React.createElement("div", { "data-testid": "work-entry", "data-key": props.traceKey }),
    },
    "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils": {
      resolveActiveThinkingEntryKey: () => null,
      resolveActiveWorkEntry: () => null,
    },
  },
});
const { React, act, createRoot } = env;
const { AssistantBubbleUnit } = env.loadModule("src/pages/chat/components/AssistantBubble.tsx");

// Row model with the real layout resolver (separate loader, no mocks).
const { createTranscriptRowModel } = createTsModuleLoader().loadModule(
  "src/pages/chat/transcript/rowModel.ts",
);

const idleLive = {
  isSending: false,
  draftAssistantText: "",
  toolStatus: null,
  liveRounds: [],
  retryAttempts: [],
  isSettled: false,
};

function userItem(key) {
  return { kind: "user", key, segmentIndex: 0, text: "prompt", attachments: [], timestamp: 1, isFromCompactedSegment: false };
}
function assistantItem(key, rounds) {
  return { kind: "assistant", key, segmentIndex: 0, rounds, timestamp: 18_001, isFromCompactedSegment: false };
}
function tool(id, name) {
  return {
    kind: "tool",
    item: {
      toolCall: { type: "toolCall", id, name, arguments: {} },
      toolResult: { role: "toolResult", toolCallId: id, isError: false, content: [] },
    },
  };
}
function thinking(id, text) {
  return { kind: "thinking", id, text };
}
function text(id, value) {
  return { kind: "text", id, text: value };
}

// An interrupted run (queue run-now / Stop): only process, no closing answer.
const interruptedRounds = [
  { round: 1, key: "r1", blocks: [thinking("t1", "look around"), tool("read-1", "Read"), tool("read-2", "Read")] },
  { round: 2, key: "r2", blocks: [thinking("t2", "run tests"), tool("bash-1", "Bash")] },
  { round: 3, key: "r3", blocks: [thinking("t3", "patch"), tool("edit-1", "Edit")] },
];
const answeredRounds = [...interruptedRounds, { round: 4, key: "r4", blocks: [text("a", "done")], meta: { stopReason: "stop" } }];

function workTraceRows(snapshot) {
  return snapshot.rows
    .flatMap((row) => (row.kind === "assistant-activity" ? row.units : [row]))
    .filter((row) => row.kind === "assistant-unit" && row.unit.kind === "work-trace");
}

function renderUnit(root, row) {
  act(() => {
    root.render(
      React.createElement(AssistantBubbleUnit, {
        key: row.key,
        row,
        isCompactionRunning: false,
        toolStatus: null,
      }),
    );
  });
}

function mountHistoryTrace(rounds) {
  const snapshot = createTranscriptRowModel().build(
    [userItem("u1"), assistantItem("a1", rounds)],
    idleLive,
  );
  const row = workTraceRows(snapshot)[0];
  const container = document.createElement("div");
  const root = createRoot(container);
  renderUnit(root, row);
  const expanded = container.querySelector("button").getAttribute("aria-expanded") === "true";
  const mountedEntries = container.querySelectorAll('[data-testid="work-entry"]').length;
  act(() => root.unmount());
  return { row, expanded, mountedEntries };
}

test("work-trace: a settled no-answer trace that mounts expanded is estimated with its entries", () => {
  // Control: an answered history turn mounts collapsed, so 42px matches what renders.
  const answered = mountHistoryTrace(answeredRounds);
  assert.equal(answered.row.unit.hasAnswer, true);
  assert.equal(answered.expanded, false);
  assert.equal(answered.mountedEntries, 0);
  assert.equal(answered.row.estimate, 42);

  // Interrupted turn: the change makes it mount expanded with every entry rendered…
  const interrupted = mountHistoryTrace(interruptedRounds);
  assert.equal(interrupted.row.unit.hasAnswer, false);
  assert.equal(interrupted.expanded, true);
  assert.ok(interrupted.mountedEntries >= 4, `mounted ${interrupted.mountedEntries} entries`);

  // …so its row estimate must account for them. rowModel floors every block at
  // 36px (measureBlockUnit), the live formula is 42 + Σ entries; the settled row
  // still reports the collapsed 42px.
  const lowerBound = 42 + 36 * interrupted.mountedEntries;
  assert.ok(
    interrupted.row.estimate >= lowerBound,
    `estimate ${interrupted.row.estimate}px < ${lowerBound}px for an expanded trace with ${interrupted.mountedEntries} entries`,
  );
});

test("work-trace: live → settled alias keeps the instance; no-answer stays open, answered collapses once", () => {
  for (const [rounds, expectedAfterSettle] of [
    [interruptedRounds, "true"],
    [answeredRounds, "false"],
  ]) {
    const model = createTranscriptRowModel();
    const history = [userItem("u1")];
    const liveRounds = rounds.map((round) => ({ ...round, runningToolCallIds: [], thinkingOpen: false, meta: undefined }));
    const streaming = model.build(history, { ...idleLive, isSending: true, liveRounds });
    const liveRow = workTraceRows(streaming)[0];
    assert.equal(liveRow.live, true);

    const container = document.createElement("div");
    const root = createRoot(container);
    renderUnit(root, liveRow);
    const button = container.querySelector("button");
    assert.equal(button.getAttribute("aria-expanded"), "true", "running trace starts open");

    const settled = model.build([userItem("u1"), assistantItem("a1", rounds)], idleLive);
    const settledRow = workTraceRows(settled)[0];
    assert.equal(settledRow.key, liveRow.key, "history twin aliases the live key");
    assert.equal(settledRow.live, false);
    renderUnit(root, settledRow);
    assert.equal(container.querySelector("button"), button, "zero remount");
    assert.equal(button.getAttribute("aria-expanded"), expectedAfterSettle);
    act(() => root.unmount());
  }
});

test.after(() => env.cleanup());
