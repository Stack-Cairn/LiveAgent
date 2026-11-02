import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";

// WebUI 的“/”指令轮次发出时是 queuePolicy "auto"，由桌面端 bridge 决定直跑还是停进
// 等待队列。桌面端判“要排队”的口径比 WebUI 的 isBusy 宽：队列里还有项（例如停止后
// 队列挂起、正在编辑队首），或桌面已开跑而 WebUI 还没收到 activity。以前这两种情况下
// /goal 都会被停进队列，之后自动执行。现在与桌面输入框一致：会话在跑就报忙，
// 空闲时即使队列里还有项也立即执行，指令轮次从不进等待队列。

const CONVERSATION_ID = "conversation-1";
const t = (key) => key;

/* ----------------------------- WebUI 侧（真实模块） ----------------------------- */

const webReact = {
  useCallback: (callback) => callback,
  useEffect() {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};
const webLoader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
  mocks: { react: webReact },
});
const { sendComposerCommandTurn } = webLoader.loadModule("src/app/sendComposerCommandTurn.ts");
const { useGatewayConversationState } = webLoader.loadModule(
  "src/app/hooks/useGatewayConversationState.ts",
);
const { createActivityStore } = webLoader.loadModule("src/lib/chat/stream/activityStore.ts");
const { ChatCommandPipeline } = webLoader.loadModule("src/lib/chat/stream/chatCommandPipeline.ts");
const { createTranscriptStoreRegistry } = webLoader.loadModule(
  "src/lib/chat/stream/useConversationChat.ts",
);

/** WebUI 视图：会话空闲（activity 无运行、无在途命令、转写无 activeRun）。 */
function createIdleWebUiConversationState() {
  const transcriptStoreRegistry = createTranscriptStoreRegistry();
  const chatCommandPipeline = new ChatCommandPipeline({
    getTranscriptStore: (id) => transcriptStoreRegistry.get(id),
  });
  const ref = (current) => ({ current });
  return useGatewayConversationState({
    activeWorkspaceProjectPath: "",
    activityStore: createActivityStore(),
    chatCommandPipeline,
    composerDraftCacheRef: ref(new Map()),
    composerDraftOwnerRef: ref(""),
    composerRef: ref(null),
    conversationId: CONVERSATION_ID,
    conversationIdRef: ref(CONVERSATION_ID),
    conversationWorkdirsRef: ref(new Map()),
    getPendingUploadsForConversation: () => [],
    isAgentMode: false,
    isLocalDraftConversationId: () => false,
    selectedHistory: null,
    selectedHistoryId: CONVERSATION_ID,
    selectedHistoryIdRef: ref(CONVERSATION_ID),
    selectedHistoryRef: ref(null),
    sidebarStore: { peek: () => null, upsertLocal() {} },
    status: null,
    statusRef: ref(null),
    transcriptStoreRegistry,
  });
}

/* ----------------------------- 桌面侧（真实模块） ----------------------------- */

// 与 queue-settle-edit-resume.test.mjs 相同的最小 hook 运行器。
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
  isEmpty: !text.trim(),
  segments: text ? [{ type: "text", text }] : [],
});

function createInvokeRecorder(claims) {
  const calls = [];
  return {
    calls,
    async invoke(command, payload) {
      calls.push({ command, payload });
      if (command === "gateway_chat_claim_next") return claims.shift() ?? null;
      return undefined;
    },
  };
}

