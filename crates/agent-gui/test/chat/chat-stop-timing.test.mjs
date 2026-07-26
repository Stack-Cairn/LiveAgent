import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createHookHarness() {
  const refs = [];
  const states = [];
  const effects = [];
  let refIndex = 0;
  let stateIndex = 0;
  let effectIndex = 0;

  const react = {
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setState = (next) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setState];
    },
    useCallback(callback) {
      return callback;
    },
    useMemo(factory) {
      return factory();
    },
    useEffect(effect, deps = []) {
      const index = effectIndex++;
      const previous = effects[index];
      const changed =
        !previous ||
        deps.length !== previous.deps.length ||
        deps.some((value, depIndex) => value !== previous.deps[depIndex]);
      if (!changed) return;
      previous?.cleanup?.();
      effects[index] = { deps: [...deps], cleanup: effect() };
    },
  };

  return {
    react,
    render(run) {
      refIndex = 0;
      stateIndex = 0;
      effectIndex = 0;
      return run();
    },
    cleanup() {
      for (const effect of effects) {
        effect?.cleanup?.();
      }
    },
  };
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

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("a stop intent aborts a controller and handler registered later", () => {
  const hookHarness = createHookHarness();
  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "../../../lib/chat/conversation/conversationState": {
        createConversationStateFromContext(value) {
          return value;
        },
      },
      "../runtime/chatPageRuntime": {
        createConversationRuntimeEntry(value) {
          return {
            compactionStatus: "idle",
            isSending: false,
            errorMessage: null,
            hookWarning: null,
            workdir: "",
            selectedModel: undefined,
            ...value,
          };
        },
        setConversationRuntimeCacheEntry(cache, key, value) {
          cache.set(key, value);
        },
      },
    },
  });
  const { useChatPageRuntimeStore } = loader.loadModule(
    "src/pages/chat/hooks/useChatPageRuntimeStore.ts",
  );
  const state = { meta: { tools: [] }, messages: [] };
  const noop = () => undefined;
  const runtime = hookHarness.render(() =>
    useChatPageRuntimeStore({
      initialConversation: {
        conversationId: "conversation-1",
        sessionId: "session-1",
        createdAt: 1,
      },
      initialConversationState: state,
      currentConversationId: "conversation-1",
      conversationState: state,
      compactionStatus: "idle",
      isSending: false,
      errorMessage: null,
      hookWarning: null,
      currentConversationSessionId: "session-1",
      currentConversationCreatedAt: 1,
      currentConversationSelectedModel: undefined,
      setConversationState: noop,
      setCompactionStatus: noop,
      setIsSending: noop,
      setErrorMessage: noop,
      setHookWarning: noop,
      setCurrentConversationSessionId: noop,
      setCurrentConversationCreatedAt: noop,
      setCurrentConversationSelectedModel: noop,
      setRunningConversationIds: noop,
    }),
  );

  assert.equal(runtime.requestConversationStop("conversation-1"), false);
  const controller = new AbortController();
  runtime.setConversationAbortController("conversation-1", controller);
  assert.equal(controller.signal.aborted, true);

  const handlerCalls = [];
  const firstHandler = (options) => {
    handlerCalls.push(options);
  };
  runtime.setConversationStopHandler("conversation-1", firstHandler);
  assert.deepEqual(handlerCalls, [{ force: true, requestVersion: 1 }]);

  const replacementHandlerCalls = [];
  const replacementHandler = (options) => {
    replacementHandlerCalls.push(options);
  };
  runtime.setConversationStopHandler("conversation-1", replacementHandler);
  runtime.clearConversationStopHandler("conversation-1", firstHandler);
  assert.equal(runtime.requestConversationStop("conversation-1"), true);
  assert.equal(
    runtime.requestActiveConversationStop("conversation-1", { force: true }),
    true,
  );
  assert.deepEqual(replacementHandlerCalls, [
    { force: true, requestVersion: 1 },
    { force: true, requestVersion: 2 },
  ]);
  assert.equal(runtime.consumeConversationStop("conversation-1", 1), false);
  assert.equal(runtime.isConversationStopRequested("conversation-1"), true);
  assert.equal(runtime.consumeConversationStop("conversation-1", 2), true);

  const oldRunController = new AbortController();
  const newRunController = new AbortController();
  runtime.setConversationAbortController("conversation-1", oldRunController);
  runtime.setConversationSendingState("conversation-1", true);
  runtime.setConversationAbortController("conversation-1", newRunController);
  assert.equal(runtime.releaseConversationRun("conversation-1", oldRunController), false);
  assert.equal(runtime.isConversationRunning("conversation-1"), true);
  assert.equal(runtime.getConversationAbortController("conversation-1"), newRunController);
  assert.equal(runtime.releaseConversationRun("conversation-1", newRunController), true);
  assert.equal(runtime.isConversationRunning("conversation-1"), false);
  assert.equal(
    runtime.isConversationRunCurrent("conversation-1", newRunController),
    true,
    "UI release keeps the run identity until its asynchronous cleanup finishes",
  );
  assert.equal(runtime.finishConversationRun("conversation-1", oldRunController), false);
  assert.equal(runtime.finishConversationRun("conversation-1", newRunController), true);
  assert.equal(runtime.isConversationRunCurrent("conversation-1", newRunController), false);

  runtime.requestConversationStop("conversation-2");
  runtime.setConversationStopHandler("conversation-2", (options) => {
    assert.equal(options.force, true);
    runtime.consumeConversationStop("conversation-2", options.requestVersion);
  });
  const immediateNextRunController = new AbortController();
  runtime.setConversationAbortController("conversation-2", immediateNextRunController);
  assert.equal(
    immediateNextRunController.signal.aborted,
    false,
    "a stop already owned by the previous run must not abort the immediate next run",
  );
  hookHarness.cleanup();
});

