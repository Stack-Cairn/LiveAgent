import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 桌面用户正在编辑队首（编辑槽打开、队首已移入输入框）时，WebUI 发来 /goal。
// 指令轮次不进等待队列，空闲时直跑；但直跑会走 useSendChatTurn 的非
// preserveComposerOnStart 路径，清掉输入框里正在编辑的排队项。桌面输入框本地发指令时
// isDraftReserved 为真，指令不会执行；bridge 同样按忙拒绝（ChatPage 传 isQueuedTurnEditOpen）。
//
// 真实模块：useChatTurnQueue、useGatewayBridgeListeners、useSendChatTurn。
// resetVisibleTransientState 按 ChatPage.tsx（968 行起）的实现：可见会话时 composerRef.clear()。

const CONVERSATION_ID = "conversation-1";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = (name) => path.join(root, "src", name);

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
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
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
  textWithoutLargePastes: text,
  largePastes: [],
  conversationMentions: [],
  isEmpty: !text.trim(),
  segments: text ? [{ type: "text", text }] : [],
});

function createComposer() {
  const composer = {
    draft: textDraft(""),
    getDraft: () => composer.draft,
    setDraft(draft) {
      composer.draft = textDraft(draft?.text ?? "");
    },
    clear() {
      composer.draft = textDraft("");
    },
    hasContent: () => !composer.draft.isEmpty,
    focus() {},
  };
  return composer;
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function renderQueue(state) {
  const hookHarness = createHookHarness();
  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "@tauri-apps/api/core": { invoke: async () => undefined },
      "@tauri-apps/api/event": { listen: async () => () => undefined },
      "../../../lib/settings": {
        isAgentExecutionMode: () => false,
        normalizeChatRuntimeControls: (value) => value ?? {},
        normalizeSystemToolSelection: (value) => (Array.isArray(value) ? value : []),
      },
      "../../../lib/tools/askUserQuestionTools": {
        answerAskUserQuestion: () => ({ ok: false, message: "not pending" }),
      },
      "../composer/composerDraftText": { createTextComposerDraft: textDraft },
    },
  });
  const { useChatTurnQueue } = loader.loadModule("src/pages/chat/queue/useChatTurnQueue.ts");
  return hookHarness.render(() =>
    useChatTurnQueue({
      settings: {
        system: { executionMode: "chat", workdir: "", commandSafetyMode: "sandboxOffline" },
        chatRuntimeControls: {},
      },
      currentConversationId: CONVERSATION_ID,
      currentConversationIdRef: { current: CONVERSATION_ID },
      conversationRuntimeCacheRef: state.cacheRef,
      buildRuntimeEntryFromVisibleState: () => ({ workdir: "" }),
      isConversationRunning: () => false,
      runningConversationIds: new Set(),
      getConversationAbortController: () => null,
      setConversationAbortController() {},
      setConversationSendingState() {},
      requestConversationStop: () => false,
      getConversationStopRequestVersion: () => 0,
      isConversationStopRequested: () => false,
      consumeConversationStop: () => true,
      hasConversationStopHandler: () => false,
      requestActiveConversationStop: () => true,
      getConversationLiveTranscriptStore: (id) => ({ conversationId: id }),
      captureAbortSnapshot() {},
      updateToolStatus() {},
      composerRef: { current: state.composer },
      pendingUploadedFiles: [],
      setPendingUploadsForConversation() {},
      clearCachedComposerDraft() {},
      displayedConversationWorkdir: "",
      sendActionRef: { current: async () => true },
    }),
  );
}

