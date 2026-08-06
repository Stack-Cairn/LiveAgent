import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const goal = loader.loadModule("src/lib/chat/goal.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const goalTools = loader.loadModule("src/lib/tools/goalTools.ts");

test("parses goal commands and budget options", () => {
  assert.deepEqual(goal.parseGoalCommand("/goal"), { kind: "show" });
  assert.deepEqual(goal.parseGoalCommand("/goal --budget=1200 fix the failing tests"), {
    kind: "set",
    objective: "fix the failing tests",
    tokenBudget: 1200,
  });
  assert.deepEqual(goal.parseGoalCommand("/goal edit update the objective"), {
    kind: "edit",
    objective: "update the objective",
  });
  assert.equal(goal.parseGoalCommand("please use /goal"), null);
});

test("goal mode only starts for ordinary Agent prompts without an unfinished goal", () => {
  assert.equal(
    goal.shouldStartDefaultGoal({
      enabled: true,
      isAgentMode: true,
      objective: "implement the feature",
    }),
    true,
  );
  assert.equal(
    goal.shouldStartDefaultGoal({
      enabled: true,
      isAgentMode: false,
      objective: "implement the feature",
    }),
    false,
  );
  assert.equal(
    goal.shouldStartDefaultGoal({
      enabled: true,
      isAgentMode: true,
      currentGoal: goal.createConversationGoal("still running", undefined, 1),
      objective: "continue",
    }),
    false,
  );
  assert.equal(
    goal.shouldStartDefaultGoal({
      enabled: true,
      isAgentMode: true,
      currentGoal: { ...goal.createConversationGoal("done", undefined, 1), status: "complete" },
      objective: "start another task",
    }),
    true,
  );
});

test("goal commands enforce one unfinished goal and support lifecycle changes", () => {
  const created = goal.applyGoalCommand(null, {
    kind: "set",
    objective: "finish the migration",
  }, 100);
  assert.equal(created.goal.status, "active");
  assert.throws(
    () => goal.applyGoalCommand(created.goal, { kind: "set", objective: "replace it" }, 200),
    /unfinished goal/i,
  );

  const paused = goal.applyGoalCommand(created.goal, { kind: "pause" }, 200).goal;
  assert.equal(paused.status, "paused");
  const resumed = goal.applyGoalCommand(paused, { kind: "resume" }, 300).goal;
  assert.equal(resumed.status, "active");
  const completed = goal.applyGoalCommand(resumed, { kind: "complete" }, 400).goal;
  assert.equal(completed.status, "complete");
});

test("editing a goal preserves usage and active timing", () => {
  const current = goal.createConversationGoal("old objective", undefined, 1_000);
  const state = goal.createGoalState({ initialGoal: current, onChange: () => {} });
  state.recordProgress(1_234, 4, 5_000);

  const edited = goal.applyGoalCommand(state.getGoal(), {
    kind: "edit",
    objective: "new objective",
  }, 8_000);
  state.setGoal(edited.goal);

  assert.equal(edited.shouldStart, true);
  assert.equal(state.getGoal().objective, "new objective");
  assert.equal(state.getGoal().tokensUsed, 1_234);
  assert.equal(state.getGoal().timeUsedSeconds, 4);
  assert.equal(state.getGoal().runningSince, 5_000);
});

test("live goal tokens publish during an iteration and reconcile with final usage", () => {
  const changes = [];
  const state = goal.createGoalState({
    initialGoal: goal.createConversationGoal("stream progress", undefined, 1),
    onChange: (next) => changes.push(next),
  });

  state.startIteration();
  state.recordLiveTokens(0.75);
  assert.equal(state.getGoal().tokensUsed, 0);
  state.recordLiveTokens(0.75);
  assert.equal(state.getGoal().tokensUsed, 1);

  state.recordProgress(100, 2);
  assert.equal(state.getGoal().tokensUsed, 100);
  assert.equal(changes.length, 2);
});

test("active goal elapsed time advances from the current running period", () => {
  const current = goal.createConversationGoal("measure the run", undefined, 1_000);

  assert.equal(goal.getGoalElapsedSeconds(current, 4_999), 3);
  assert.equal(goal.getGoalElapsedSeconds(current, 5_000), 4);
});

test("pausing freezes elapsed time and resuming starts a new timing period", () => {
  const current = goal.createConversationGoal("pause and resume", undefined, 1_000);
  const paused = goal.applyGoalCommand(current, { kind: "pause" }, 5_500).goal;

  assert.equal(paused.timeUsedSeconds, 4);
  assert.equal(paused.runningSince, undefined);
  assert.equal(goal.getGoalElapsedSeconds(paused, 20_000), 4);

  const resumed = goal.applyGoalCommand(paused, { kind: "resume" }, 20_000).goal;
  assert.equal(resumed.runningSince, 20_000);
  assert.equal(goal.getGoalElapsedSeconds(resumed, 21_250), 5);
});

test("manually resuming an idle active goal starts a fresh period after restart", () => {
  const persisted = {
    ...goal.createConversationGoal("resume after restart", undefined, 1_000),
    timeUsedSeconds: 12,
    updatedAt: 2_000,
  };

  const resumed = goal.applyGoalCommand(persisted, { kind: "resume" }, 100_000).goal;

  assert.equal(resumed.status, "active");
  assert.equal(resumed.timeUsedSeconds, 12);
  assert.equal(resumed.runningSince, 100_000);
  assert.equal(goal.getGoalElapsedSeconds(resumed, 101_250), 13);
});

test("consecutive provider errors pause on the fifth failure and resume clears the streak", () => {
  const initial = goal.createConversationGoal("recover from provider failures", undefined, 1);
  const state = goal.createGoalState({ initialGoal: initial, onChange: () => {} });

  for (let index = 1; index < 5; index += 1) {
    state.recordError(new Error(`503 provider unavailable (${index})`));
    assert.equal(state.getGoal().status, "active");
    assert.equal(state.getGoal().consecutiveApiErrorCount, index);
  }

  state.recordError(new Error("401 unauthorized"));
  assert.equal(state.getGoal().status, "paused");
  assert.equal(state.getGoal().consecutiveApiErrorCount, 5);
  assert.match(state.getGoal().lastApiError, /401/);

  const resumed = goal.applyGoalCommand(state.getGoal(), { kind: "resume" }, 20).goal;
  state.setGoal(resumed);
  assert.equal(state.getGoal().status, "active");
  assert.equal(state.getGoal().consecutiveApiErrorCount, 0);
  assert.equal(state.getGoal().lastApiError, undefined);
});

test("successful goal progress resets a transient provider error streak", () => {
  const state = goal.createGoalState({
    initialGoal: goal.createConversationGoal("make progress", undefined, 1),
    onChange: () => {},
  });
  state.recordError("501 temporary provider failure");
  state.recordError("503 temporary provider failure");
  state.recordProgress(12, 3);

  assert.equal(state.getGoal().status, "active");
  assert.equal(state.getGoal().consecutiveApiErrorCount, 0);
  assert.equal(state.getGoal().lastApiError, undefined);
  assert.equal(state.getGoal().tokensUsed, 12);
});

test("goal progress stops at an explicit token budget without a continuation count", () => {
  const initial = goal.createConversationGoal("inspect the repository", 100, 1);
  const changes = [];
  const state = goal.createGoalState({
    initialGoal: initial,
    onChange: (next) => changes.push(next),
  });

  state.recordProgress(101, 7);

  assert.equal(state.getGoal().status, "budgetLimited");
  assert.equal(state.getGoal().tokensUsed, 101);
  assert.equal(state.getGoal().timeUsedSeconds, 7);
  assert.equal(changes.length, 1);
});

test("completion settles time immediately and records the final model round once", () => {
  const initial = goal.createConversationGoal("finish and report", undefined, 1_000);
  const state = goal.createGoalState({ initialGoal: initial, onChange: () => {} });

  state.recordProgress(20, 3, 4_000);
  state.setGoal({ ...state.getGoal(), status: "complete", updatedAt: 5_000 });

  assert.equal(state.getGoal().status, "complete");
  assert.equal(state.getGoal().tokensUsed, 20);
  assert.equal(state.getGoal().timeUsedSeconds, 4);
  assert.equal(goal.getGoalElapsedSeconds(state.getGoal(), 9_000), 4);

  state.recordProgress(8, 2, 7_000);

  assert.equal(state.getGoal().status, "complete");
  assert.equal(state.getGoal().tokensUsed, 28);
  assert.equal(state.getGoal().timeUsedSeconds, 6);
  assert.equal(state.getGoal().runningSince, undefined);
});

test("goal token formatting uses comma grouping", () => {
  assert.equal(goal.formatGoalTokens(0), "0");
  assert.equal(goal.formatGoalTokens(1_234), "1,234");
  assert.equal(goal.formatGoalTokens(9_999), "9,999");
  assert.equal(goal.formatGoalTokens(12_345), "12.35K");
  assert.equal(goal.formatGoalTokens(1_234_567), "1.23M");
  assert.equal(goal.formatGoalTokens(1_234_567_890), "1.23B");
  assert.equal(goal.formatGoalTokens(1_234_567_890_123), "1.23T");
});

test("goal duration formatting keeps hours, minutes, and seconds compact", () => {
  assert.equal(goal.formatGoalDuration(0), "0s");
  assert.equal(goal.formatGoalDuration(59), "59s");
  assert.equal(goal.formatGoalDuration(60), "1m 0s");
  assert.equal(goal.formatGoalDuration(3_661), "1h 1m 1s");
});

test("goal metadata survives conversation state normalization", () => {
  const current = goal.createConversationGoal("keep working", undefined, 10);
  const state = conversationState.normalizeConversationState({
    meta: { goal: current },
    segments: [],
  });

  assert.deepEqual(state.meta.goal, current);
  assert.equal(state.meta.goalModeEnabled, false);
});

test("goal mode is persisted per conversation and survives state updates", () => {
  const disabled = conversationState.createConversationStateFromContext({ messages: [] });
  const enabled = conversationState.updateConversationGoalMode(disabled, true);
  const nextConversation = conversationState.createConversationStateFromContext({ messages: [] });

  assert.equal(disabled.meta.goalModeEnabled, false);
  assert.equal(enabled.meta.goalModeEnabled, true);
  assert.equal(nextConversation.meta.goalModeEnabled, false);

  const withMessage = conversationState.appendMessagesToConversation(enabled, [
    { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 20 },
  ]);
  assert.equal(withMessage.meta.goalModeEnabled, true);
  assert.strictEqual(conversationState.updateConversationGoalMode(enabled, true), enabled);
});

test("goal prompt treats the objective as data and requires an explicit terminal update", () => {
  const current = goal.createConversationGoal("inspect <config> & verify", undefined, 10);
  const prompt = goal.buildGoalSystemPrompt(current);

  assert.match(prompt, /<objective>inspect &lt;config&gt; &amp; verify<\/objective>/);
  assert.match(prompt, /call update_goal with status=complete/i);
  assert.match(prompt, /runtime may continue automatically/i);
});

test("inactive goals do not steer later ordinary prompts", () => {
  const current = goal.createConversationGoal("old objective", undefined, 10);

  for (const status of ["paused", "blocked", "usageLimited", "budgetLimited", "complete"]) {
    assert.equal(goal.buildGoalSystemPrompt({ ...current, status }), "");
  }
});

test("goal command feedback and progress detection distinguish informational output and failures", () => {
  assert.equal(
    goal.formatGoalCommandFeedback({ goal: null, action: "show", shouldStart: false }),
    "No goal is currently set.",
  );
  assert.equal(
    goal.formatGoalCommandFeedback({ goal: null, action: "usage", shouldStart: false }),
    goal.GOAL_COMMAND_USAGE,
  );
  assert.equal(
    goal.hasSuccessfulGoalToolProgress([{ role: "toolResult", isError: true }]),
    false,
  );
  assert.equal(
    goal.hasSuccessfulGoalToolProgress([{ role: "toolResult", isError: false }]),
    true,
  );
});

test("goal tools read, create, and update the persisted goal state", async () => {
  const changes = [];
  const state = goal.createGoalState({ onChange: (next) => changes.push(next) });
  const bundle = goalTools.createGoalTools({ state });
  const call = (id, name, arguments_) => ({ id, name, arguments: arguments_ });

  const created = await bundle.executeToolCall(
    call("1", "create_goal", { objective: "run the checks" }),
  );
  assert.equal(created.isError, false);
  assert.equal(state.getGoal().objective, "run the checks");

  const updated = await bundle.executeToolCall(call("2", "update_goal", { status: "complete" }));
  assert.equal(updated.isError, false);
  assert.equal(state.getGoal().status, "complete");
  assert.equal(changes.length, 2);
});
