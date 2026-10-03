import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootLoader = createTsModuleLoader();
const resolve = (specifier) => rootLoader.resolveLocal(specifier);

function assistant(text = "answer", stopReason = "stop", errorMessage) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "claude_code",
    model: "claude-test",
    usage: { input: 10, output: 4, totalTokens: 14 },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 20,
  };
}

function loadTurn(streamImpl) {
  const loader = createTsModuleLoader({
    mocks: {
      [resolve("src/lib/chat/conversation/conversationState.ts")]: {
        appendMessagesToConversation: (state, messages) => ({
          ...state,
          messages: [...(state.messages ?? []), ...messages],
        }),
        // tokenLedger.getMessageObservedTokens（轮次 meta 的权威锚点）依赖它
        // 识别压缩检查点消息；测试消息都不是检查点。
        isCompactionAssistantMessage: () => false,
      },
      [resolve("src/lib/chat/memory/extractionController.ts")]: {
        memoryExtraction: {
          noteTurnBoundary() {},
          async requestExtraction() {
            return { emittedMessages: [] };
          },
        },
      },
      [resolve("src/lib/chat/messages/uiMessages.ts")]: {
        appendTextDeltaToRound: (round) => round,
        collapseThinking: (round) => round,
        updateLiveRound: (rounds) => rounds,
        upsertHostedSearchToRound: (round) => round,
      },
      [resolve("src/lib/chat/search/providerNativeSearchStatus.ts")]: {
        resolveProviderNativeWebSearchStatus: () => null,
        createDeferredProviderNativeWebSearchStatus: () => ({
          noteVisibleActivity() {},
          schedule() {},
          pause() {},
          finish() {},
        }),
      },
      [resolve("src/lib/providers/llm.ts")]: {
        assistantMessageToText: (message) => message.content[0]?.text ?? "",
        streamAssistantMessage: streamImpl,
      },
    },
  });
  return {
    ...loader.loadModule("src/pages/chat/turns/runTextConversationTurn.ts"),
    overflow: loader.loadModule("src/lib/providers/runtime/overflow.ts"),
  };
}

function recorderHarness() {
  const calls = [];
  const recorder = {
    beginTurn: (info) => calls.push(["beginTurn", info]),
    noteContext: (info) => calls.push(["noteContext", info]),
    captureHeader: (input) => {
      calls.push(["captureHeader", input]);
      return "h_text";
    },
    stepStart: (step, headerId) => calls.push(["stepStart", step, headerId]),
    firstToken: (step) => calls.push(["firstToken", step]),
    stepEnd: (step, info) => calls.push(["stepEnd", step, info]),
    noteRetry: (step, info) => calls.push(["noteRetry", step, info]),
    toolStart() {},
    toolEnd() {},
    compactionStart() {},
    compactionEnd() {},
    endTurn: (info) => calls.push(["endTurn", info]),
    flush: async () => calls.push(["flush"]),
    dispose: async () => {},
    discard() {},
  };
  return { recorder, calls };
}

function baseParams(recorder) {
  let state = { messages: [] };
  const stop = new AbortController();
  return {
    providerId: "claude_code",
    model: "claude-test",
    runtime: { baseUrl: "https://example.test", apiKey: "test", nativeWebSearchEnabled: false },
    runtimeModel: { api: "anthropic-messages", provider: "claude_code", id: "claude-test" },
    selectedModel: { customProviderId: "provider-1", model: "claude-test" },
    sessionId: "session-1",
    conversationId: "conversation-1",
    conversationCwd: "/workspace",
    fallbackTitle: "title",
    createdAt: 1,
    titlePromise: null,
    transcriptStore: {},
    gatewayBridgeEvents: {
      queueToken() {},
      queueEvent() {},
      hasForwardedText: () => false,
    },
    hookLifecycle: {
      startAgent() {},
      startTurn() {},
      ensureMessageEnded() {},
      endTurn() {},
      endAgent() {},
    },
    conversationDebugLogger: {},
    recoveryDebugLogger: {},
    getNextConversationState: () => state,
    applyConversationState: (next) => {
      state = next;
    },
    buildPreparedContext: () => ({ systemPrompt: "BASE", messages: [] }),
    compaction: {
      contextUsageTokens: 11,
      noteFixedOverheadTokens() {},
      observeContextMessages: () => 14,
      compact: async () => ({ outcome: "skipped", reason: "below-threshold" }),
      beginRequest() {},
    },
    cancellation: {
      userStop: stop,
      deriveScope() {
        const controller = new AbortController();
        return { controller, release() {} };
      },
    },
    resetLiveTranscript() {},
    settleLiveTranscript() {},
    appendDraftAssistantText() {},
    batchLiveRoundsUpdate() {},
    updateGatewayBridgeToolStatus() {},
    updateRetryAttempts() {},
    commitVisibleAbortedConversation: () => false,
    freezeGatewayFinalProjection() {},
    persistConversationWithHistorySync: async () => true,
    trajectory: recorder,
    trajectoryTurn: 5,
    trajectoryMessageIndex: 18,
    trajectoryMessageId: "user-18",
    readTrajectorySlots: () => ({ base: "BASE" }),
  };
}