function createRealSend(state) {
  const capabilities = {
    frontendContext: false,
    gatewayMirror: false,
    checkpoints: false,
    trajectory: false,
  };
  const loader = createTsModuleLoader({
    mocks: {
      react: { useCallback: (callback) => callback },
      [source("lib/host.ts")]: {
        liveAgentRuntimeCapabilities: () => capabilities,
        isKBrainBackendEnabled: () => true,
        isKBrainBrowserHost: () => false,
        isTauriHost: () => true,
      },
      "@tauri-apps/api/core": { invoke: async () => undefined },
      [source("lib/trajectory/recorderRegistry.ts")]: {
        acquireTrajectoryRecorder: () => null,
        resolveTrajectoryTurnNumber: () => 0,
      },
      [source("pages/chat/runtime/conversationTitleJob.ts")]: {
        startConversationTitleJob: () => null,
      },
      [source("lib/providers/llm.ts")]: {
        createProviderRuntimeConfig: () => ({ backend: "kbrain", baseUrl: "", modelConfig: {} }),
        createModelFromConfig: () => ({ id: "model", provider: "openai", api: "openai-completions" }),
      },
    },
  });
  const { getDefaultSettings } = loader.loadModule("src/lib/settings/index.ts");
  const settings = getDefaultSettings();
  settings.system.executionMode = "chat";
  settings.selectedModel = { customProviderId: "backend", model: "model" };
  settings.customProviders = [{ id: "backend", type: "codex", activeModels: ["model"] }];
  const { createConversationStateFromContext } = loader.loadModule(
    "src/lib/chat/conversation/conversationState.ts",
  );
  state.cacheRef.current.set(CONVERSATION_ID, {
    state: createConversationStateFromContext({ systemPrompt: "", messages: [] }),
    sessionId: "s",
    createdAt: 1,
    compactionStatus: { phase: "idle" },
    isSending: false,
  });
  const cache = state.cacheRef.current;
  const noop = () => {};
  const currentConversationIdRef = { current: CONVERSATION_ID };
  const { useSendChatTurn } = loader.loadModule("src/pages/chat/runtime/useSendChatTurn.ts");
  const { send } = useSendChatTurn({
    settings,
    workspaceProjects: [],
    setSettings: noop,
    getMcpSettings: () => ({}),
    getToolPolicies: () => ({}),
    t: (key) => key,
    sidebarStore: { peek: () => undefined, upsertLocal: noop, removeLocal: noop },
    titleJobRef: { current: null },
    chatRuntimeHost: {
      runTurn: async ({ params }) => {
        state.runTurns.push(params);
      },
    },
    subagentStoresRef: { current: { get: () => ({}) } },
    scrollFollowRef: { current: null },
    composerRef: { current: state.composer },
    composerDraftCacheRef: { current: new Map() },
    clearCachedComposerDraft: noop,
    // ChatPage.tsx resetVisibleTransientState：只对可见会话清输入框与附件。
    resetVisibleTransientState: (targetConversationId = currentConversationIdRef.current) => {
      if (currentConversationIdRef.current !== targetConversationId) return;
      state.composer.clear();
    },
    isImportingPastedTextRef: { current: false },
    setIsImportingPastedText: noop,
    setErrorMessage: noop,
    hydration: { isHydrating: () => false, isFailed: () => false },
    currentConversationIdRef,
    conversationRuntimeCacheRef: state.cacheRef,
    updateConversationRuntimeEntry: (id, update) => cache.set(id, update(cache.get(id))),
    setConversationAbortController: noop,
    getConversationStopRequestVersion: () => 0,
    isConversationStopRequested: () => false,
    consumeConversationStop: noop,
    setConversationStopHandler: noop,
    clearConversationStopHandler: noop,
    setConversationSendingState: noop,
    pendingUploadedFiles: [],
    getPendingUploadsForConversation: () => [],
    setPendingUploadsForConversation: noop,
    getConversationLiveTranscriptStore: () => ({
      getSnapshot: () => ({ liveRounds: [], draftAssistantText: "" }),
    }),
    getCompactionController: () => null,
    clearAbortSnapshot: noop,
    resetLiveTranscript: noop,
    settleLiveTranscript: noop,
    updateToolStatus: noop,
    queueGatewayBridgeEventForRequest: noop,
    flushGatewayBridgeEventsForRequest: noop,
    registerGatewayRunMirror: noop,
    finishGatewayRunMirror: noop,
    gatewayBridgeHistorySummaryRef: { current: new Map() },
    availableSkills: [],
    skillsRootDir: "/desktop/skills",
    refreshSkills: async () => [],
    persistConversation: async () => ({}),
    pruneIdleConversationCaches: noop,
    requestQueuedChatTurnProcessing: noop,
  });
  return send;
}

