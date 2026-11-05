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