/** 真实 useChatTurnQueue：桌面端的队列与“网关请求是否入队”的判定。 */
function renderDesktopQueue(state, recorder) {
  const hookHarness = createHookHarness();
  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "@tauri-apps/api/core": { invoke: recorder.invoke },
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
    },
  });
  const { useChatTurnQueue } = loader.loadModule("src/pages/chat/queue/useChatTurnQueue.ts");
  const queue = hookHarness.render(() =>
    useChatTurnQueue({
      settings: {
        system: { executionMode: "chat", workdir: "", commandSafetyMode: "sandboxOffline" },
        chatRuntimeControls: {},
      },
      currentConversationId: CONVERSATION_ID,
      currentConversationIdRef: { current: CONVERSATION_ID },
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
      hasConversationStopHandler: () => false,
      requestActiveConversationStop: () => true,
      getConversationLiveTranscriptStore: (id) => ({ conversationId: id }),
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
          state.sends.push(overrides);
          return true;
        },
      },
    }),
  );
  return { hookHarness, queue };
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** 真实 useGatewayBridgeListeners：桌面端认领 WebUI 发来的一轮，接真实队列判定。 */
async function deliverToDesktopBridge(claim, state, queue, recorder) {
  const hookHarness = createHookHarness();
  const target = () => {
    const handlers = new Map();
    return {
      addEventListener(name, handler) {
        handlers.set(name, handler);
      },
      removeEventListener(name) {
        handlers.delete(name);
      },
    };
  };
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
    const bridgeInvoke = async (command, payload) => {
      recorder.calls.push({ command, payload });
      if (command === "gateway_chat_claim_next") return claims.shift() ?? null;
      return undefined;
    };
    const loader = createTsModuleLoader({
      mocks: {
        react: hookHarness.react,
        "@tauri-apps/api/core": { invoke: bridgeInvoke },
        "@tauri-apps/api/event": {
          async listen() {
            return () => undefined;
          },
        },
        "../../../lib/settings": {
          normalizeChatRuntimeControls: (value) => value,
        },
      },
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );
    hookHarness.render(() =>
      useGatewayBridgeListeners({
        currentConversationIdRef: { current: state.background ? "other-conversation" : CONVERSATION_ID },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
        sendActionRef: {
          current: async (overrides) => {
            state.sends.push(overrides);
            return true;
          },
        },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest: queue.shouldQueueGatewayChatRequest,
        enqueueGatewayChatRequest: queue.enqueueGatewayChatRequest,
        isConversationRunning: () => state.running,
        getConversationAbortController: () => null,
        requestConversationStop: () => false,
        requestActiveConversationStop: () => false,
        consumeConversationStop: () => false,
      }),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) await flushPromises();
    hookHarness.cleanup();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

/** 把 sendComposerCommandTurn 交给 sendChat 的选项按 sendChat→chatCommand 的口径转成桌面端认领的请求。 */
function toDesktopClaim(text, sendOptions) {
  const request = {
    requestId: "goal-req",
    clientRequestId: "client-goal-req",
    conversationId: sendOptions.conversationId ?? CONVERSATION_ID,
    message: text,
    // gatewayChatCommandActions.ts sendChat: queuePolicy: sendOptions?.queuePolicy ?? "auto"
    queuePolicy: sendOptions.queuePolicy ?? "auto",
    goalAction: sendOptions.goalAction ?? "",
    goalText: sendOptions.goalText ?? "",
    promptCommand: sendOptions.promptCommand === true,
    planCommand: sendOptions.planCommand === true,
    runtimeControls: sendOptions.runtimeControls,
  };
  return {
    requestId: request.requestId,
    clientRequestId: request.clientRequestId,
    conversationId: request.conversationId,
    state: "claimed",
    attempt: 1,
    leaseMs: 15_000,
    request,
  };
}

async function runWebUiGoalAgainstDesktop(state, command = { kind: "goal", action: "set", goal: "ship it" }) {
  globalThis.window ??= {};
  globalThis.window.requestAnimationFrame ??= () => 0;
  const recorder = createInvokeRecorder([]);
  const { hookHarness, queue } = renderDesktopQueue(state, recorder);
  for (const text of state.queued) {
    state.draft = text;
    assert.equal(queue.enqueueCurrentComposerTurn("end"), true);
  }
  state.draft = "";
  const queuedBefore = queue.queuedChatTurnsRef.current.length;

  const web = createIdleWebUiConversationState();
  // 与 GatewayConversationPaneHost / GatewayAppView 的接线相同：isBusy 读 isConversationBusy。
  const sendChatCalls = [];
  const sendChat = async (text, options) => {
    sendChatCalls.push([text, options]);
    return { kind: "accepted", accepted: { conversationId: CONVERSATION_ID, runId: "r" } };
  };
  let refused = false;
  try {
    await sendComposerCommandTurn(
      sendChat,
      t,
      "/goal ship it",
      command,
      { conversationId: CONVERSATION_ID, isBusy: () => web.isConversationBusy(CONVERSATION_ID) },
    );
  } catch (error) {
    assert.match(String(error?.message), /chat\.commands\.busy/);
    refused = true;
  }

  let parked = false;
  if (!refused) {
    assert.equal(sendChatCalls.length, 1);
    const [text, options] = sendChatCalls[0];
    await deliverToDesktopBridge(toDesktopClaim(text, options), state, queue, recorder);
    parked =
      recorder.calls.some((call) => call.command === "gateway_chat_mark_queued_in_gui") ||
      queue.queuedChatTurnsRef.current.length > queuedBefore;
  }
  hookHarness.cleanup();
  return { refused, parked, queue, recorder };
}

test("WebUI /goal on an idle conversation whose desktop queue still holds a turn runs at once", async () => {
  // 例如用户在有排队项时按了停止：桌面端消费停止标记后队列挂起、会话空闲。
  const state = { running: false, draft: "", sends: [], queued: ["queued follow-up"] };
  const { refused, parked, queue } = await runWebUiGoalAgainstDesktop(state);
  assert.equal(refused, false);
  assert.equal(
    parked,
    false,
    `queue=${JSON.stringify(
      queue.queuedChatTurnsRef.current.map((item) => item.gatewayRequest?.composerCommand ?? null),
    )}`,
  );
  assert.deepEqual(
    state.sends.map((send) => send.composerCommand),
    [{ kind: "goal", action: "set", goal: "ship it" }],
  );
});

test("WebUI /goal sent while the desktop already runs a turn the WebUI has not heard about is refused as busy", async () => {
  // 桌面端本地刚开跑，chat.activity 还没到 WebUI：WebUI 视图仍空闲。
  const state = { running: true, draft: "", sends: [], queued: [] };
  const { refused, parked, queue, recorder } = await runWebUiGoalAgainstDesktop(state);
  assert.equal(refused, false, "precondition: the WebUI view still looks idle");
  assert.equal(
    parked,
    false,
    `queue=${JSON.stringify(
      queue.queuedChatTurnsRef.current.map((item) => item.gatewayRequest?.composerCommand ?? null),
    )}`,
  );
  assert.equal(state.sends.length, 0);
  const failed = recorder.calls.find((call) => call.command === "gateway_chat_fail");
  assert.equal(failed?.payload?.error_code, "conversation_busy");
});

for (const background of [false,true]) for (const command of [{kind:"goal",action:"set",goal:"ship it"},{kind:"goal",action:"resume"},{kind:"prompt"},{kind:"plan"}]) {
 test(`busy desktop refuses ${command.kind} ${command.action ?? ""} in ${background ? "background" : "main"} Pane without queueing despite stale WebUI`,async()=>{
  const state={background,running:true,draft:"",sends:[],queued:[]};const {parked,recorder}=await runWebUiGoalAgainstDesktop(state,command);
  assert.equal(parked,false);assert.equal(state.sends.length,0);assert.equal(recorder.calls.find(c=>c.command==="gateway_chat_fail")?.payload.error_code,"conversation_busy");
 });
}
