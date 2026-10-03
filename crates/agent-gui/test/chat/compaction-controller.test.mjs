import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// CompactionController.compact 的编排与持久化语义。摘要降级梯（summarize.ts）
// 由 compaction-summarize.test 覆盖，这里换成可编排的假实现。
// ============================================================================

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function createCompactionAbortError() {
  const error = new Error("compaction aborted");
  error.name = "AbortError";
  return error;
}

const summarizeCalls = [];
let summarizeImpl = async () => okDraft();
const loader = createTsModuleLoader({
  mocks: {
    [path.join(rootDir, "src/lib/chat/compaction/summarize.ts")]: {
      createCompactionAbortError,
      summarize: (input) => {
        summarizeCalls.push(input);
        return summarizeImpl(input);
      },
    },
  },
});
const { CompactionController, createCompactionControllerRegistry } = loader.loadModule(
  "src/lib/chat/compaction/controller.ts",
);
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const cancellationModule = loader.loadModule("src/lib/chat/conversation/turnCancellation.ts");
const bridgeModule = loader.loadModule("src/lib/chat/compaction/bridge.ts");
const { deriveContextTokens } = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");

// W 200k / O 32k：inputCap 168k，hard 158k，soft 148k。
const MODEL_CONFIG = { contextWindow: 200_000, maxOutputToken: 32_000 };
const SOFT_BAND = 150_000;
const ABOVE_HARD = 190_000;

const SUMMARY = "## Goal\nFix src/app.ts\n## Next Step\nkeep going";

function okDraft(summaryText = SUMMARY, extra = {}) {
  return {
    ok: {
      summaryText,
      promptVersion: "summary-v4",
      providerId: "anthropic",
      model: "claude-x",
      usage: { inputTokens: 5_000, outputTokens: 300, cacheReadTokens: 4_000 },
    },
    ...extra,
  };
}

// 与真实 summarize 同口径：只有 scope 中止才抛 AbortError。
function untilAborted(input) {
  return new Promise((_, reject) => {
    const fail = () => reject(createCompactionAbortError());
    if (input.signal.aborted) fail();
    else input.signal.addEventListener("abort", fail, { once: true });
  });
}

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

function user(content, timestamp, extra = {}) {
  return { role: "user", content, timestamp, ...extra };
}

function assistantWithUsage(text, totalTokens, timestamp) {
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

function bigState(totalTokens = ABOVE_HARD, extraMessages = []) {
  return conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1, { id: "u-1" }),
      user("continue with src/app.ts", 2, { id: "u-2" }),
      user("check src/app.ts again", 3, { id: "u-3" }),
      assistantWithUsage("working on src/app.ts", totalTokens, 4),
      ...extraMessages,
    ],
  });
}

// 与真实请求构建器同口径：摘要只经 checkpoint bridge 进入请求。
function requestContext(state) {
  return conversationState.buildRequestContext(state, { includeCheckpointBridge: true });
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
      queueCheckpoint: (state, contextUsageTokens) =>
        events.push(["queueCheckpoint", state, contextUsageTokens]),
      persist: async (state) => {
        events.push(["persist", state]);
        return true;
      },
      restoreComposer: () => events.push(["restoreComposer"]),
      persistRollback: async (state) => {
        events.push(["persistRollback", state]);
        return true;
      },
    },
  };
}

function createBinding(overrides = {}) {
  const recorder = createSinksRecorder();
  const binding = {
    providerId: "anthropic",
    model: "claude-x",
    runtime: { baseUrl: "https://example", apiKey: "k", modelConfig: MODEL_CONFIG },
    cancellation: cancellationModule.createTurnCancellation(),
    sinks: recorder.sinks,
    ...overrides,
  };
  return { binding, recorder, cancellation: binding.cancellation };
}

function bindController(controller, overrides) {
  const bound = createBinding(overrides);
  controller.bindTurn(bound.binding);
  return bound;
}

function compact(controller, trigger, state, extra = {}) {
  return controller.compact({ trigger, state, buildContext: requestContext, ...extra });
}

function phases(recorder) {
  return recorder.byKind("publishStatus").map(([, status]) => status.phase);
}

function observe(controller) {
  const observed = [];
  controller.setObserver({
    onStart: (info) => observed.push(["start", info]),
    onEnd: (info) => observed.push(["end", info]),
  });
  return observed;
}

