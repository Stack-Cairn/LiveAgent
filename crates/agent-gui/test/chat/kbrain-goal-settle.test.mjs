import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 带目标的轮次结束后：用户停止时先暂停目标（后端可能已自行开始下一轮），再刷新目标栏。
const loader = createTsModuleLoader();
const { settleGoalAfterTurn } = loader.loadModule("src/lib/kbrain/goalSettle.ts");

function fixture({ pauseError } = {}) {
  const calls = [];
  const published = [];
  const client = {
    postGoal: async (id, input) => {
      calls.push(["post", id, input.action]);
      if (pauseError) throw Object.assign(new Error("no active goal"), { status: 409 });
      return { status: "paused", reason: "user" };
    },
    getGoal: async (id) => {
      calls.push(["get", id]);
      return { status: "met" };
    },
  };
  const publish = (conversationId, state) => published.push([conversationId, state.status]);
  return { calls, published, client, publish };
}

test("a stopped goal turn pauses the backend goal and publishes the paused state", async () => {
  const f = fixture();
  await settleGoalAfterTurn({ ...f, conversationId: "c1", sessionId: "s1", stopped: true });
  assert.deepEqual(f.calls, [["post", "s1", "pause"]]);
  assert.deepEqual(f.published, [["c1", "paused"]]);
});

test("a 409 from pause falls back to reading the current goal", async () => {
  const f = fixture({ pauseError: true });
  await settleGoalAfterTurn({ ...f, conversationId: "c1", sessionId: "s1", stopped: true });
  assert.deepEqual(f.calls, [["post", "s1", "pause"], ["get", "s1"]]);
  assert.deepEqual(f.published, [["c1", "met"]]);
});

test("a finished goal turn only refreshes the goal bar, and no session means no request", async () => {
  const f = fixture();
  await settleGoalAfterTurn({ ...f, conversationId: "c1", sessionId: "s1", stopped: false });
  assert.deepEqual(f.calls, [["get", "s1"]]);
  const g = fixture();
  await settleGoalAfterTurn({ ...g, conversationId: "c1", sessionId: undefined, stopped: true });
  assert.deepEqual(g.calls, []);
});
