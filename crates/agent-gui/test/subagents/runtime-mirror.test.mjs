import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const mirror = loader.loadModule("@liveagent/ui/lib/subagents/runtime.ts");

function startRun(overrides = {}) {
  const input = {
    runId: overrides.runId ?? "run-1",
    conversationId: overrides.conversationId ?? "conversation-1",
    agentId: overrides.agentId ?? "agent-1",
    name: overrides.name ?? "Agent One",
    prompt: overrides.prompt ?? "do the thing",
    mode: overrides.mode ?? "readonly",
    providerId: overrides.providerId ?? "codex",
    model: overrides.model ?? "gpt-5",
    startedAt: overrides.startedAt ?? 1_000,
    ...("reasoning" in overrides ? { reasoning: overrides.reasoning } : {}),
    ...("stop" in overrides ? { stop: overrides.stop } : {}),
  };
  mirror.startSubagentRuntimeRun(input);
  return input;
}

function findRun(runId) {
  return mirror.getSubagentRuntimeRuns().find((run) => run.runId === runId);
}

test.beforeEach(() => {
  mirror.resetSubagentRuntimeRuns();
});

test("a started run lands in the mirror as queued with zeroed counters", () => {
  startRun({ reasoning: "high", stop: () => {} });
  const run = findRun("run-1");
  assert.equal(run.phase, "queued");
  assert.equal(run.rounds, 0);
  assert.equal(run.toolCalls, 0);
  assert.equal(run.reasoning, "high");
  assert.equal(run.stopRequested, false);
  assert.equal(run.stoppable, true);
});

test("a run without a stop handle is not advertised as stoppable", () => {
  startRun();
  assert.equal(findRun("run-1").stoppable, false);
});

test("patches advance phase, activity line and counters", () => {
  startRun();
  mirror.updateSubagentRuntimeRun("run-1", { phase: "provisioning" });
  mirror.updateSubagentRuntimeRun("run-1", { statusText: "Creating isolated worktree…" });
  mirror.updateSubagentRuntimeRun("run-1", { phase: "running", statusText: null });
  mirror.updateSubagentRuntimeRun("run-1", { rounds: 2, toolCalls: 5 });
  const run = findRun("run-1");
  assert.equal(run.phase, "running");
  assert.equal(run.statusText, undefined);
  assert.equal(run.rounds, 2);
  assert.equal(run.toolCalls, 5);
});

test("counters never move backwards", () => {
  // runner 的回调在重试/恢复路径上可能重放较小的 round;计数回退会让面板看起来
  // 在倒着跑,那正是用户判断「是不是卡了」的信号源。
  startRun();
  mirror.updateSubagentRuntimeRun("run-1", { rounds: 4, toolCalls: 9 });
  mirror.updateSubagentRuntimeRun("run-1", { rounds: 1, toolCalls: 2 });
  const run = findRun("run-1");
  assert.equal(run.rounds, 4);
  assert.equal(run.toolCalls, 9);
});

test("finishing clears the activity line and drops the stop affordance", () => {
  startRun({ stop: () => {} });
  mirror.updateSubagentRuntimeRun("run-1", { phase: "running", statusText: "正在执行：Read" });
  mirror.finishSubagentRuntimeRun("run-1", { status: "completed", endedAt: 2_000 });
  const run = findRun("run-1");
  assert.equal(run.phase, "finished");
  assert.equal(run.status, "completed");
  assert.equal(run.endedAt, 2_000);
  assert.equal(run.statusText, undefined);
  assert.equal(run.stoppable, false);
});

test("a late patch never resurrects a finished run", () => {
  startRun();
  mirror.finishSubagentRuntimeRun("run-1", { status: "failed", error: "boom", endedAt: 2_000 });
  mirror.updateSubagentRuntimeRun("run-1", { phase: "running", statusText: "still going" });
  const run = findRun("run-1");
  assert.equal(run.phase, "finished");
  assert.equal(run.error, "boom");
  assert.equal(run.statusText, undefined);
});