test("a stop during queued processing never auto-starts the next turn", async () => {
  const hookHarness = createHookHarness();
  const sendGate = deferred();
  const sendCalls = [];
  const stopRequests = new Set();
  const activeStopOptions = [];
  const controller = new AbortController();
  const releaseCalls = [];
  let stopRequestVersion = 0;
  let draftText = "first queued turn";
  const composer = {
    getDraft() {
      return {
        text: draftText,
        isEmpty: false,
        segments: [{ type: "text", text: draftText }],
      };
    },
    clear() {},
    focus() {},
  };

  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "@tauri-apps/api/core": {
        async invoke() {
          return undefined;
        },
      },
      "@tauri-apps/api/event": {
        async listen() {
          return () => undefined;
        },
      },
      "../../../lib/settings": {
        isAgentExecutionMode() {
          return false;
        },
        normalizeChatRuntimeControls(value) {
          return value ?? {};
        },
        normalizeSystemToolSelection(value) {
          return Array.isArray(value) ? value : [];
        },
      },
      "../../../lib/tools/askUserQuestionTools": {
        answerAskUserQuestion() {
          return { ok: false, message: "not pending" };
        },
      },
      "../composer/composerDraftText": {
        createTextComposerDraft(text) {
          return { text, isEmpty: !text.trim(), segments: [{ type: "text", text }] };
        },
      },
      "../gateway/gatewayBridgeTypes": {
        normalizeGatewayExecutionMode(value) {
          return value;
        },
        normalizeGatewayWorkdir(value) {
          return value;
        },
      },
    },
  });
  const { useChatTurnQueue } = loader.loadModule(
    "src/pages/chat/queue/useChatTurnQueue.ts",
  );

  const queue = hookHarness.render(() =>
    useChatTurnQueue({
      settings: {
        system: {
          executionMode: "chat",
          workdir: "",
          selectedSystemTools: [],
        },
        chatRuntimeControls: {},
      },
      currentConversationId: "conversation-1",
      currentConversationIdRef: { current: "conversation-1" },
      conversationRuntimeCacheRef: { current: new Map() },
      buildRuntimeEntryFromVisibleState() {
        return { workdir: "" };
      },
      isConversationRunning() {
        return false;
      },
      runningConversationIds: new Set(),
      getConversationAbortController() {
        return controller;
      },
      releaseConversationRun(conversationId, expectedController) {
        releaseCalls.push({ conversationId, expectedController });
        return expectedController === controller;
      },
      requestConversationStop(conversationId) {
        stopRequestVersion += 1;
        const alreadyRequested = stopRequests.has(conversationId);
        stopRequests.add(conversationId);
        return alreadyRequested;
      },
      getConversationStopRequestVersion() {
        return stopRequestVersion;
      },
      isConversationStopRequested(conversationId) {
        return stopRequests.has(conversationId);
      },
      consumeConversationStop(conversationId) {
        return stopRequests.delete(conversationId);
      },
      requestActiveConversationStop(conversationId, options) {
        activeStopOptions.push(options);
        if (options.force) {
          stopRequests.delete(conversationId);
        }
        return true;
      },
      getConversationLiveTranscriptStore() {
        return {};
      },
      captureAbortSnapshot() {},
      updateToolStatus() {},
      composerRef: { current: composer },
      pendingUploadedFiles: [],
      setPendingUploadsForConversation() {},
      clearCachedComposerDraft() {},
      displayedConversationWorkdir: "",
      sendActionRef: {
        current: async (overrides) => {
          sendCalls.push(overrides);
          return sendGate.promise;
        },
      },
    }),
  );

  assert.equal(queue.enqueueCurrentComposerTurn("end"), true);
  draftText = "second queued turn";
  assert.equal(queue.enqueueCurrentComposerTurn("end"), true);
  queue.requestQueuedChatTurnProcessing("conversation-1");
  await flushPromises();
  assert.equal(sendCalls.length, 1);

  queue.stopConversation("conversation-1");
  assert.deepEqual(activeStopOptions, [{ force: true }]);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(releaseCalls, [
    { conversationId: "conversation-1", expectedController: controller },
  ]);
  sendGate.resolve(true);
  await flushPromises();
  await flushPromises();

  assert.equal(sendCalls.length, 1, "the second queued turn must remain paused after Stop");
  assert.equal(queue.queuedChatTurnsRef.current.length, 1);
  hookHarness.cleanup();
});