async function deliverToBridge(claim, state, queue, send) {
  const hookHarness = createHookHarness();
  const target = () => ({ addEventListener() {}, removeEventListener() {} });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    ...target(),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
  };
  globalThis.document = { ...target(), visibilityState: "visible" };
  const registry = globalThis.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__;
  registry?.activeRequests?.clear();
  registry?.pendingRequestIds?.clear();
  registry?.pendingClientRequestIds?.clear();
  registry?.pendingConversationIds?.clear();
  try {
    const claims = [claim];
    const loader = createTsModuleLoader({
      mocks: {
        react: hookHarness.react,
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            state.invokes.push({ command, payload });
            if (command === "gateway_chat_claim_next") return claims.shift() ?? null;
            return undefined;
          },
        },
        "@tauri-apps/api/event": { listen: async () => () => undefined },
        "../../../lib/settings": { normalizeChatRuntimeControls: (value) => value },
      },
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );
    hookHarness.render(() =>
      useGatewayBridgeListeners({
        currentConversationIdRef: { current: state.background ? "other-conversation" : CONVERSATION_ID },
        conversationRuntimeCacheRef: state.cacheRef,
        ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
        sendActionRef: {
          current: async (overrides) => {
            state.bridgeSends.push(overrides);
            return send(overrides);
          },
        },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest: queue.shouldQueueGatewayChatRequest,
        enqueueGatewayChatRequest: queue.enqueueGatewayChatRequest,
        isConversationRunning: () => false,
        // 与 ChatPage 的接线相同。
        isQueuedTurnEditOpen: (conversationId) =>
          queue.queuedChatTurnEditSlotRef.current?.conversationId === conversationId.trim(),
        getConversationAbortController: () => null,
        requestConversationStop: () => false,
        requestActiveConversationStop: () => false,
        consumeConversationStop: () => false,
      }),
    );
    for (let attempt = 0; attempt < 20; attempt += 1) await flushPromises();
    hookHarness.cleanup();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

function goalClaim(command) {
  const request = {
    requestId: "goal-req",
    clientRequestId: "client-goal-req",
    conversationId: CONVERSATION_ID,
    message: "/goal ship it",
    queuePolicy: "auto",
    goalAction: command.kind === "goal" ? command.action : "",
    goalText: command.kind === "goal" && command.action === "set" ? "ship it" : "",
    planCommand: command.kind === "plan",
    promptCommand: command.kind === "prompt",
  };
  return {
    requestId: request.requestId,
    clientRequestId: request.clientRequestId,
    conversationId: CONVERSATION_ID,
    state: "claimed",
    attempt: 1,
    leaseMs: 15_000,
    request,
  };
}

for (const background of [false, true]) for (const command of [{kind:"goal",action:"set"},{kind:"goal",action:"resume"},{kind:"prompt"},{kind:"plan"}]) test(`WebUI ${command.kind} ${command.action ?? ""} in ${background ? "background" : "main"} Pane preserves the desktop queue-head edit`, async () => {
  globalThis.window ??= {};
  globalThis.window.requestAnimationFrame ??= () => 0;
  const state = {
    background,
    composer: createComposer(),
    cacheRef: { current: new Map() },
    invokes: [],
    bridgeSends: [],
    runTurns: [],
  };
  const send = createRealSend(state);
  const queue = renderQueue(state);

  // 停止后队列挂起、会话空闲：队里有两条排队消息。
  state.composer.setDraft({ text: "queued follow-up" });
  assert.equal(queue.enqueueCurrentComposerTurn("end"), true);
  state.composer.setDraft({ text: "second queued" });
  assert.equal(queue.enqueueCurrentComposerTurn("end"), true);
  const [queued] = queue.queuedChatTurnsRef.current;
  // 桌面用户点“编辑”队首：排队项移入输入框，编辑槽占住草稿并挡住队列处理。
  queue.editQueuedTurn(queued.id);
  assert.equal(state.composer.getDraft().text, "queued follow-up");
  assert.equal(queue.queuedChatTurnEditSlotRef.current?.conversationId, CONVERSATION_ID);
  // 前提 1：ChatPage isComposerDraftReserved 为真，桌面输入框此时不会执行任何“/”指令。
  // 前提 2：普通网关轮次此时会入队（编辑槽挡住处理），基线上 /goal 同样入队。
  assert.equal(queue.shouldQueueGatewayChatRequest(CONVERSATION_ID, "auto"), true);

  await deliverToBridge(goalClaim(command), state, queue, send);

  const ran = state.runTurns.length > 0;
  assert.equal(ran, false, "the /goal must not run while the queue head is being edited");
  assert.equal(state.invokes.find(call=>call.command==="gateway_chat_fail")?.payload.error_code,"conversation_busy");
  assert.equal(
    state.composer.getDraft().text,
    "queued follow-up",
    `the queue-head edit was wiped from the composer (bridge ran /goal directly: ${ran}, ` +
      `preserveComposerOnStart=${state.bridgeSends[0]?.preserveComposerOnStart})`,
  );
  // 用户随后保存编辑：内容还在才能放回原槽位。
  assert.equal(queue.enqueueCurrentComposerTurn("edit"), true, "saving the edit failed: queued turn lost");
  assert.equal(queue.queuedChatTurnsRef.current[0]?.draft.text, "queued follow-up");
});