function presendFor(state, text = "next question", restoreOnRollback = true) {
  const pendingUserMessage = user(text, 9, { id: "u-pending" });
  return {
    state: conversationState.appendMessagesToConversation(state, [pendingUserMessage]),
    presend: { pendingUserMessage, restoreOnRollback },
  };
}

test.beforeEach(() => {
  summarizeCalls.length = 0;
  summarizeImpl = async () => okDraft();
});

test("pre-send seals N without the pending message and persists it into N+1 in one step", async () => {
  const controller = new CompactionController();
  const observed = observe(controller);
  const { recorder } = bindController(controller);
  const { state, presend } = presendFor(bigState());

  const result = await compact(controller, "pre-send", state, { presend });

  assert.equal(result.outcome, "compacted");
  const [, persisted] = recorder.byKind("persist")[0];
  assert.equal(recorder.byKind("persist").length, 1);
  assert.equal(persisted.segments.length, 2);
  assert.equal(persisted.segments[0].messages.length, 4);
  assert.deepEqual(
    persisted.segments[1].messages.map((message) => message.id),
    ["u-pending"],
  );
  // contextTokensAfter = fixed + bridge，按组合待发送消息之前的 checkpoint 状态计算。
  const summary = persisted.segments[1].summary;
  const checkpointOnly = conversationState.replaceActiveSegmentMessages(persisted, []);
  const [, , tokensAfter] = recorder.byKind("queueCheckpoint")[0];
  assert.equal(summary.summaryMeta.stats.contextTokensAfter, tokensAfter);
  assert.equal(tokensAfter, deriveContextTokens(requestContext(checkpointOnly)));
  assert.equal(summary.summaryMeta.generatedBy.promptVersion, "summary-v4");
  assert.deepEqual(summary.summaryMeta.stats.summarizer, {
    inputTokens: 5_000,
    outputTokens: 300,
    cacheReadTokens: 4_000,
  });

  // pre-send 落地走 applyState；状态与 bridge 成对。
  assert.equal(recorder.byKind("applyState")[0][1], persisted);
  assert.equal(recorder.byKind("applyStateMidRun").length, 0);
  assert.deepEqual(phases(recorder), ["running", "completed"]);
  const bridgeEvents = recorder.byKind("bridge");
  assert.deepEqual(bridgeEvents[0].slice(1), ["0:00", true]);
  assert.equal(bridgeEvents.at(-1)[1], null);
  assert.deepEqual(
    observed.map(([kind, info]) => [kind, info.status ?? info.trigger]),
    [
      ["start", "pre-send"],
      ["end", "complete"],
    ],
  );
  assert.equal(observed[1][1].tokensAfter, tokensAfter);

  // 待发送消息既不进摘要输入也不进保留池；≥ hard 必须推进。
  const [input] = summarizeCalls;
  assert.equal(input.automatic, true);
  assert.equal(input.mustProgress, true);
  assert.equal(input.segmentMessages.length, 4);
  assert.doesNotMatch(JSON.stringify(input.messages), /next question/);
  assert.ok(summary.retainedUserMessages.every((message) => message.text !== "next question"));
});

test("below-threshold decisions are side-effect free", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller);
  const smallState = bigState(1_000);

  assert.deepEqual(await compact(controller, "pre-send", smallState), {
    outcome: "skipped",
    reason: "below-threshold",
  });
  assert.deepEqual(await compact(controller, "post-tool", smallState), {
    outcome: "skipped",
    reason: "below-threshold",
  });
  assert.equal(summarizeCalls.length, 0);
  assert.equal(recorder.events.length, 0);
});

test("single-flight: a concurrent trigger is skipped while a compaction is in flight", async () => {
  const controller = new CompactionController();
  bindController(controller);
  const { promise, release } = gate();
  summarizeImpl = async () => {
    await promise;
    return okDraft();
  };

  const first = compact(controller, "post-tool", bigState());
  await tick();
  assert.deepEqual(await compact(controller, "post-tool", bigState()), {
    outcome: "skipped",
    reason: "in-flight",
  });
  release();
  assert.equal((await first).outcome, "compacted");
  assert.equal(summarizeCalls.length, 1);
});

