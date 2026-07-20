import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const controllerModule = loader.loadModule("src/lib/chat/compaction/controller.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const cancellationModule = loader.loadModule("src/lib/chat/conversation/turnCancellation.ts");

const { CompactionController, createCompactionControllerRegistry } = controllerModule;

const VALID_SUMMARY_XML = `<summary>
<task>Fix src/app.ts</task>
<state>Work on src/app.ts continues ${"detail ".repeat(60)}</state>
<artifacts>
- [file] src/app.ts | modified
</artifacts>
<next_steps>
1. keep going
</next_steps>
</summary>`;

function usage(totalTokens) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function user(content, timestamp = 1) {
  return { role: "user", content, timestamp };
}

function assistantWithUsage(text, totalTokens, timestamp = 2) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-real",
    stopReason: "stop",
    usage: usage(totalTokens),
    timestamp,
  };
}

function toolResultBig(chars, timestamp = 3) {
  return {
    role: "toolResult",
    toolCallId: "tc-big",
    toolName: "Read",
    content: [{ type: "text", text: "x".repeat(chars) }],
    isError: false,
    timestamp,
  };
}

function summaryResponse() {
  return {
    role: "assistant",
    content: [{ type: "text", text: VALID_SUMMARY_XML }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-real",
    stopReason: "stop",
    usage: usage(5000),
    timestamp: 1234,
    responseId: "resp-1",
  };
}

// 3 个用户消息绕开 MIN_COMPACTION_USER_MESSAGES 冷却窗，方便连续压缩场景。
function bigState(extraMessages = []) {
  return conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      user("continue with src/app.ts", 2),
      user("check src/app.ts again", 3),
      assistantWithUsage("working on src/app.ts", 190_000, 4),
      ...extraMessages,
    ],
  });
}

function createSinksRecorder() {
  const events = [];
  return {
    events,
    byKind(kind) {
      return events.filter((event) => event[0] === kind);
    },
    sinks: {
      applyState: (state) => events.push(["applyState", state]),
      applyStateMidRun: (state) => events.push(["applyStateMidRun", state]),
      publishStatus: (status) => events.push(["publishStatus", status]),
      setBridgeToolStatus: (text, isCompaction) => events.push(["bridge", text, isCompaction]),
      queueCheckpoint: (state) => events.push(["queueCheckpoint", state]),
      persist: async (state) => {
        events.push(["persist", state]);
        return true;
      },
      restoreComposer: (text, uploads) => events.push(["restoreComposer", text, uploads]),
      persistRollback: async (state) => {
        events.push(["persistRollback", state]);
        return true;
      },
    },
  };
}

function bindController(controller, overrides = {}) {
  const cancellation = cancellationModule.createTurnCancellation();
  const recorder = createSinksRecorder();
  controller.bindTurn({
    providerId: "anthropic",
    model: "claude-x",
    runtime: {
      baseUrl: "https://example",
      apiKey: "k",
      modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
    },
    cancellation,
    sinks: recorder.sinks,
    buildPreparedContext: (state) => conversationState.buildRequestContext(state),
    buildResumeContext: (state, resumeMessage) => {
      const context = conversationState.buildRequestContext(state);
      return resumeMessage
        ? { ...context, messages: [...context.messages, resumeMessage] }
        : context;
    },
    ...overrides,
  });
  return { cancellation, recorder };
}

