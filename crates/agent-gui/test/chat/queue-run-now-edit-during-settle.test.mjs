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

// 场景：点「立即发送」后被打断的那一轮仍在收尾（turn.ts 最多再等 10 秒终止事件），
// 队列在 waitForPreviousRunToFinish 里轮询。界面此时已不在运行，队首（刚被置顶的
// 插队项）仍可点「编辑」。编辑把它移进输入框并在队首留下编辑槽位；进入处理前的
// isQueuedChatTurnEditBlockingProcessing 只在等待开始前检查过一次。
test("editing the promoted head while the interrupted run settles must not let the next item jump ahead", async () => {
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
  const [head] = queue.queuedChatTurnsRef.current;
  assert.equal(head.draft.text, "run-now target");

  // 运行集变化后触发的处理：旧一轮还持有停止处理器，进入等待。
  queue.requestQueuedChatTurnProcessing("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(state.sends.length, 0);

  // 用户在等待期间编辑队首。
  queue.editQueuedTurn(head.id);
  assert.equal(state.draft, "run-now target", "the head moved into the composer");
  assert.equal(queue.queuedChatTurnsRef.current.length, 1);

  // 旧一轮收尾结束。
  state.previousRunAlive = false;
  await waitUntil(() => state.sends.length > 0, 600);

  assert.deepEqual(
    state.sends,
    [],
    "an open edit slot at the head must keep blocking the queue, as it does when processing starts",
  );
  hookHarness.cleanup();
});
