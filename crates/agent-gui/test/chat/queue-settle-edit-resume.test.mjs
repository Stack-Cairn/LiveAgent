import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Same minimal React hook harness as test/chat/chat-stop-timing.test.mjs.
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
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
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
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}

const textDraft = (text) => ({
  text,
  isEmpty: !text.trim(),
  segments: text ? [{ type: "text", text }] : [],
});

function renderQueue(hookHarness, state) {
  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "@tauri-apps/api/core": { async invoke() {} },
      "@tauri-apps/api/event": {
        async listen() {
          return () => undefined;
        },
      },
      "../../../lib/settings": {
        isAgentExecutionMode: () => false,
        normalizeChatRuntimeControls: (value) => value ?? {},
        normalizeSystemToolSelection: (value) => (Array.isArray(value) ? value : []),
      },
      "../../../lib/tools/askUserQuestionTools": {
        answerAskUserQuestion: () => ({ ok: false, message: "not pending" }),
      },
      "../composer/composerDraftText": { createTextComposerDraft: textDraft },
      "../gateway/gatewayBridgeTypes": {
        gatewayComposerTurnCommand: () => undefined,
        normalizeGatewayCommandSafetyMode: (value) => value,
        normalizeGatewayExecutionMode: (value) => value,
        normalizeGatewayWorkdir: (value) => value,
      },
    },
  });
  const { useChatTurnQueue } = loader.loadModule("src/pages/chat/queue/useChatTurnQueue.ts");
  const stores = new Map();
  return hookHarness.render(() =>
    useChatTurnQueue({
      settings: {
        system: { executionMode: "chat", workdir: "", commandSafetyMode: "sandboxOffline" },
        chatRuntimeControls: {},
      },
      currentConversationId: "conversation-1",
      currentConversationIdRef: { current: "conversation-1" },
      conversationRuntimeCacheRef: { current: new Map() },
      buildRuntimeEntryFromVisibleState: () => ({ workdir: "" }),
      isConversationRunning: () => state.running,
      runningConversationIds: new Set(),
      getConversationAbortController: () => null,
      setConversationAbortController() {},
      setConversationSendingState() {},
      requestConversationStop: () => false,
      getConversationStopRequestVersion: () => 0,
      isConversationStopRequested: () => false,
      consumeConversationStop: () => true,
      hasConversationStopHandler: () => state.previousRunAlive,
      requestActiveConversationStop: () => true,
      getConversationLiveTranscriptStore: (id) => {
        if (!stores.has(id)) stores.set(id, { conversationId: id });
        return stores.get(id);
      },
      captureAbortSnapshot() {},
      updateToolStatus() {},
      composerRef: {
        current: {
          getDraft: () => textDraft(state.draft),
          setDraft: (draft) => {
            state.draft = draft.text;
          },
          clear() {
            state.draft = "";
          },
          focus() {},
        },
      },
      pendingUploadedFiles: [],
      setPendingUploadsForConversation() {},
      clearCachedComposerDraft() {},
      displayedConversationWorkdir: "",
      sendActionRef: {
        current: async (overrides) => {
          state.sends.push(overrides.composerDraftOverride.text);
          return true;
        },
      },
    }),
  );
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}


async function setup() {
  globalThis.window ??= {};
  globalThis.window.requestAnimationFrame ??= () => 0;
  const hookHarness = createHookHarness();
  const state = { running: false, previousRunAlive: true, draft: "", sends: [] };
  const queue = renderQueue(hookHarness, state);
  state.draft = "run-now target";
  assert.equal(queue.enqueueCurrentComposerTurn("end"), true);
  state.draft = "later item";
  assert.equal(queue.enqueueCurrentComposerTurn("end"), true);
  state.draft = "";
  return { hookHarness, state, queue };
}

// 第一轮 P2 修复后：等待收尾期间打开编辑 → 处理被挡住返回 false。提交编辑
// （ChatPage.handleSend 的 enqueueCurrentComposerTurn("edit") + 触发处理）后队列必须继续，
// 且编辑后的队首先发。
test("committing the head edit after the settle wait was blocked resumes the queue in order", async () => {
  const { hookHarness, state, queue } = await setup();
  const [head] = queue.queuedChatTurnsRef.current;
  queue.requestQueuedChatTurnProcessing("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  queue.editQueuedTurn(head.id);
  state.previousRunAlive = false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(state.sends, []);

  state.draft = "run-now target (edited)";
  assert.equal(queue.enqueueCurrentComposerTurn("edit"), true);
  queue.requestQueuedChatTurnProcessing("conversation-1");
  assert.ok(await waitUntil(() => state.sends.length >= 2, 1_500), `sends=${JSON.stringify(state.sends)}`);
  assert.deepEqual(state.sends, ["run-now target (edited)", "later item"]);
  hookHarness.cleanup();
});

// 编辑在等待仍未结束时就提交：触发被处理中守卫吞掉，原等待循环结束后必须发出编辑后的队首。
test("committing the head edit while still waiting for settle is picked up by the pending processing", async () => {
  const { hookHarness, state, queue } = await setup();
  const [head] = queue.queuedChatTurnsRef.current;
  queue.requestQueuedChatTurnProcessing("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  queue.editQueuedTurn(head.id);
  state.draft = "edited early";
  assert.equal(queue.enqueueCurrentComposerTurn("edit"), true);
  queue.requestQueuedChatTurnProcessing("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(state.sends, []);
  state.previousRunAlive = false;
  assert.ok(await waitUntil(() => state.sends.length >= 2, 1_500), `sends=${JSON.stringify(state.sends)}`);
  assert.deepEqual(state.sends, ["edited early", "later item"]);
  hookHarness.cleanup();
});

// 新一轮在等待期间由别处开始（例如输入框手动发送）：等待放弃且不发送；该轮结束后的
// 触发能继续排空队列。
test("a run started elsewhere during the settle wait aborts the wait and later processing still drains", async () => {
  const { hookHarness, state, queue } = await setup();
  queue.requestQueuedChatTurnProcessing("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  state.running = true;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(state.sends, []);
  state.running = false;
  state.previousRunAlive = false;
  queue.requestQueuedChatTurnProcessing("conversation-1");
  assert.ok(await waitUntil(() => state.sends.length >= 2, 1_500), `sends=${JSON.stringify(state.sends)}`);
  assert.deepEqual(state.sends, ["run-now target", "later item"]);
  hookHarness.cleanup();
});