test("edit-resend: the pre-send base comes from the call-time state, never a pre-edit snapshot", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller);
  // 编辑前最后一次请求的配方：结尾是被删掉的旧 prompt，fork 回放必须对不上而回退。
  const preEdit = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("first request", 1, { id: "u-1" }),
      assistantWithUsage("done", ABOVE_HARD, 2),
      user("old prompt", 3, { id: "u-old" }),
    ],
  });
  controller.noteRequest({
    providerId: "anthropic",
    modelId: "claude-x",
    api: "anthropic-messages",
    shape: "agent",
    messages: requestContext(preEdit).messages,
    options: {},
    recordedAt: 1,
  });
  // replaceConversationAtMessage 之后的状态：旧 prompt 及其后缀已删，新 prompt 在末尾。
  const replaced = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [user("first request", 1, { id: "u-1" }), assistantWithUsage("done", ABOVE_HARD, 2)],
  });
  const { state, presend } = presendFor(replaced, "new prompt");

  assert.equal((await compact(controller, "pre-send", state, { presend })).outcome, "compacted");

  const [, persisted] = recorder.byKind("persist")[0];
  assert.doesNotMatch(JSON.stringify(persisted), /old prompt/);
  assert.equal(persisted.segments[0].messages.length, 2);
  assert.deepEqual(
    persisted.segments[1].messages.map((message) => message.content),
    ["new prompt"],
  );
  assert.deepEqual(
    persisted.segments[1].summary.retainedUserMessages.map((message) => message.text),
    ["first request"],
  );
  assert.doesNotMatch(JSON.stringify(summarizeCalls[0].messages), /old prompt|new prompt/);
});

test("post-tool summarizes req.state and never duplicates the pending message", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller);
  const { state, presend } = presendFor(bigState());
  const tempState = conversationState.appendMessagesToConversation(state, [
    assistantWithUsage("tool round", ABOVE_HARD, 10),
  ]);
  const forkMessages = requestContext(tempState).messages;

  // presend 只对 pre-send 生效：误传给 post-tool 也不得重复插入。
  const result = await compact(controller, "post-tool", tempState, { presend, forkMessages });

  assert.equal(result.outcome, "compacted");
  const [, persisted] = recorder.byKind("persist")[0];
  assert.equal(persisted.segments[0].messages.length, 6);
  assert.equal(persisted.segments[1].messages.length, 0);
  const pendingCopies = persisted.segments
    .flatMap((segment) => segment.messages)
    .filter((message) => message.id === "u-pending");
  assert.equal(pendingCopies.length, 1);
  assert.equal(recorder.byKind("applyStateMidRun")[0][1], persisted);
  assert.equal(recorder.byKind("applyState").length, 0);
  assert.equal(summarizeCalls[0].messages, forkMessages);
});

test("pre-send and manual fork messages replay the recorded request plus the newer suffix", async () => {
  const controller = new CompactionController();
  bindController(controller);
  const state = bigState();
  const recorded = requestContext(state).messages.slice(0, 3);
  controller.noteRequest({
    providerId: "anthropic",
    modelId: "claude-x",
    api: "anthropic-messages",
    shape: "agent",
    messages: recorded,
    options: {},
    recordedAt: 1,
  });

  await compact(controller, "pre-send", state);
  const replayed = summarizeCalls[0].messages;
  assert.equal(replayed.length, 4);
  assert.ok(recorded.every((message, index) => replayed[index] === message));
  assert.equal(replayed[3].role, "assistant");
});

test("Stop during pre-send rolls back to the base, restores the composer and persists the rollback", async () => {
  const controller = new CompactionController();
  const observed = observe(controller);
  const { recorder, cancellation } = bindController(controller);
  summarizeImpl = untilAborted;
  const { state, presend } = presendFor(bigState());

  const pending = compact(controller, "pre-send", state, { presend });
  await tick();
  cancellation.userStop.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(await controller.handleTurnAbort(), true);

  // 首次持久化已把待发送消息写进库：回滚把不含它的 base 补持久化，撤销孤儿消息。
  const [, restored] = recorder.byKind("applyStateMidRun")[0];
  assert.equal(restored.segments.length, 1);
  assert.equal(restored.segments[0].messages.length, 4);
  assert.equal(recorder.byKind("persistRollback")[0][1], restored);
  assert.equal(recorder.byKind("restoreComposer").length, 1);
  assert.equal(recorder.byKind("persist").length, 0);
  assert.deepEqual(phases(recorder), ["running", "idle"]);
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);
  assert.deepEqual(
    observed.map(([kind, info]) => [kind, info.status ?? info.trigger]),
    [
      ["start", "pre-send"],
      ["end", "aborted"],
    ],
  );
  // 快照与观察区间都已消费，再次调用不会重复发终态。
  assert.equal(await controller.handleTurnAbort(), false);
  assert.equal(observed.length, 2);
});

