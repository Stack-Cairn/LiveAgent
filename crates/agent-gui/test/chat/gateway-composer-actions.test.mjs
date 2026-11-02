import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({ mocks: {} });
const { runGatewayComposerAction } = loader.loadModule(
  "src/pages/chat/gateway/gatewayComposerActions.ts",
);
const { gatewayComposerTurnCommand } = loader.loadModule(
  "src/pages/chat/gateway/gatewayBridgeTypes.ts",
);

function actionEvent(overrides) {
  return {
    requestId: "request-1",
    kind: "loop",
    conversationId: "conversation-1",
    action: "list",
    cron: "",
    interval: "",
    prompt: "",
    reasoning: "",
    loopId: "",
    ...overrides,
  };
}

function createDeps(calls, extra = {}) {
  return {
    client: {
      async postGoal(sessionId, input) {
        calls.push(["postGoal", sessionId, input]);
        return {
          version: "v1",
          conversation_id: sessionId,
          goal: "ship it",
          status: "cleared",
          round: 0,
          max_rounds: 100,
        };
      },
      async listLoops(sessionId) {
        calls.push(["listLoops", sessionId]);
        return [{ id: "loop-1", interval: "10m", cron: "0 */10 * * * *", prompt: "p", enabled: true }];
      },
      async createLoop(sessionId, input) {
        calls.push(["createLoop", sessionId, input]);
        return { id: "loop-2", enabled: true, ...input };
      },
      async cancelLoop(sessionId, loopId) {
        calls.push(["cancelLoop", sessionId, loopId]);
      },
    },
    getKBrainSessionId: (conversationId) =>
      conversationId === "conversation-1" ? "kb-session-1" : undefined,
    ...extra,
  };
}

test("goal clear maps to the K-brain session and reports the LiveAgent conversation id", async () => {
  const calls = [];
  const published = [];
  const result = await runGatewayComposerAction(
    actionEvent({ kind: "goal", action: "clear" }),
    createDeps(calls, { onGoalState: (id, state) => published.push([id, state.status]) }),
  );
  assert.deepEqual(calls, [["postGoal", "kb-session-1", { action: "clear" }]]);
  assert.equal(result.conversation_id, "conversation-1");
  assert.equal(result.status, "cleared");
  assert.deepEqual(published, [["conversation-1", "cleared"]]);
});

test("loop list, create and cancel always answer with a loops array", async () => {
  const calls = [];
  const deps = createDeps(calls);
  const listed = await runGatewayComposerAction(actionEvent({ action: "list" }), deps);
  assert.equal(listed.loops[0].id, "loop-1");

  const created = await runGatewayComposerAction(
    actionEvent({
      action: "create",
      cron: " 0 */5 * * * * ",
      interval: "5m",
      prompt: " ping ",
      reasoning: "high",
    }),
    deps,
  );
  assert.equal(created.loops.length, 1);
  assert.equal(created.loops[0].id, "loop-2");
  assert.deepEqual(calls[1], [
    "createLoop",
    "kb-session-1",
    { cron: "0 */5 * * * *", interval: "5m", prompt: "ping", reasoning: "high" },
  ]);

  const cancelled = await runGatewayComposerAction(
    actionEvent({ action: "cancel", loopId: " loop-2 " }),
    deps,
  );
  assert.deepEqual(cancelled, { loops: [] });
  assert.deepEqual(calls[2], ["cancelLoop", "kb-session-1", "loop-2"]);
});

test("composer actions fail clearly without K-brain, a session mapping or a valid action", async () => {
  const calls = [];
  await assert.rejects(
    runGatewayComposerAction(actionEvent({}), { getKBrainSessionId: () => "s" }),
    /K-brain backend is not enabled/,
  );
  await assert.rejects(
    runGatewayComposerAction(actionEvent({ conversationId: "draft" }), createDeps(calls)),
    /no K-brain session/,
  );
  await assert.rejects(
    runGatewayComposerAction(actionEvent({ kind: "goal", action: "set" }), createDeps(calls)),
    /unsupported goal action/,
  );
  await assert.rejects(
    runGatewayComposerAction(actionEvent({ action: "pause" }), createDeps(calls)),
    /unsupported loop action/,
  );
  await assert.rejects(
    runGatewayComposerAction(actionEvent({ action: "cancel" }), createDeps(calls)),
    /loop id is required/,
  );
  assert.deepEqual(calls, []);
});

test("gateway chat requests map goal and prompt fields to a single-turn command", () => {
  assert.equal(gatewayComposerTurnCommand({}), undefined);
  assert.deepEqual(gatewayComposerTurnCommand({ promptCommand: true }), { kind: "prompt" });
  assert.deepEqual(gatewayComposerTurnCommand({ goalAction: "resume" }), {
    kind: "goal",
    action: "resume",
  });
  assert.deepEqual(gatewayComposerTurnCommand({ goalAction: " set ", goalText: " ship " }), {
    kind: "goal",
    action: "set",
    goal: "ship",
  });
  assert.equal(gatewayComposerTurnCommand({ goalAction: "set", goalText: " " }), null);
  assert.equal(gatewayComposerTurnCommand({ goalAction: "clear" }), null);
  assert.equal(gatewayComposerTurnCommand({ goalText: "orphan" }), null);
  assert.equal(gatewayComposerTurnCommand({ goalAction: "resume", promptCommand: true }), null);
});
