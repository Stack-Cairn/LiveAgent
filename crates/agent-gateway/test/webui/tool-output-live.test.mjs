import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

// `tool_output` carries the full latest running-output snapshot of a tool call.
// It replaces the previous snapshot, decorates only a known call without a
// result, and is never persisted (history entries never carry it).
const loader = createWebModuleLoader();
const { createTurn, applyEventToTurn } = loader.loadModule(
  "src/lib/chat/transcript/turnReducer.ts",
);
const { buildTurnRows } = loader.loadModule("src/lib/chat/transcript/rows.ts");

const call = { type: "tool_call", id: "bash-1", name: "Bash", arguments: { command: "make" }, round: 1 };
const output = (text, id = "bash-1") => ({ type: "tool_output", id, output: text, round: 1 });
const result = {
  type: "tool_result",
  id: "bash-1",
  name: "Bash",
  content: [{ type: "text", text: "done" }],
  isError: false,
  round: 1,
};

function reduce(events) {
  let turn = createTurn({ key: "req:live", runId: "run-live", phase: "streaming" });
  for (const event of events) turn = applyEventToTurn(turn, event);
  return turn;
}

function toolItem(turn) {
  const assistant = buildTurnRows(turn).find((row) => row.kind === "assistant");
  return assistant?.rounds.flatMap((round) => round.blocks).find((block) => block.kind === "tool")
    ?.item;
}

test("tool_output replaces the running card snapshot instead of appending", () => {
  const turn = reduce([call, output("step 1\n"), output("step 1\nstep 2\n")]);
  assert.equal(toolItem(turn).liveOutput, "step 1\nstep 2\n");
  assert.equal(turn.entries.filter((entry) => entry.kind === "tool_call").length, 1);
  // A repeated snapshot is a no-op that keeps the turn identity.
  assert.equal(applyEventToTurn(turn, output("step 1\nstep 2\n")), turn);
});

test("tool_output is ignored for unknown calls and once the call has a result", () => {
  const unknown = reduce([call]);
  assert.equal(applyEventToTurn(unknown, output("stray", "other")), unknown);
  assert.equal(applyEventToTurn(createTurn({ key: "req:x" }), output("x")).entries.length, 0);

  const settled = reduce([call, output("step 1\n"), result]);
  assert.equal(applyEventToTurn(settled, output("late")), settled);
  const item = toolItem(settled);
  assert.equal(Boolean(item.toolResult), true);
  assert.equal(item.liveOutput, undefined, "the result supersedes the live snapshot");
});

test("a replayed K-brain run keeps one tool row through approval, live output and result", () => {
  // The relayed wire events of one approved Bash run (K-brain v0.107.24, "Always ask"):
  // the call, the approval marker and its resolution as call updates, the running
  // snapshots, then the result. A direct-link reconnect replays them from the start.
  const id = "bash-approved";
  const args = { command: "for i in 1 2 3 4 5; do echo $i; sleep 1; done" };
  const wire = [
    { type: "tool_call", id, name: "Bash", arguments: args, round: 1 },
    {
      type: "tool_call",
      id,
      name: "Bash",
      arguments: { ...args, __toolApprovalPending: true, __toolApprovalSummary: args.command },
      round: 1,
    },
    { type: "tool_status", status: "Waiting for permission…" },
    { type: "tool_call", id, name: "Bash", arguments: args, round: 1 },
    { type: "tool_status", status: null },
    output("1\n", id),
    output("1\n2\n", id),
  ];
  const finished = {
    ...result,
    id,
    content: [{ type: "text", text: "1\n2\n3\n4\n5\n" }],
    details: { kbrainRun: { durationMs: 5046, exitCode: 0 } },
  };
  const toolRows = (turn) => {
    const assistant = buildTurnRows(turn).find((row) => row.kind === "assistant");
    const rounds = assistant?.rounds ?? [];
    return {
      blocks: rounds.flatMap((round) => round.blocks).filter((block) => block.kind === "tool"),
      running: rounds.flatMap((round) => round.runningToolCallIds ?? []),
    };
  };

  const live = reduce([...wire, ...wire, output("1\n2\n3\n", id)]);
  const liveRows = toolRows(live);
  assert.deepEqual(liveRows.blocks.map((block) => block.item.toolCall.id), [id]);
  assert.deepEqual(liveRows.running, [id]);
  assert.equal(liveRows.blocks[0].item.liveOutput, "1\n2\n3\n");

  const settled = reduce([...wire, finished, ...wire, finished]);
  const settledRows = toolRows(settled);
  assert.deepEqual(settledRows.blocks.map((block) => block.item.toolCall.id), [id]);
  assert.deepEqual(settledRows.running, []);
  assert.equal(Boolean(settledRows.blocks[0].item.toolResult), true);
  assert.equal(settled.entries.filter((entry) => entry.kind === "tool_call").length, 1);
});