test("slow chat finalization cannot delay synchronous UI release", async () => {
  const loader = createTsModuleLoader();
  const { releaseChatRunUi, settleChatRunFinalization } = loader.loadModule(
    "src/pages/chat/runtime/chatRunFinalization.ts",
  );
  const gate = deferred();
  const released = [];

  releaseChatRunUi({
    releaseRun() {
      released.push("run");
      return true;
    },
    clearToolStatus() {
      released.push("tool");
    },
  });
  const settling = settleChatRunFinalization(gate.promise, 20);

  assert.deepEqual(released, ["run", "tool"]);
  assert.equal(
    releaseChatRunUi({
      releaseRun: () => false,
      clearToolStatus: () => released.push("stale-tool"),
    }),
    false,
  );
  assert.deepEqual(released, ["run", "tool"], "a stale run cannot clear the new run's tool UI");
  assert.equal(await settling, "timed_out");
  gate.resolve();
});

test("finalization flushes the gateway stream only after history persists", async () => {
  const loader = createTsModuleLoader();
  const { finalizeChatRunInOrder } = loader.loadModule(
    "src/pages/chat/runtime/chatRunFinalization.ts",
  );
  const persistGate = deferred();
  const events = [];

  const finalization = finalizeChatRunInOrder({
    waitForPersistBarrier: async () => {
      events.push("persist:start");
      await persistGate.promise;
      events.push("persist:done");
    },
    closeBridge: async () => {
      events.push("close");
    },
    finishRuntimeRun: async () => {
      events.push("finish");
    },
  });
  await flushPromises();

  // The 26f2561 invariant: the stream close / terminal snapshot must never
  // overtake history persistence, or a WebUI client can hydrate a truncated
  // conversation.
  assert.deepEqual(events, ["persist:start"], "flushes must wait for the persist barrier");

  persistGate.resolve();
  await finalization;
  assert.deepEqual(events, ["persist:start", "persist:done", "close", "finish"]);
});

test("a failing persist barrier still lets the finalization flushes run", async () => {
  const loader = createTsModuleLoader();
  const { finalizeChatRunInOrder } = loader.loadModule(
    "src/pages/chat/runtime/chatRunFinalization.ts",
  );
  const events = [];

  await finalizeChatRunInOrder({
    waitForPersistBarrier: async () => {
      throw new Error("persist failed");
    },
    closeBridge: async () => {
      events.push("close");
    },
    finishRuntimeRun: async () => {
      events.push("finish");
    },
  });

  assert.deepEqual(events, ["close", "finish"]);
});
