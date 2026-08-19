import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// R-2(单槽位收敛)不变量:
// 1. 会话身份(sessionId/createdAt)与模型选择不再是页面级镜像 state —— registry
//    entry 是唯一事实来源,页面值经 useConversationRuntimeEntrySnapshot 派生;
// 2. syncVisibleConversationRuntime 只同步仍镜像的 5 个瞬态字段;
// 3. 非当前会话的 runtime 写入绝不触碰可见 state(双 Pane 隔离);
// 4. Send/Stop/Compact/Retry 按显式 conversationId 路由,不经全局 current ref。
// (docs/design/session-workbench-pane-architecture.md §30.3)

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
      for (const effect of effects) {
        effect?.cleanup?.();
      }
    },
  };
}

function mountRuntimeStore() {
  const hookHarness = createHookHarness();
  const loader = createTsModuleLoader({
    mocks: {
      react: hookHarness.react,
      "../../../lib/chat/conversation/conversationState": {
        createConversationStateFromContext(value) {
          return value;
        },
      },
    },
  });
  const { useChatPageRuntimeStore } = loader.loadModule(
    "src/pages/chat/hooks/useChatPageRuntimeStore.ts",
  );
  const state = { meta: { tools: [] }, messages: [] };
  const setterCalls = [];
  const trackedSetter = (name) => (value) => setterCalls.push([name, value]);
  const runtime = hookHarness.render(() =>
    useChatPageRuntimeStore({
      initialConversation: {
        conversationId: "conversation-a",
        sessionId: "session-a",
        createdAt: 11,
      },
      initialConversationState: state,
      currentConversationId: "conversation-a",
      conversationState: state,
      compactionStatus: { phase: "idle" },
      isSending: false,
      errorMessage: null,
      hookWarning: null,
      setConversationState: trackedSetter("state"),
      setCompactionStatus: trackedSetter("compaction"),
      setIsSending: trackedSetter("isSending"),
      setErrorMessage: trackedSetter("errorMessage"),
      setHookWarning: trackedSetter("hookWarning"),
      setRunningConversationIds: trackedSetter("runningIds"),
    }),
  );
  return { runtime, setterCalls, state, cleanup: () => hookHarness.cleanup() };
}

test("identity and model selection live in the registry, not in mirrored setters", () => {
  const { runtime, setterCalls, cleanup } = mountRuntimeStore();

  // The initial entry carries the boot identity.
  const initial = runtime.conversationRuntimeRegistry.getSnapshot("conversation-a");
  assert.equal(initial.sessionId, "session-a");
  assert.equal(initial.createdAt, 11);

  // A registry-first model update keeps identity and never routes through a
  // page-level model setter (there is none to call any more).
  setterCalls.length = 0;
  runtime.updateConversationRuntimeEntry("conversation-a", (prev) => ({
    ...prev,
    selectedModel: { customProviderId: "prov", model: "m1" },
  }));
  const updated = runtime.conversationRuntimeRegistry.getSnapshot("conversation-a");
  assert.deepEqual(updated.selectedModel, { customProviderId: "prov", model: "m1" });
  assert.equal(updated.sessionId, "session-a");
  assert.equal(updated.createdAt, 11);
  // Visible sync touches exactly the five still-mirrored transient fields.
  assert.deepEqual(
    setterCalls.map(([name]) => name).sort(),
    ["compaction", "errorMessage", "hookWarning", "isSending", "state"],
  );

  // buildRuntimeEntryFromVisibleState preserves registry-owned fields instead
  // of resetting them from (now nonexistent) mirrors.
  const rebuilt = runtime.buildRuntimeEntryFromVisibleState();
  assert.equal(rebuilt.sessionId, "session-a");
  assert.equal(rebuilt.createdAt, 11);
  assert.deepEqual(rebuilt.selectedModel, { customProviderId: "prov", model: "m1" });
  cleanup();
});

test("updating a background conversation never writes visible page state", () => {
  const { runtime, setterCalls, state, cleanup } = mountRuntimeStore();
  setterCalls.length = 0;

  runtime.updateConversationRuntimeEntry(
    "conversation-b",
    (prev) => ({ ...prev, isSending: true }),
    { state, sessionId: "session-b", createdAt: 22 },
  );

  assert.deepEqual(setterCalls, [], "background updates must not touch visible setters");
  const entryB = runtime.conversationRuntimeRegistry.getSnapshot("conversation-b");
  assert.equal(entryB.isSending, true);
  assert.equal(entryB.sessionId, "session-b");
  // A's entry is untouched.
  const entryA = runtime.conversationRuntimeRegistry.getSnapshot("conversation-a");
  assert.equal(entryA.isSending, false);
  cleanup();
});

test("stop routes by explicit conversationId without touching other conversations", () => {
  const { runtime, cleanup } = mountRuntimeStore();

  const controllerA = new AbortController();
  const controllerB = new AbortController();
  runtime.setConversationAbortController("conversation-a", controllerA);
  runtime.setConversationAbortController("conversation-b", controllerB);

  runtime.requestConversationStop("conversation-b");
  const handled = runtime.requestActiveConversationStop("conversation-b", { force: false });
  assert.equal(handled, false, "no handler registered for B yet");

  // The stop intent for B is bucketed to B alone.
  assert.equal(runtime.isConversationStopRequested("conversation-b"), true);
  assert.equal(runtime.isConversationStopRequested("conversation-a"), false);
  assert.equal(controllerA.signal.aborted, false, "A must not be collaterally aborted");
  cleanup();
});

const chatPageSource = readFileSync(
  new URL("../../src/pages/ChatPage.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../../src/pages/chat/hooks/useChatPageRuntimeStore.ts", import.meta.url),
  "utf8",
);
const sendSource = readFileSync(
  new URL("../../src/pages/chat/runtime/useSendChatTurn.ts", import.meta.url),
  "utf8",
);

test("the three converged mirrors must not return as page-level state", () => {
  assert.equal(chatPageSource.includes("setCurrentConversationSessionId"), false);
  assert.equal(chatPageSource.includes("setCurrentConversationCreatedAt"), false);
  assert.equal(chatPageSource.includes("setCurrentConversationSelectedModel"), false);
  // The page derives them from the registry snapshot instead.
  assert.match(chatPageSource, /useConversationRuntimeEntrySnapshot\(/);
  assert.equal(storeSource.includes("setCurrentConversationSessionId"), false);
  assert.equal(storeSource.includes("setCurrentConversationSelectedModel"), false);
});

test("controller actions route by explicit conversationId, not the current ref", () => {
  // ChatPage's shared action table forwards the input id to id-explicit APIs.
  assert.match(chatPageSource, /conversationIdOverride: conversationId/);
  assert.match(chatPageSource, /stopConversationActionRef\.current\(conversationId\)/);
  assert.match(chatPageSource, /manualCompactActionRef\.current\(\{ conversationId \}\)/);
  // The send pipeline prefers the explicit override over the global ref.
  assert.match(
    sendSource,
    /const conversationId = overrideConversationId \|\| currentConversationIdRef\.current/,
  );
});