test("Stop during pre-send keeps the pending message when the send never cleared the composer", async () => {
  const controller = new CompactionController();
  const { recorder, cancellation } = bindController(controller);
  summarizeImpl = untilAborted;
  // 队列 / WebUI / 计划续跑：文本不在输入框里，撤销即永久丢失——交给普通中止提交保留。
  const { state, presend } = presendFor(bigState(), "queued", false);

  const pending = compact(controller, "pre-send", state, { presend });
  await tick();
  cancellation.userStop.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(await controller.handleTurnAbort(), false);
  assert.equal(recorder.byKind("persistRollback").length, 0);
  assert.equal(recorder.byKind("restoreComposer").length, 0);
  assert.deepEqual(phases(recorder), ["running", "idle"]);
});

test("Stop during pre-send keeps the pending message when the composer cannot take the draft back", async () => {
  const controller = new CompactionController();
  const { recorder, cancellation } = bindController(controller);
  // 压缩期间输入框又有了新草稿：放不回去时撤销会让已发送的消息无处可寻。
  recorder.sinks.restoreComposer = () => {
    recorder.events.push(["restoreComposer"]);
    return false;
  };
  summarizeImpl = untilAborted;
  const { state, presend } = presendFor(bigState());

  const pending = compact(controller, "pre-send", state, { presend });
  await tick();
  cancellation.userStop.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(await controller.handleTurnAbort(), false);
  assert.equal(recorder.byKind("restoreComposer").length, 1);
  assert.equal(recorder.byKind("applyStateMidRun").length, 0);
  assert.equal(recorder.byKind("persistRollback").length, 0);
  assert.deepEqual(phases(recorder), ["running", "idle"]);
});

test("Stop during post-tool rolls back to the call-time state without touching the composer", async () => {
  const controller = new CompactionController();
  const { recorder, cancellation } = bindController(controller);
  summarizeImpl = untilAborted;
  const state = bigState();

  const pending = compact(controller, "post-tool", state);
  await tick();
  cancellation.userStop.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(await controller.handleTurnAbort(), true);

  assert.equal(recorder.byKind("applyStateMidRun")[0][1], state);
  assert.equal(recorder.byKind("persistRollback")[0][1], state);
  assert.equal(recorder.byKind("restoreComposer").length, 0);
});

test("Stop right before persist rolls back instead of committing", async () => {
  const controller = new CompactionController();
  const { recorder, cancellation } = bindController(controller);
  summarizeImpl = async () => {
    cancellation.userStop.abort();
    return okDraft();
  };

  await assert.rejects(compact(controller, "post-tool", bigState()), /aborted/);
  assert.equal(recorder.byKind("persist").length, 0);
  assert.equal(await controller.handleTurnAbort(), true);
  assert.equal(recorder.byKind("persistRollback").length, 1);
});

test("Stop after a successful persist never rolls back", async () => {
  const controller = new CompactionController();
  const observed = observe(controller);
  const { recorder, cancellation } = bindController(controller);
  recorder.sinks.persist = async (state) => {
    recorder.events.push(["persist", state]);
    cancellation.userStop.abort();
    return true;
  };

  const result = await compact(controller, "post-tool", bigState());

  // 提交点之后忽略 Stop：回滚会把内存退回旧 segment，之后每次持久化都报分段回退。
  assert.equal(result.outcome, "compacted");
  assert.equal(recorder.byKind("applyStateMidRun").length, 1);
  assert.deepEqual(phases(recorder), ["running", "completed"]);
  assert.equal(await controller.handleTurnAbort(), false);
  assert.equal(recorder.byKind("persistRollback").length, 0);
  assert.deepEqual(
    observed.map(([kind, info]) => info.status ?? kind),
    ["start", "complete"],
  );
});