test("pre-send compaction: checkpoint, persist, re-appended user message, paired status", async () => {
  const controller = new CompactionController();
  const baseState = bigState();
  const pendingUserMessage = user("next question", 9);
  let completeCalls = 0;
  const { recorder } = bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    presend: {
      baseState,
      pendingUserText: "next question",
      composerText: "next question",
      uploadedFiles: [],
      composeAppliedState: (state) =>
        conversationState.appendMessagesToConversation(state, [pendingUserMessage]),
    },
  });

  const applied = await controller.maybeCompactPreSend({
    budgetContext: conversationState.buildRequestContext(baseState),
  });

  assert.equal(applied, true);
  assert.equal(completeCalls, 1);

  const statuses = recorder.byKind("publishStatus").map(([, status]) => status.phase);
  assert.deepEqual(statuses, ["running", "completed"]);

  // persist 的是 checkpoint 状态（新 segment、无待发送消息）；apply 的是补回用户消息的状态。
  const [, persistedState] = recorder.byKind("persist")[0];
  assert.equal(persistedState.segments.length, 2);
  assert.equal(persistedState.segments[1].messages.length, 0);
  const [, appliedState] = recorder.byKind("applyState")[0];
  assert.equal(appliedState.segments[1].messages.length, 1);
  assert.equal(appliedState.segments[1].messages[0].content, "next question");

  assert.equal(recorder.byKind("queueCheckpoint").length, 1);

  // bridge 状态成对：running 时 isCompaction=true，结束后清 null。
  const bridgeEvents = recorder.byKind("bridge");
  assert.match(bridgeEvents[0][1], /正在压缩历史/);
  assert.equal(bridgeEvents[0][2], true);
  assert.equal(bridgeEvents.at(-1)[1], null);
});

test("below-threshold decisions are side-effect free", async () => {
  const controller = new CompactionController();
  const smallState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [user("hi"), assistantWithUsage("hello", 1000)],
  });
  let completeCalls = 0;
  const { recorder } = bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    presend: {
      baseState: smallState,
      pendingUserText: "next",
      composeAppliedState: (state) => state,
    },
  });

  const applied = await controller.maybeCompactPreSend({
    budgetContext: conversationState.buildRequestContext(smallState),
  });
  const midRun = await controller.compactDuringRun({
    trigger: "post-tool",
    state: smallState,
  });

  assert.equal(applied, false);
  assert.equal(midRun, null);
  assert.equal(completeCalls, 0);
  assert.equal(recorder.events.length, 0);
});

test("single-flight: a concurrent trigger is rejected while a compaction is in flight", async () => {
  const controller = new CompactionController();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let completeCalls = 0;
  bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      await gate;
      return summaryResponse();
    },
  });

  const state = bigState();
  const first = controller.compactDuringRun({ trigger: "post-tool", state });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.shouldProtectMidStream(1_000_000), false);
  const second = await controller.compactDuringRun({ trigger: "post-tool", state });
  assert.equal(second, null);

  release();
  const firstContext = await first;
  assert.ok(firstContext);
  assert.equal(completeCalls, 1);
});