test("text mode records the exact request boundary, TTFT, terminal model and turn metadata", async () => {
  const final = assistant();
  const { runTextConversationTurn } = loadTurn(async (params) => {
    const systemSuffix = "TEXT ONLY RULES";
    params.onRequestStart?.({
      context: { ...params.context, systemPrompt: `BASE\n\n${systemSuffix}` },
      systemSuffix,
    });
    params.onTextDelta("answer");
    return final;
  });
  const { recorder, calls } = recorderHarness();

  await runTextConversationTurn(baseParams(recorder));

  assert.deepEqual(calls[0], [
    "beginTurn",
    { turn: 5, messageIndex: 18, messageId: "user-18" },
  ]);
  const header = calls.find((call) => call[0] === "captureHeader");
  assert.equal(header[1].base, "BASE");
  assert.equal(header[1].toolsSuffix, "TEXT ONLY RULES");
  assert.deepEqual(calls.find((call) => call[0] === "stepStart"), [
    "stepStart",
    1,
    "h_text",
  ]);
  assert.ok(calls.some((call) => call[0] === "firstToken" && call[1] === 1));
  const stepEnd = calls.find((call) => call[0] === "stepEnd");
  assert.equal(stepEnd[1], 1);
  assert.equal(stepEnd[2].status, "complete");
  assert.equal(stepEnd[2].provider, "claude_code");
  assert.equal(stepEnd[2].model, "claude-test");
  assert.deepEqual(stepEnd[2].usage, { input: 10, output: 4, totalTokens: 14 });
  assert.deepEqual(calls.find((call) => call[0] === "endTurn"), [
    "endTurn",
    { status: "complete" },
  ]);
  assert.equal(calls.at(-1)[0], "flush");
});

test("text mode preserves error and aborted assistant outcomes at both terminal levels", async () => {
  for (const [stopReason, expectedStatus] of [
    ["error", "error"],
    ["aborted", "aborted"],
  ]) {
    const final = assistant("request failed", stopReason, "provider exploded");
    const { runTextConversationTurn } = loadTurn(async (params) => {
      params.onRequestStart?.({ context: params.context });
      return final;
    });
    const { recorder, calls } = recorderHarness();

    await runTextConversationTurn(baseParams(recorder));

    assert.deepEqual(calls.find((call) => call[0] === "stepEnd")?.[2], {
      status: expectedStatus,
      error: "provider exploded",
      usage: { totalTokens: 14, input: 10, output: 4 },
      provider: "claude_code",
      model: "claude-test",
      api: "anthropic-messages",
      stopReason,
    });
    assert.deepEqual(calls.find((call) => call[0] === "endTurn"), [
      "endTurn",
      { status: expectedStatus, error: "provider exploded" },
    ]);
  }
});

test("text mode compacts on overflow before any generic retry, and recovers at most once", async () => {
  for (const [secondAttempt, shouldReject] of [
    ["final", false],
    ["overflow", true],
  ]) {
    const order = [];
    let streams = 0;
    const turn = loadTurn(async (params) => {
      streams += 1;
      order.push("stream");
      params.onRequestStart?.({ context: params.context });
      if (streams === 1 || secondAttempt === "overflow") {
        throw new turn.overflow.AssistantResponseError(
          "prompt is too long",
          assistant("", "error", "prompt is too long: 210000 tokens > 200000 maximum"),
        );
      }
      return assistant();
    });
    const params = baseParams(recorderHarness().recorder);
    params.compaction.compact = async ({ trigger }) => {
      order.push(`compact:${trigger}`);
      return trigger === "overflow"
        ? { outcome: "compacted", state: { messages: [] } }
        : { outcome: "skipped", reason: "below-threshold" };
    };

    const run = turn.runTextConversationTurn(params);
    if (shouldReject) await assert.rejects(run, /prompt is too long/);
    else await run;

    // 同样的输入重发必然再溢出：压缩排在通用重试之前，且每次至多恢复一次。
    assert.deepEqual(order, ["compact:pre-send", "stream", "compact:overflow", "stream"]);
  }
});