test("a stale late result neither persists nor settles a newer compaction", async () => {
  const controller = new CompactionController();
  const observed = observe(controller);
  const oldGate = gate();
  summarizeImpl = async () => {
    await oldGate.promise;
    return okDraft();
  };
  const old = bindController(controller);
  const oldPending = compact(controller, "post-tool", bigState());
  await tick();
  controller.unbindTurn();

  const newGate = gate();
  summarizeImpl = async () => {
    await newGate.promise;
    return okDraft("new summary");
  };
  const fresh = bindController(controller);
  const newPending = compact(controller, "post-tool", bigState());
  await tick();

  oldGate.release();
  await assert.rejects(oldPending, /abort/i);
  assert.equal(old.recorder.byKind("persist").length, 0);
  // 旧操作的收尾不得清掉新操作的进度状态。
  assert.equal(fresh.recorder.byKind("bridge").length, 1);

  newGate.release();
  assert.equal((await newPending).outcome, "compacted");
  assert.equal(fresh.recorder.byKind("persist").length, 1);
  assert.deepEqual(
    observed.map(([kind, info]) => [kind, info.status ?? info.trigger]),
    [
      ["start", "post-tool"],
      ["end", "aborted"],
      ["start", "post-tool"],
      ["end", "complete"],
    ],
  );
});

test("a stale failure keeps the newer compaction's rollback snapshot and breaker intact", async () => {
  const controller = new CompactionController();
  const oldGate = gate();
  summarizeImpl = async () => {
    await oldGate.promise;
    return { failure: { kind: "transient", message: "fork transient: 502" } };
  };
  bindController(controller);
  const oldPending = compact(controller, "post-tool", bigState());
  await tick();
  controller.unbindTurn();

  summarizeImpl = untilAborted;
  const fresh = bindController(controller);
  const { state, presend } = presendFor(bigState());
  const newPending = compact(controller, "pre-send", state, { presend });
  await tick();

  oldGate.release();
  await assert.rejects(oldPending);
  assert.equal(controller.failureStreak, 0);

  fresh.cancellation.userStop.abort();
  await assert.rejects(newPending, /aborted/);
  assert.equal(await controller.handleTurnAbort(), true);
  assert.equal(fresh.recorder.byKind("persistRollback").length, 1);
});

test("late progress never re-lights the status, and a stale operation's progress is dropped", async () => {
  const controller = new CompactionController();
  const oldGate = gate();
  summarizeImpl = async () => {
    await oldGate.promise;
    return okDraft();
  };
  bindController(controller);
  const oldPending = compact(controller, "post-tool", bigState());
  await tick();
  controller.unbindTurn();

  const fresh = bindController(controller);
  summarizeImpl = async () => okDraft();
  await compact(controller, "post-tool", bigState());
  const bridgeCount = fresh.recorder.byKind("bridge").length;
  summarizeCalls[0].onProgress("1.0k · 0:03");
  summarizeCalls[1].onProgress("2.0k · 0:04");
  assert.equal(fresh.recorder.byKind("bridge").length, bridgeCount);
  assert.equal(fresh.recorder.byKind("bridge").at(-1)[1], null);

  oldGate.release();
  await assert.rejects(oldPending);
});

test("a throwing sink after the commit point still settles completed and runs the rest", async () => {
  const controller = new CompactionController();
  const observed = observe(controller);
  const { recorder } = bindController(controller);
  recorder.sinks.applyStateMidRun = () => {
    throw new Error("render failed");
  };

  const result = await compact(controller, "post-tool", bigState());

  assert.equal(result.outcome, "compacted");
  assert.deepEqual(phases(recorder), ["running", "completed"]);
  assert.equal(recorder.byKind("queueCheckpoint").length, 1);
  assert.equal(observed.at(-1)[1].status, "complete");
  assert.equal(await controller.handleTurnAbort(), false);
});

test("persist barrier: false or null settles failed and applies nothing", async () => {
  for (const rejected of [false, null]) {
    const controller = new CompactionController();
    const { recorder } = bindController(controller);
    recorder.sinks.persist = async (state) => {
      recorder.events.push(["persist", state]);
      return rejected;
    };

    const result = await compact(controller, "post-tool", bigState());

    assert.equal(result.outcome, "failed");
    assert.match(result.message, /persistence failed/);
    assert.equal(recorder.byKind("persist").length, 1);
    assert.equal(recorder.byKind("applyStateMidRun").length, 0);
    assert.equal(recorder.byKind("queueCheckpoint").length, 0);
    assert.deepEqual(phases(recorder), ["running", "failed"]);
    // 什么都没落地：之后的 Stop 不得回滚。
    assert.equal(await controller.handleTurnAbort(), false);
  }
});

