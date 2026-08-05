import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentToolCall,
  createAssistant,
  createSubagentHarness,
  createToolResult,
} from "./harness.mjs";

/**
 * Drives runAssistantWithTools like the real runner: emittedMessages grows
 * cumulatively from the request baseline and onBeforeNextTurn fires at every
 * turn boundary.
 */
function createMultiRoundRunner(options = {}) {
  const roundCount = options.rounds ?? 2;
  return async (params) => {
    const emitted = [];
    for (let round = 1; round <= roundCount; round += 1) {
      params.onTurnStart?.(round);
      const assistant = createAssistant(`round-${round} tool use`, { stopReason: "toolUse" });
      const toolResult = createToolResult(`call-${round}`, "Read", `tool output ${round}`);
      emitted.push(assistant, toolResult);
      await params.onBeforeNextTurn?.({
        round,
        assistant,
        toolResults: [toolResult],
        runtimeContext: params.context,
        emittedMessages: [...emitted],
        signal: params.signal,
      });
      if (options.repeatBoundary && round === 1) {
        // A second boundary with no new messages (e.g. a retried turn).
        await params.onBeforeNextTurn?.({
          round,
          assistant,
          toolResults: [],
          runtimeContext: params.context,
          emittedMessages: [...emitted],
          signal: params.signal,
        });
      }
      if (options.throwAfterRound === round) {
        throw options.error ?? new Error("boom");
      }
    }
    const finalAssistant = createAssistant("final report");
    emitted.push(finalAssistant);
    return { assistant: finalAssistant, messages: emitted, emittedMessages: [...emitted] };
  };
}

function savesForRun(harness, runId) {
  return harness.storeIpc.issuedSaves.filter((save) => save.run.id === runId);
}

test("turn boundaries persist incremental running snapshots with growing message counts", async () => {
  const harness = await createSubagentHarness({ runner: createMultiRoundRunner({ rounds: 3 }) });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "walker", prompt: "walk the rounds" }] }),
  );
  assert.equal(result.isError, false);
  const runId = result.details.agents[0].runId;
  const saves = savesForRun(harness, runId);

  assert.deepEqual(
    saves.map((save) => save.run.status),
    ["running", "running", "running", "running", "completed"],
  );
  // Fresh context (1 user message), then +2 messages per round, then +1 final.
  assert.deepEqual(
    saves.map((save) => save.run.totalMessageCount),
    [1, 3, 5, 7, 8],
  );
  assert.deepEqual(
    saves.map((save) => save.run.roundCount),
    [0, 1, 2, 3, 3],
  );
});

test("a turn boundary with an unchanged message count skips the redundant save", async () => {
  const harness = await createSubagentHarness({
    runner: createMultiRoundRunner({ rounds: 1, repeatBoundary: true }),
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "idler", prompt: "idle boundary" }] }),
  );
  assert.equal(result.isError, false);
  const saves = savesForRun(harness, result.details.agents[0].runId);
  // Initial(1), round-1(3), final(4) — the repeated boundary at 3 is skipped.
  assert.deepEqual(
    saves.map((save) => [save.run.status, save.run.totalMessageCount]),
    [
      ["running", 1],
      ["running", 3],
      ["completed", 4],
    ],
  );
});

test("a mid-run crash persists a failed snapshot containing every completed round", async () => {
  const harness = await createSubagentHarness({
    runner: createMultiRoundRunner({ rounds: 3, throwAfterRound: 2, error: new Error("melted") }),
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "crasher", prompt: "crash mid-run" }] }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.agents[0].status, "failed");
  assert.equal(result.details.agents[0].error, "melted");

  const runId = result.details.agents[0].runId;
  const saves = savesForRun(harness, runId);
  const finalSave = saves.at(-1);
  assert.equal(finalSave.run.status, "failed");
  assert.equal(finalSave.run.error, "melted");
  assert.equal(finalSave.run.totalMessageCount, 5);
  assert.ok(typeof finalSave.run.endedAt === "number");

  const storedMessages = finalSave.segments.flatMap((segment) =>
    JSON.parse(segment.messagesJson),
  );
  const texts = storedMessages
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "text").map((block) => block.text)
        : [message.content],
    )
    .join("\n");
  assert.match(texts, /round-1 tool use/);
  assert.match(texts, /round-2 tool use/);
  assert.match(texts, /tool output 2/);
});

