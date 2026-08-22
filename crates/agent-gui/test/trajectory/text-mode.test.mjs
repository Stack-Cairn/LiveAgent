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
      [resolve("src/pages/chat/runtime/chatPageRuntime.ts")]: {
        buildPartialAssistantMessage: () => null,
      },
    },
  });
  return loader.loadModule("src/pages/chat/turns/runTextConversationTurn.ts");
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesPromptly(promise) {
  let timeoutId = null;
  const timedOut = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), 100);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
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
      observeContextMessages: () => 14,
      maybeCompactPreSend: async () => {},
      beginRequest() {},
      shouldProtectMidStream: () => false,
      compactDuringRun: async () => ({ context: null, shouldDisableProtection: false }),
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

test("text mode releases a completed response when its terminal history write stalls", async () => {
  const final = assistant();
  const { runTextConversationTurn } = loadTurn(async (params) => {
    params.onRequestStart?.({ context: params.context });
    return final;
  });
  const { recorder } = recorderHarness();
  const params = baseParams(recorder);
  const persistStarted = deferred();
  const persistGate = deferred();
  let committed = 0;
  params.onTerminalResponseCommitted = () => {
    committed += 1;
  };
  params.persistConversationWithHistorySync = () => {
    persistStarted.resolve();
    return persistGate.promise;
  };

  const run = runTextConversationTurn(params);
  await persistStarted.promise;
  assert.equal(committed, 1);

  params.cancellation.userStop.abort();
  assert.equal(await settlesPromptly(run), true);

  persistGate.resolve(true);
  await run;
});

test("text mode does not wait for diagnostic trajectory persistence", async () => {
  const final = assistant();
  const { runTextConversationTurn } = loadTurn(async (params) => {
    params.onRequestStart?.({ context: params.context });
    return final;
  });
  const { recorder } = recorderHarness();
  const flushGate = deferred();
  let flushes = 0;
  recorder.flush = () => {
    flushes += 1;
    return flushGate.promise;
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const run = runTextConversationTurn(baseParams(recorder));
    assert.equal(await settlesPromptly(run), true);
    assert.equal(flushes, 1);

    flushGate.reject(new Error("late trajectory persistence failure"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = originalWarn;
  }
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