test("the revision-stamped state returned by persist is what gets applied", async () => {
  const stamp = (recorder, revision) => {
    recorder.sinks.persist = async (state) => {
      recorder.events.push(["persist", state]);
      return { ...state, transcript: { ...state.transcript, revision } };
    };
  };

  const midRun = new CompactionController();
  const { recorder } = bindController(midRun);
  stamp(recorder, "conv:100:1:2:4");
  const result = await compact(midRun, "post-tool", bigState());
  assert.equal(recorder.byKind("persist")[0][1].transcript.revision, null);
  assert.equal(recorder.byKind("applyStateMidRun")[0][1].transcript.revision, "conv:100:1:2:4");
  assert.equal(recorder.byKind("queueCheckpoint")[0][1].transcript.revision, "conv:100:1:2:4");
  assert.equal(result.state.transcript.revision, "conv:100:1:2:4");

  // pre-send 持久化的就是含待发送消息的组合状态：盖章即可直接落地，无需补盖。
  const preSend = new CompactionController();
  const bound = bindController(preSend);
  stamp(bound.recorder, "conv:200:1:2:5");
  const { state, presend } = presendFor(bigState());
  await compact(preSend, "pre-send", state, { presend });
  const [, applied] = bound.recorder.byKind("applyState")[0];
  assert.equal(applied.transcript.revision, "conv:200:1:2:5");
  assert.equal(applied.segments.at(-1).messages.at(-1).id, "u-pending");
});

test("a degraded checkpoint settles as completed and the observer sees complete", async () => {
  const controller = new CompactionController();
  const observed = observe(controller);
  const { recorder } = bindController(controller);
  summarizeImpl = async () =>
    okDraft("## Unsummarized activity", { degraded: "fork stall: stream stalled" });

  const result = await compact(controller, "post-tool", bigState());

  assert.equal(result.degraded, "fork stall: stream stalled");
  const completed = recorder.byKind("publishStatus").at(-1)[1];
  assert.equal(completed.phase, "completed");
  assert.equal(completed.degraded, "fork stall: stream stalled");
  assert.equal(observed.at(-1)[1].status, "complete");
});

test("non-abort failures, including abort-named ones, settle failed instead of aborting", async () => {
  const controller = new CompactionController();
  const observed = observe(controller);
  const { recorder } = bindController(controller);
  summarizeImpl = async () => {
    const error = new Error("summary deadline reached");
    error.name = "AbortError";
    throw error;
  };

  const result = await compact(controller, "post-tool", bigState());

  assert.deepEqual(result, { outcome: "failed", message: "summary deadline reached" });
  assert.deepEqual(phases(recorder), ["running", "failed"]);
  assert.deepEqual(
    observed.map(([kind, info]) => info.status ?? kind),
    ["start", "error"],
  );
  assert.equal(await controller.handleTurnAbort(), false);
});

test("automatic triggers may degrade to deterministic; manual never does", async () => {
  const controller = new CompactionController();
  bindController(controller);
  await compact(controller, "overflow", bigState(SOFT_BAND));
  assert.deepEqual(
    [summarizeCalls[0].automatic, summarizeCalls[0].mustProgress, summarizeCalls[0].startAt],
    [true, true, "transcript"],
  );
  controller.unbindTurn();

  const { binding } = createBinding();
  await controller.compactManually(binding, { state: bigState(), buildContext: requestContext });
  assert.equal(summarizeCalls[1].automatic, false);
  assert.equal(summarizeCalls[1].mustProgress, false);
});

test("the failure breaker only gates [soft, hard); at hard compaction always proceeds", async () => {
  const controller = new CompactionController();
  bindController(controller);
  summarizeImpl = async () => ({ failure: { kind: "transient", message: "fork transient: 502" } });
  assert.equal((await compact(controller, "post-tool", bigState(SOFT_BAND))).outcome, "failed");
  assert.equal((await compact(controller, "post-tool", bigState(SOFT_BAND))).outcome, "failed");

  summarizeImpl = async () => okDraft();
  assert.deepEqual(await compact(controller, "post-tool", bigState(SOFT_BAND)), {
    outcome: "skipped",
    reason: "circuit-open",
  });
  assert.equal(summarizeCalls.length, 2);
  assert.equal((await compact(controller, "post-tool", bigState())).outcome, "compacted");
  // 成功后熔断复位。
  assert.equal((await compact(controller, "post-tool", bigState(SOFT_BAND))).outcome, "compacted");
});