test("stop marks the request and invokes the handle exactly once", () => {
  let stopCalls = 0;
  startRun({
    stop: () => {
      stopCalls += 1;
    },
  });
  mirror.stopSubagentRuntimeRun("run-1");
  assert.equal(stopCalls, 1);
  // 刻意不乐观改 phase:句柄没生效时用户应该继续看到它在跑,而不是一个假终态。
  assert.equal(findRun("run-1").phase, "queued");
  assert.equal(findRun("run-1").stopRequested, true);

  mirror.stopSubagentRuntimeRun("run-1");
  assert.equal(stopCalls, 1);
});

test("a throwing stop handle does not break the store", () => {
  startRun({
    stop: () => {
      throw new Error("handle exploded");
    },
  });
  mirror.stopSubagentRuntimeRun("run-1");
  assert.equal(findRun("run-1").stopRequested, true);
});

test("stopping a finished run is a no-op", () => {
  let stopCalls = 0;
  startRun({
    stop: () => {
      stopCalls += 1;
    },
  });
  mirror.finishSubagentRuntimeRun("run-1", { status: "completed", endedAt: 2_000 });
  mirror.stopSubagentRuntimeRun("run-1");
  assert.equal(stopCalls, 0);
});

test("active runs sort above finished ones, newest first", () => {
  startRun({ runId: "old-active", agentId: "a", startedAt: 1_000 });
  startRun({ runId: "new-active", agentId: "b", startedAt: 3_000 });
  startRun({ runId: "done", agentId: "c", startedAt: 5_000 });
  mirror.finishSubagentRuntimeRun("done", { status: "completed", endedAt: 6_000 });
  assert.deepEqual(
    mirror.getSubagentRuntimeRuns().map((run) => run.runId),
    ["new-active", "old-active", "done"],
  );
});

test("clearFinished removes only terminal entries", () => {
  startRun({ runId: "live", agentId: "a" });
  startRun({ runId: "done", agentId: "b" });
  mirror.finishSubagentRuntimeRun("done", { status: "cancelled", endedAt: 2_000 });
  mirror.clearFinishedSubagentRuntimeRuns();
  assert.deepEqual(
    mirror.getSubagentRuntimeRuns().map((run) => run.runId),
    ["live"],
  );
});

test("dropping a conversation removes its entries and leaves the others", () => {
  startRun({ runId: "a1", conversationId: "conversation-1", agentId: "a" });
  startRun({ runId: "b1", conversationId: "conversation-2", agentId: "b" });
  mirror.dropSubagentRuntimeRunsForConversation("conversation-1");
  assert.deepEqual(
    mirror.getSubagentRuntimeRuns().map((run) => run.runId),
    ["b1"],
  );
});

test("subscribers see a new snapshot reference per mutation and a stable one otherwise", () => {
  let notifications = 0;
  const unsubscribe = mirror.subscribeSubagentRuntimeRuns(() => {
    notifications += 1;
  });
  startRun();
  const first = mirror.getSubagentRuntimeRuns();
  // useSyncExternalStore 要求 getSnapshot 在无变更时返回同一引用,否则无限重渲染。
  assert.equal(mirror.getSubagentRuntimeRuns(), first);
  mirror.updateSubagentRuntimeRun("run-1", { rounds: 1 });
  assert.notEqual(mirror.getSubagentRuntimeRuns(), first);
  assert.equal(notifications, 2);
  unsubscribe();
  mirror.updateSubagentRuntimeRun("run-1", { rounds: 2 });
  assert.equal(notifications, 2);
});

test("the finished backlog is capped while active runs are never evicted", () => {
  startRun({ runId: "live", agentId: "live", startedAt: 0 });
  for (let index = 0; index < 30; index += 1) {
    const runId = `done-${index}`;
    startRun({ runId, agentId: runId, startedAt: 1_000 + index });
    mirror.finishSubagentRuntimeRun(runId, { status: "completed", endedAt: 1_000 + index });
  }
  const runs = mirror.getSubagentRuntimeRuns();
  const finished = runs.filter((run) => run.phase === "finished");
  assert.equal(finished.length, 24);
  assert.ok(runs.some((run) => run.runId === "live"));
  // 淘汰最旧的终态,保留最近的。
  assert.ok(!finished.some((run) => run.runId === "done-0"));
  assert.ok(finished.some((run) => run.runId === "done-29"));
});