test("ipc.saveRun rejection surfaces persistence warnings in the report and batch text", async () => {
  const harness = await createSubagentHarness({
    runner: createMultiRoundRunner({ rounds: 1 }),
    storeIpcOptions: { saveRunError: new Error("disk full") },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "lossy", prompt: "cannot persist" }] }),
  );
  // The run itself still completes; only persistence degraded.
  assert.equal(result.isError, false);
  const report = result.details.agents[0];
  assert.equal(report.status, "completed");
  assert.ok(report.persistenceWarnings.length >= 1);
  assert.ok(report.persistenceWarnings.every((warning) => warning === "disk full"));
  assert.match(
    result.content[0].text,
    /warning: subagent history persistence failed — resume may lose this session \(disk full/,
  );
  assert.equal(harness.storeIpc.appliedSaves.length, 0);
});

test("the final save carries the summary and endedAt and is awaited before reporting", async () => {
  const harness = await createSubagentHarness({
    runner: createMultiRoundRunner({ rounds: 2 }),
    storeIpcOptions: { saveRunDelayMs: 10 },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "finisher", prompt: "finish well" }] }),
  );
  assert.equal(result.isError, false);
  // flushPersists awaited: by the time the tool result exists, the final
  // durable write has been applied.
  const applied = harness.storeIpc.appliedSaves.filter(
    (save) => save.run.id === result.details.agents[0].runId,
  );
  const finalApplied = applied.at(-1);
  assert.equal(finalApplied.run.status, "completed");
  assert.equal(finalApplied.run.summary, "final report");
  assert.ok(typeof finalApplied.run.endedAt === "number");
  assert.equal(result.details.agents[0].persistenceWarnings, undefined);
});

test("the ipc fake serializes per-run writes so slow early saves never overtake later ones", async () => {
  const harness = await createSubagentHarness({
    runner: createMultiRoundRunner({ rounds: 2 }),
    storeIpcOptions: {
      // First write is slow; later writes are instant.
      saveRunDelayMs: (input) => (input.run.totalMessageCount === 1 ? 30 : 0),
    },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "ordered", prompt: "keep order" }] }),
  );
  assert.equal(result.isError, false);
  const runId = result.details.agents[0].runId;
  const appliedCounts = harness.storeIpc.appliedSaves
    .filter((save) => save.run.id === runId)
    .map((save) => save.run.totalMessageCount);
  assert.deepEqual(appliedCounts, [1, 3, 5, 6]);
  const appliedStatuses = harness.storeIpc.appliedSaves
    .filter((save) => save.run.id === runId)
    .map((save) => save.run.status);
  assert.equal(appliedStatuses.at(-1), "completed");
});

test("a cancelled run persists status cancelled, not failed", async () => {
  const harness = await createSubagentHarness({
    runner: async (params) => {
      params.onTurnStart?.(1);
      const assistant = createAssistant("round-1", { stopReason: "toolUse" });
      const toolResult = createToolResult("call-1", "Read", "partial");
      await params.onBeforeNextTurn?.({
        round: 1,
        assistant,
        toolResults: [toolResult],
        runtimeContext: params.context,
        emittedMessages: [assistant, toolResult],
        signal: params.signal,
      });
      throw new Error("Cancelled");
    },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "stopped", prompt: "stop me" }] }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.agents[0].status, "cancelled");
  const finalSave = harness.storeIpc.appliedSaves.at(-1);
  assert.equal(finalSave.run.status, "cancelled");
  assert.equal(finalSave.run.error, "Cancelled");
  // The cancelled snapshot still contains the completed round.
  assert.equal(finalSave.run.totalMessageCount, 3);
});

test("no persistence happens at all when the conversation id is empty", async () => {
  const harness = await createSubagentHarness({
    conversationId: "",
    runner: createMultiRoundRunner({ rounds: 2 }),
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "ephemeral", prompt: "leave no trace" }] }),
  );
  assert.equal(result.isError, false);
  assert.equal(harness.storeIpc.issuedSaves.length, 0);
  assert.equal(result.details.agents[0].persistenceWarnings, undefined);
});