test("the thrash guard only gates [soft, hard) and retains nothing once thrashing", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller);
  // 初值 ∞：本轮第一次压缩不算抖动——紧挨着三次之后 [soft, hard) 仍可压缩，第四次才
  // 累计到上限。
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await compact(controller, "post-tool", bigState())).outcome, "compacted");
  }
  assert.ok(recorder.byKind("persist")[0][1].segments[1].summary.retainedUserMessages.length > 0);
  assert.equal((await compact(controller, "post-tool", bigState(SOFT_BAND))).outcome, "compacted");

  assert.deepEqual(await compact(controller, "post-tool", bigState(SOFT_BAND)), {
    outcome: "skipped",
    reason: "circuit-open",
  });
  assert.equal((await compact(controller, "post-tool", bigState())).outcome, "compacted");
  assert.equal(recorder.byKind("persist").at(-1)[1].segments[1].summary.retainedUserMessages, undefined);

  // 防抖动只管一轮之内：重新绑定后 [soft, hard) 恢复压缩。
  bindController(controller);
  assert.equal((await compact(controller, "post-tool", bigState(SOFT_BAND))).outcome, "compacted");
});

test("two consecutive checkpoints preserve the exact authoritative task state", async () => {
  const controller = new CompactionController();
  bindController(controller);
  const taskList = {
    runId: "run-through-two-compactions",
    revision: 5,
    nextTaskId: 3,
    tasks: [
      {
        id: "1",
        subject: "Inspect compaction",
        description: "Verify task state survives every checkpoint",
        activeForm: "Inspecting compaction",
        status: "completed",
      },
    ],
  };
  const first = await compact(
    controller,
    "post-tool",
    conversationState.setTaskListState(bigState(), taskList),
  );
  assert.deepEqual(first.state.meta.taskList, taskList);

  const second = await compact(
    controller,
    "post-tool",
    conversationState.appendMessagesToConversation(first.state, [
      user("continue task 2", 20),
      assistantWithUsage("continuing the same task", ABOVE_HARD, 21),
    ]),
  );
  assert.equal(second.outcome, "compacted");
  assert.deepEqual(second.state.meta.taskList, taskList);
});

test("registry hands out one controller per conversation and disposes cleanly", () => {
  const registry = createCompactionControllerRegistry();
  const a = registry.get("conv-a");
  assert.equal(registry.get("conv-a"), a);
  assert.notEqual(registry.get("conv-b"), a);
  registry.dispose("conv-a");
  assert.notEqual(registry.get("conv-a"), a);
});

test("beginRequest exposes the current total and dynamic fixed-token snapshot", () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "x".repeat(400),
    messages: [],
  });

  controller.beginRequest(conversationState.buildRequestContext(state), state);

  assert.deepEqual(controller.contextUsageSnapshot, { totalTokens: 100, fixedTokens: 100 });
});

// —— 手动压缩（用量环 / compact_now 入口）——

function manual(controller, binding, state, extra = {}) {
  return controller.compactManually(binding, { state, buildContext: requestContext, ...extra });
}

test("compactManually: busy while bound, 50% gate without residue, onProceed exactly once", async () => {
  const controller = new CompactionController();
  bindController(controller);
  assert.deepEqual(await manual(controller, createBinding().binding, bigState()), {
    outcome: "busy",
  });
  controller.unbindTurn();

  const activeState = bigState();
  controller.beginRequest(requestContext(activeState), activeState);
  const before = controller.contextUsageTokens;
  let proceedCalls = 0;
  const onProceed = () => {
    proceedCalls += 1;
  };

  // 锚点 = usage 纯算术，99_000 停在 100_000（50%）门槛之下。
  const rejected = createBinding();
  assert.deepEqual(
    await manual(controller, rejected.binding, bigState(99_000), { onProceed }),
    { outcome: "skipped", reason: "below-manual-threshold" },
  );
  assert.equal(proceedCalls, 0);
  assert.equal(rejected.recorder.events.length, 0);
  // 共享账本是用量环的读数真源：被拒的探针不得在其上留下任何残留。
  assert.equal(controller.contextUsageTokens, before);

  const accepted = createBinding();
  const result = await manual(controller, accepted.binding, bigState(100_000), {
    onProceed: () => {
      onProceed();
      // onProceed 在决策通过之后、running 状态发布之前同步触发。
      assert.equal(accepted.recorder.byKind("publishStatus").length, 0);
    },
  });
  assert.equal(result.outcome, "compacted");
  assert.equal(proceedCalls, 1);
  assert.deepEqual(phases(accepted.recorder), ["running", "completed"]);
  assert.equal(accepted.recorder.byKind("applyStateMidRun").length, 1);
  // 解绑后可再次手动压缩（不被残留 binding 卡成 busy）。
  assert.notEqual((await manual(controller, createBinding().binding, bigState())).outcome, "busy");
});

