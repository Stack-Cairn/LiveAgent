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
  assert.deepEqual(handlerCalls, [{ force: false, requestVersion: 1 }]);

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
    { force: false, requestVersion: 1 },
    { force: true, requestVersion: 2 },
  ]);
  assert.equal(runtime.consumeConversationStop("conversation-1", 1), false);
  assert.equal(runtime.isConversationStopRequested("conversation-1"), true);
  assert.equal(runtime.consumeConversationStop("conversation-1", 2), true);
  hookHarness.cleanup();
});

test("a direct queue stop pauses processing until composer Stop resumes it", async () => {
  const hookHarness = createHookHarness();
  const sendGate = deferred();
  const sendCalls = [];
  const stopRequests = new Set();
  const activeStopOptions = [];
  const controllerWrites = [];
  const sendingStateWrites = [];
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
        return null;
      },
      setConversationAbortController(conversationId, controller) {
        controllerWrites.push({ conversationId, controller });
      },
      setConversationSendingState(conversationId, value) {
        sendingStateWrites.push({ conversationId, value });
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
      requestActiveConversationStop(_conversationId, options) {
        activeStopOptions.push(options);
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
  assert.equal(queue.enqueueTextTurn("/goal pause"), true);
  assert.equal(queue.queuedChatTurnsRef.current.at(-1)?.draft.text, "/goal pause");
  assert.deepEqual(activeStopOptions, [], "queueing a command must not stop the active run");
  queue.requestQueuedChatTurnProcessing("conversation-1");
  await flushPromises();
  assert.equal(sendCalls.length, 1);

  queue.stopConversation("conversation-1");
  queue.stopConversation("conversation-1");
  assert.deepEqual(activeStopOptions, [{ force: false }, { force: true }]);
  assert.deepEqual(controllerWrites, [
    { conversationId: "conversation-1", controller: null },
  ]);
  assert.deepEqual(sendingStateWrites, [
    { conversationId: "conversation-1", value: false },
  ]);
  stopRequests.delete("conversation-1");
  sendGate.resolve(true);
  await flushPromises();
  await flushPromises();

  assert.equal(sendCalls.length, 1, "the second queued turn must remain paused after Stop");
  assert.equal(queue.queuedChatTurnsRef.current.length, 2);

  queue.stopSending();
  await flushPromises();

  assert.equal(sendCalls.length, 3, "composer Stop must drain the queued turns in order");
  assert.equal(queue.queuedChatTurnsRef.current.length, 0);
  hookHarness.cleanup();
});

test("gateway tool_answer forwards validated JSON with conversation isolation", async () => {
  const hookHarness = createHookHarness();
  const listeners = new Map();
  const responses = [];
  const answerCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "gateway_chat_queue_respond") {
            responses.push(args);
          }
          return undefined;
        },
      },
      "@tauri-apps/api/event": {
        async listen(eventName, callback) {
          listeners.set(eventName, callback);
          return () => listeners.delete(eventName);
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
        answerAskUserQuestion(toolCallId, answers, options) {
          answerCalls.push({ toolCallId, answers, options });
          if (options.conversationId !== "conversation-owner") {
            return { ok: false, message: "Question belongs to a different conversation." };
          }
          return { ok: true };
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

  hookHarness.render(() =>
    useChatTurnQueue({
      settings: {
        system: { executionMode: "chat", workdir: "", selectedSystemTools: [] },
        chatRuntimeControls: {},
      },
      currentConversationId: "conversation-owner",
      currentConversationIdRef: { current: "conversation-owner" },
      conversationRuntimeCacheRef: { current: new Map() },
      buildRuntimeEntryFromVisibleState() {
        return { workdir: "" };
      },
      isConversationRunning() {
        return false;
      },
      runningConversationIds: new Set(),
      getConversationAbortController() {
        return null;
      },
      setConversationAbortController() {},
      setConversationSendingState() {},
      requestConversationStop() {
        return false;
      },
      getConversationStopRequestVersion() {
        return 0;
      },
      isConversationStopRequested() {
        return false;
      },
      consumeConversationStop() {
        return false;
      },
      requestActiveConversationStop() {
        return false;
      },
      getConversationLiveTranscriptStore() {
        return {};
      },
      captureAbortSnapshot() {},
      updateToolStatus() {},
      composerRef: { current: null },
      pendingUploadedFiles: [],
      setPendingUploadsForConversation() {},
      clearCachedComposerDraft() {},
      displayedConversationWorkdir: "",
      sendActionRef: { current: async () => true },
    }),
  );

  const listener = listeners.get("gateway:chat-queue-request");
  assert.ok(listener);
  const answers = [{ questionId: "choice", selectedLabel: "Second" }];

  listener({
    payload: {
      requestId: "request-accepted",
      action: "tool_answer",
      conversationId: "conversation-owner",
      itemId: "call-ask-remote",
      requestJson: JSON.stringify(answers),
    },
  });
  await flushPromises();
  assert.deepEqual(answerCalls[0], {
    toolCallId: "call-ask-remote",
    answers,
    options: { conversationId: "conversation-owner" },
  });
  assert.equal(
    responses.find((response) => response.input.requestId === "request-accepted").input.accepted,
    true,
  );

  listener({
    payload: {
      requestId: "request-mismatch",
      action: "tool_answer",
      conversationId: "conversation-other",
      itemId: "call-ask-remote",
      requestJson: JSON.stringify(answers),
    },
  });
  await flushPromises();
  const mismatch = responses.find((response) => response.input.requestId === "request-mismatch");
  assert.equal(mismatch.input.accepted, false);
  assert.equal(mismatch.input.errorCode, "not_found");
  assert.match(mismatch.input.message, /different conversation/);

  listener({
    payload: {
      requestId: "request-invalid-json",
      action: "tool_answer",
      conversationId: "conversation-owner",
      itemId: "call-ask-remote",
      requestJson: "{broken",
    },
  });
  await flushPromises();
  const invalid = responses.find(
    (response) => response.input.requestId === "request-invalid-json",
  );
  assert.equal(invalid.input.accepted, false);
  assert.equal(invalid.input.errorCode, "invalid_payload");
  assert.equal(answerCalls.length, 2);

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
    clearAbortController() {
      released.push("controller");
    },
    clearSendingState() {
      released.push("sending");
    },
    clearToolStatus() {
      released.push("tool");
    },
  });
  const settling = settleChatRunFinalization(gate.promise, 20);

  assert.deepEqual(released, ["controller", "sending", "tool"]);
  assert.equal(await settling, "timed_out");
  gate.resolve();
});