test("user stop chains into the summarizer; handleTurnAbort rolls back and persists", async () => {
  const controller = new CompactionController();
  const state = bigState();
  const { cancellation, recorder } = bindController(controller, {
    complete: (params) =>
      new Promise((_, reject) => {
        params.signal?.addEventListener("abort", () => {
          const error = new Error("aborted by user");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const pending = controller.compactDuringRun({ trigger: "mid-stream", state });
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.userStop.abort();
  await assert.rejects(pending, /aborted/);

  const rolledBack = await controller.handleTurnAbort();
  assert.equal(rolledBack, true);

  const [, restoredState] = recorder.byKind("applyStateMidRun")[0];
  assert.equal(restoredState, state);
  // mid-run 回滚必须补持久化（旧 persistOnRollback 语义）。
  assert.equal(recorder.byKind("persistRollback").length, 1);
  const statuses = recorder.byKind("publishStatus").map(([, status]) => status.phase);
  assert.deepEqual(statuses, ["running", "idle"]);
  // 回滚后 bridge 状态已清，isCompaction 不悬挂。
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);

  // 快照消费后再次调用不再回滚。
  assert.equal(await controller.handleTurnAbort(), false);
});

test("handleTurnAbort clears running status even without rollback snapshot", async () => {
  // Manual compact abort path: compactManually may publish running then throw AbortError
  // without a pre-send snapshot; UI must not stay stuck on "compacting".
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      user("continue with src/app.ts", 2),
      user("check src/app.ts again", 3),
      assistantWithUsage("working", 2_000, 4),
    ],
  });
  const cancellation = cancellationModule.createTurnCancellation();
  const events = [];
  controller.bindTurn({
    providerId: "anthropic",
    model: "claude-x",
    runtime: {
      baseUrl: "https://example",
      apiKey: "k",
      modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
    },
    cancellation,
    sinks: {
      applyState: (next) => events.push(["applyState", next]),
      applyStateMidRun: (next) => events.push(["applyStateMidRun", next]),
      publishStatus: (status) => events.push(["publishStatus", status]),
      setBridgeToolStatus: (text, isCompaction) => events.push(["bridge", text, isCompaction]),
      persist: async () => true,
    },
    complete: async (params) =>
      new Promise((_, reject) => {
        params.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted by user");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
    buildPreparedContext: (next) => conversationState.buildRequestContext(next),
    buildResumeContext: (next) => conversationState.buildRequestContext(next),
    presend: {
      baseState: state,
      pendingUserText: "",
      composeAppliedState: (next) => next,
    },
  });

  const pending = controller.compactManually({
    force: true,
    budgetContext: conversationState.buildRequestContext(state),
  });
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.userStop.abort();
  await assert.rejects(pending, /aborted|AbortError/i);

  const rolledBack = await controller.handleTurnAbort();
  // No pre-send snapshot for pure manual compact mid-summarizer without prior prune apply.
  // Still must publish idle so entry gates unlock.
  const phases = events.filter((e) => e[0] === "publishStatus").map(([, s]) => s.phase);
  assert.ok(phases.includes("running"), `expected running, got ${phases.join(",")}`);
  assert.ok(phases.includes("idle"), `expected idle after abort, got ${phases.join(",")}`);
  // Second abort is a no-op once idle.
  assert.equal(await controller.handleTurnAbort(), false);
  void rolledBack;
});

test("summarizer failure degrades to prune and still returns a usable context", async () => {
  const controller = new CompactionController();
  // 大工具输出（200k 字符 ≈ 50k tokens > 40k 保护额度）必须在"最近 2 个用户轮次"之前才可被裁剪。
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      toolResultBig(200_000, 2),
      user("continue with src/app.ts", 3),
      user("check src/app.ts again", 4),
      assistantWithUsage("working on src/app.ts", 190_000, 5),
    ],
  });
  const { recorder } = bindController(controller, {
    complete: async () => {
      throw new Error("invalid api key");
    },
  });

  const context = await controller.compactDuringRun({ trigger: "post-tool", state });

  assert.ok(context);
  const [, prunedState] = recorder.byKind("applyStateMidRun")[0];
  const prunedMessages = prunedState.segments[0].messages.filter(
    (message) =>
      message.role === "toolResult" &&
      message.content?.[0]?.text === "[output pruned to preserve context budget]",
  );
  assert.equal(prunedMessages.length, 1);

  const failedStatus = recorder
    .byKind("publishStatus")
    .map(([, status]) => status)
    .find((status) => status.phase === "failed");
  assert.match(failedStatus.message, /prune 降级/);
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);
});

test("escalation ladder: consecutive ineffective compactions advise but never hard-refuse", async () => {
  const controller = new CompactionController();
  let completeCalls = 0;
  const { recorder } = bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    // 压缩后的恢复上下文仍然巨大 → 判定为低效压缩，推动压力升级。
    buildResumeContext: () => ({
      systemPrompt: "sys",
      messages: [assistantWithUsage("still huge", 190_000, 99)],
    }),
  });

  for (let round = 1; round <= 3; round += 1) {
    const context = await controller.compactDuringRun({
      trigger: "post-tool",
      state: bigState(),
    });
    assert.ok(context, `compaction round ${round} must not be refused`);
  }

  assert.equal(completeCalls, 3);
  assert.equal(controller.stats.compactionsApplied, 3);

  const runningTexts = recorder
    .byKind("bridge")
    .filter(([, , isCompaction]) => isCompaction === true)
    .map(([, text]) => text);
  assert.equal(runningTexts.length, 3);
  assert.doesNotMatch(runningTexts[0], /建议适时开启新会话/);
  // 连续两次低效后顶格，第三次给出建议性提示但仍执行压缩。
  assert.match(runningTexts[2], /建议适时开启新会话/);
});