test("compactManually keeps the disabled hard guard and reports failures with their message", async () => {
  const controller = new CompactionController();
  const disabled = createBinding({
    runtime: { baseUrl: "https://example", apiKey: "k", modelConfig: undefined },
  });
  assert.deepEqual(await manual(controller, disabled.binding, bigState()), {
    outcome: "skipped",
    reason: "disabled",
  });
  assert.equal(disabled.recorder.events.length, 0);

  summarizeImpl = async () => ({ failure: { kind: "fatal", message: "fork fatal: 401" } });
  const failing = createBinding();
  assert.deepEqual(await manual(controller, failing.binding, bigState()), {
    outcome: "failed",
    message: "fork fatal: 401",
  });
  assert.equal(failing.recorder.byKind("persist").length, 0);
  assert.deepEqual(phases(failing.recorder), ["running", "failed"]);
});

test("compactManually reports aborted when the user stops mid-compaction", async () => {
  const controller = new CompactionController();
  const { binding, recorder, cancellation } = createBinding();
  summarizeImpl = untilAborted;

  const pending = manual(controller, binding, bigState());
  await tick();
  cancellation.userStop.abort();

  assert.deepEqual(await pending, { outcome: "aborted" });
  assert.deepEqual(phases(recorder), ["running", "idle"]);
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);
});

// 压缩后的无锚点窗口（新 segment 尚无真实 usage）：空闲环显示检查点权威值，
// 发送后运行中环改读账本。现算估算的任何输入漂移（激活工具子集收窄、memory
// 段重冻结、重启丢 overhead）都可能低于检查点值——账本必须以检查点为 fixed
// 下界，否则环先倒退、首个真实 usage 到达再跳涨。
test("post-compaction beginRequest never dips below the checkpoint anchor", async () => {
  const controller = new CompactionController();
  const { binding, recorder } = createBinding();
  // 大 fixedTokens 快照抬高检查点权威值，模拟“检查点值 > 下一次发送的现算估算”。
  const result = await manual(controller, binding, bigState(1_000), {
    usage: { totalTokens: 100_000, fixedTokens: 40_000 },
  });
  assert.equal(result.outcome, "compacted");
  const [, checkpointState, checkpointTokens] = recorder.byKind("queueCheckpoint")[0];
  assert.ok(checkpointTokens >= 40_000);

  // 检查点值 = fixed + 单独成条的 bridge；账本下界扣回 bridge（bridge 另作消息计入）。
  const summary = checkpointState.segments[checkpointState.activeSegmentIndex].summary;
  const bridgeTokens = bridgeModule.estimateCheckpointBridgeTokens(summary);
  assert.ok(bridgeTokens > 0);

  const nextState = conversationState.appendMessagesToConversation(checkpointState, [
    user("接着做下一件事", 30),
  ]);
  const nextContext = requestContext(nextState);
  assert.equal(nextContext.messages.length, 1);
  const total = controller.beginRequest(nextContext, nextState);
  assert.equal(controller.contextFixedTokens, checkpointTokens - bridgeTokens);
  assert.ok(total >= checkpointTokens);

  // 跨重启：全新控制器从持久化状态恢复同一下界。
  assert.ok(new CompactionController().beginRequest(nextContext, nextState) >= checkpointTokens);

  // 真实 usage 锚点出现后，下界退场、读数回到锚点算术。
  controller.observeContextMessages([assistantWithUsage("done", 41_000, 31)]);
  assert.equal(controller.contextUsageTokens, 41_000);
});