test("finalization flushes the gateway stream only after history persists", async () => {
  const loader = createTsModuleLoader();
  const { finalizeChatRunInOrder } = loader.loadModule(
    "src/pages/chat/runtime/chatRunFinalization.ts",
  );
  const persistGate = deferred();
  const closeGate = deferred();
  const events = [];

  const finalization = finalizeChatRunInOrder({
    waitForPersistBarrier: async () => {
      events.push("persist:start");
      await persistGate.promise;
      events.push("persist:done");
    },
    closeBridge: async () => {
      events.push("close:start");
      await closeGate.promise;
      events.push("close:done");
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
  await flushPromises();
  assert.deepEqual(
    events,
    ["persist:start", "persist:done", "close:start"],
    "terminal checkpoint must wait for the final delta flush",
  );
  closeGate.resolve();
  await finalization;
  assert.deepEqual(events, ["persist:start", "persist:done", "close:start", "close:done", "finish"]);
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

test("terminal history persistence marks both false results and thrown errors", async () => {
  const loader = createTsModuleLoader();
  const { trackTerminalHistoryPersist } = loader.loadModule(
    "src/pages/chat/runtime/chatRunFinalization.ts",
  );
  let failures = 0;

  assert.equal(
    await trackTerminalHistoryPersist(
      async () => false,
      () => {
        failures += 1;
      },
    ),
    false,
  );
  await assert.rejects(
    trackTerminalHistoryPersist(
      async () => {
        throw new Error("history database unavailable");
      },
      () => {
        failures += 1;
      },
    ),
    /history database unavailable/,
  );
  assert.equal(failures, 2);
});