test("registry hands out one controller per conversation and disposes cleanly", () => {
  const registry = createCompactionControllerRegistry();
  const a = registry.get("conv-a");
  assert.equal(registry.get("conv-a"), a);
  assert.notEqual(registry.get("conv-b"), a);
  registry.dispose("conv-a");
  assert.notEqual(registry.get("conv-a"), a);
});

test("compactManually force compresses below-threshold conversations", async () => {
  const controller = new CompactionController();
  const smallState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      user("continue with src/app.ts", 2),
      user("check src/app.ts again", 3),
      assistantWithUsage("working", 2_000, 4),
    ],
  });
  let completeCalls = 0;
  const { recorder } = bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    presend: {
      baseState: smallState,
      pendingUserText: "",
      composeAppliedState: (state) => state,
    },
  });

  const withoutForce = await controller.compactManually({
    force: false,
    budgetContext: conversationState.buildRequestContext(smallState),
  });
  assert.equal(withoutForce, "skipped");
  assert.equal(completeCalls, 0);

  const forced = await controller.compactManually({
    force: true,
    budgetContext: conversationState.buildRequestContext(smallState),
  });
  assert.equal(forced, "compacted");
  assert.equal(completeCalls, 1);

  const statuses = recorder.byKind("publishStatus").map(([, status]) => status);
  assert.equal(statuses[0].phase, "running");
  assert.equal(statuses[0].trigger, "manual");
  assert.equal(statuses.at(-1).phase, "completed");
  assert.equal(statuses.at(-1).trigger, "manual");
});

test("compactManually treats persist false as failed", async () => {
  const controller = new CompactionController();
  const smallState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      user("continue with src/app.ts", 2),
      user("check src/app.ts again", 3),
      assistantWithUsage("working", 2_000, 4),
    ],
  });
  const events = [];
  let completeCalls = 0;
  const cancellation = cancellationModule.createTurnCancellation();
  controller.bindTurn({
    providerId: "anthropic",
    model: "claude-x",
    runtime: {
      baseUrl: "https://example",
      apiKey: "k",
      modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
    },
    cancellation,
    sinks: {
      applyState: (state) => events.push(["applyState", state]),
      publishStatus: (status) => events.push(["publishStatus", status]),
      setBridgeToolStatus: (text, isCompaction) => events.push(["bridge", text, isCompaction]),
      queueCheckpoint: (state) => events.push(["queueCheckpoint", state]),
      persist: async (state) => {
        events.push(["persist", state]);
        return false;
      },
    },
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    buildPreparedContext: (state) => conversationState.buildRequestContext(state),
    buildResumeContext: (state, resumeMessage) => {
      const context = conversationState.buildRequestContext(state);
      return resumeMessage
        ? { ...context, messages: [...context.messages, resumeMessage] }
        : context;
    },
    presend: {
      baseState: smallState,
      pendingUserText: "",
      composeAppliedState: (state) => state,
    },
  });

  const result = await controller.compactManually({
    force: true,
    budgetContext: conversationState.buildRequestContext(smallState),
  });

  assert.equal(result, "failed");
  assert.equal(completeCalls, 1);
  assert.equal(events.filter((e) => e[0] === "persist").length, 1);
  assert.equal(events.filter((e) => e[0] === "queueCheckpoint").length, 0);
  const phases = events.filter((e) => e[0] === "publishStatus").map(([, s]) => s.phase);
  assert.ok(phases.includes("failed"));
  assert.ok(!phases.includes("completed"));
});

test("compactManually prune fallback returns compacted after persist succeeds", async () => {
  const controller = new CompactionController();
  // Large tool output before recent user turns so prune can apply.
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      toolResultBig(200_000, 2),
      user("continue with src/app.ts", 3),
      user("check src/app.ts again", 4),
      assistantWithUsage("working on src/app.ts", 190_000, 5),
    ],
  });
  const events = [];
  const cancellation = cancellationModule.createTurnCancellation();
  controller.bindTurn({
    providerId: "anthropic",
    model: "claude-x",
    runtime: {
      baseUrl: "https://example",
      apiKey: "k",
      modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
    },
    cancellation,
    sinks: {
      applyState: (next) => events.push(["applyState", next]),
      publishStatus: (status) => events.push(["publishStatus", status]),
      setBridgeToolStatus: (text, isCompaction) => events.push(["bridge", text, isCompaction]),
      queueCheckpoint: (next) => events.push(["queueCheckpoint", next]),
      persist: async (next) => {
        events.push(["persist", next]);
        return true;
      },
    },
    complete: async () => {
      throw new Error("invalid api key");
    },
    buildPreparedContext: (next) => conversationState.buildRequestContext(next),
    buildResumeContext: (next, resumeMessage) => {
      const context = conversationState.buildRequestContext(next);
      return resumeMessage
        ? { ...context, messages: [...context.messages, resumeMessage] }
        : context;
    },
    presend: {
      baseState: state,
      pendingUserText: "",
      composeAppliedState: (next) => next,
    },
  });

  const result = await controller.compactManually({
    force: true,
    budgetContext: conversationState.buildRequestContext(state),
  });

  assert.equal(result, "compacted");
  const kinds = events.map((e) => e[0]);
  const persistIndex = kinds.indexOf("persist");
  const applyIndex = kinds.indexOf("applyState");
  assert.ok(persistIndex >= 0, "persist must run");
  assert.ok(applyIndex >= 0, "apply must run");
  assert.ok(persistIndex < applyIndex, "persist before apply on prune fallback");
  const phases = events.filter((e) => e[0] === "publishStatus").map(([, s]) => s.phase);
  assert.ok(phases.includes("completed"));
  assert.ok(!phases.includes("failed"));
});

test("compactManually prune fallback does not apply when persist fails", async () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      toolResultBig(200_000, 2),
      user("continue with src/app.ts", 3),
      user("check src/app.ts again", 4),
      assistantWithUsage("working on src/app.ts", 190_000, 5),
    ],
  });
  const events = [];
  const cancellation = cancellationModule.createTurnCancellation();
  controller.bindTurn({
    providerId: "anthropic",
    model: "claude-x",
    runtime: {
      baseUrl: "https://example",
      apiKey: "k",
      modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
    },
    cancellation,
    sinks: {
      applyState: (next) => events.push(["applyState", next]),
      publishStatus: (status) => events.push(["publishStatus", status]),
      setBridgeToolStatus: (text, isCompaction) => events.push(["bridge", text, isCompaction]),
      queueCheckpoint: (next) => events.push(["queueCheckpoint", next]),
      persist: async (next) => {
        events.push(["persist", next]);
        return false;
      },
    },
    complete: async () => {
      throw new Error("invalid api key");
    },
    buildPreparedContext: (next) => conversationState.buildRequestContext(next),
    buildResumeContext: (next, resumeMessage) => {
      const context = conversationState.buildRequestContext(next);
      return resumeMessage
        ? { ...context, messages: [...context.messages, resumeMessage] }
        : context;
    },
    presend: {
      baseState: state,
      pendingUserText: "",
      composeAppliedState: (next) => next,
    },
  });

  const result = await controller.compactManually({
    force: true,
    budgetContext: conversationState.buildRequestContext(state),
  });

  assert.equal(result, "failed");
  assert.equal(events.filter((e) => e[0] === "applyState").length, 0);
  assert.ok(events.filter((e) => e[0] === "persist").length >= 1);
});

test("compactManually skips when unbound or empty", async () => {
  const controller = new CompactionController();
  assert.equal(
    await controller.compactManually({
      force: true,
      budgetContext: { systemPrompt: "sys", messages: [] },
    }),
    "skipped",
  );

  const emptyState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [],
  });
  const { recorder } = bindController(controller, {
    complete: async () => summaryResponse(),
    presend: {
      baseState: emptyState,
      pendingUserText: "",
      composeAppliedState: (state) => state,
    },
  });
  const result = await controller.compactManually({
    force: true,
    budgetContext: conversationState.buildRequestContext(emptyState),
  });
  assert.equal(result, "skipped");
  assert.equal(recorder.events.length, 0);
});
