import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 中途压缩 checkpoint 落库后，前端缓存的历史窗口过期；这里验证三件事：
// 1) compaction_checkpoint 事件把会话标记为过期；
// 2) 过期期间 persistConversation 不再发起任何历史写 IPC（终态以引擎为准）；
// 3) 重拉权威窗口（reloadConversationFromHistory）后解除禁写。

const chatHistoryPath = fileURLToPath(
  new URL("../../src/lib/chat/history/chatHistory.ts", import.meta.url),
);

function createHookHarness() {
  const refs = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;

  const react = {
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
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
      effectIndex = 0;
      return run();
    },
  };
}

test("checkpoint 标记语义：置位/查询/清除按会话隔离", () => {
  const loader = createTsModuleLoader();
  const { markCompactionCheckpoint, hasPendingCompactionCheckpoint, clearCompactionCheckpoint } =
    loader.loadModule("src/lib/chat/compaction/checkpoints.ts");

  markCompactionCheckpoint("conversation-1");
  assert.equal(hasPendingCompactionCheckpoint("conversation-1"), true);
  assert.equal(hasPendingCompactionCheckpoint("conversation-2"), false);

  clearCompactionCheckpoint("conversation-1");
  assert.equal(hasPendingCompactionCheckpoint("conversation-1"), false);
});

test("compaction_checkpoint 事件走白名单并把会话标记为过期", () => {
  const harness = createHookHarness();
  let emit = () => {};

  const loader = createTsModuleLoader({
    mocks: {
      react: harness.react,
      "../../../lib/backend/client": {
        subscribeEvents: (handler) => {
          emit = handler;
          return () => {};
        },
        backendFetchGet: async () => ({}),
      },
    },
  });
  const { useBackendEventSubscription } = loader.loadModule(
    "src/pages/chat/hooks/useBackendEventSubscription.ts",
  );
  const { hasPendingCompactionCheckpoint } = loader.loadModule(
    "src/lib/chat/compaction/checkpoints.ts",
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    harness.render(() =>
      useBackendEventSubscription({
        currentConversationId: "",
        getConversationLiveTranscriptStore: (id) => ({ id }),
        updateToolStatus: () => {},
        updateCompactionStatus: () => {},
        appendDraftAssistantText: () => {},
        batchLiveRoundsUpdate: () => {},
        settleLiveTranscript: () => {},
        getLiveSnapshot: () => ({ draftAssistantText: "", liveRounds: [] }),
      }),
    );

    emit({
      event: "compaction_checkpoint",
      payload: {
        conversation_id: "conversation-1",
        summary_text: "折叠摘要",
        checkpoint: { summary_id: "sum-1", segment_index: 1, covered_message_count: 12 },
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(hasPendingCompactionCheckpoint("conversation-1"), true);
  assert.deepEqual(warnings, []);
});

function segment(index) {
  return {
    segmentIndex: index,
    segmentId: `seg-${index}`,
    messages: [],
    messageCount: 0,
    createdAt: 100 + index,
    updatedAt: 100 + index,
  };
}

function buildState(activeSegmentIndex, segments) {
  return {
    meta: {
      activeSegmentIndex,
      totalSegmentCount: segments.length,
      totalMessageCount: 0,
      tools: [],
    },
    activeSegmentIndex,
    segments,
    transcript: { revision: "rev-0" },
  };
}

function mountHistoryActions() {
  const harness = createHookHarness();
  const persistCalls = [];
  const windowRequests = [];
  const runtimeCache = new Map();

  const loader = createTsModuleLoader({
    mocks: {
      react: harness.react,
      [chatHistoryPath]: {
        CHAT_HISTORY_WINDOW_MESSAGES: 360,
        buildChatHistoryRevision: () => "rev-1",
        buildConversationStateFromWindow: (record) => record.state,
        getChatHistoryWindow: async (params) => {
          windowRequests.push(params);
          const active = segment(1);
          return {
            conversation: { id: params.id, title: "t", updatedAt: 900 },
            activeSegment: active,
            updatedAt: 900,
            state: buildState(1, [active]),
            meta: { activeSegmentIndex: 1 },
          };
        },
        persistConversationRuntime: async (params) => {
          persistCalls.push(params);
          return { id: params.conversationId, updatedAt: params.updatedAt, title: params.title };
        },
        renameChatHistory: async () => {},
      },
    },
  });

  const { useConversationHistoryActions } = loader.loadModule(
    "src/pages/chat/history/useConversationHistoryActions.ts",
  );
  const checkpoints = loader.loadModule("src/lib/chat/compaction/checkpoints.ts");

  const baseSegment = segment(0);
  const state = buildState(0, [baseSegment]);
  runtimeCache.set("conversation-1", {
    state,
    compactionStatus: { phase: "idle" },
    isSending: false,
    errorMessage: null,
    hookWarning: null,
    sessionId: "session-1",
    createdAt: 1,
  });

  const actions = harness.render(() =>
    useConversationHistoryActions({
      conversationState: state,
      currentConversationIdRef: { current: "conversation-1" },
      conversationRuntimeCacheRef: { current: runtimeCache },
      conversationPersistenceCursorRef: {
        current: new Map([
          ["conversation-1", { activeSegmentIndex: 0, activeSegmentId: "seg-0" }],
        ]),
      },
      markLocalHistorySnapshotSynced: () => {},
      isConversationRunning: () => false,
      conversationLoadSequenceRef: { current: 0 },
      sidebarStore: { peek: () => undefined, upsertLocal: () => {}, removeLocal: () => {} },
      titleJobRef: { current: null },
      t: (key) => key,
      buildRuntimeEntryFromVisibleState: () => runtimeCache.get("conversation-1"),
      syncVisibleConversationRuntime: () => {},
      updateConversationRuntimeEntry: (id, updater) => {
        const prev = runtimeCache.get(id);
        const next = updater(prev);
        runtimeCache.set(id, next);
        return next;
      },
      cancelConversationLoad: () => {},
      resetVisibleTransientState: () => {},
      deleteConversationArtifacts: () => {},
      resolveConversationSelectedModel: () => undefined,
      setCurrentConversationId: () => {},
      setErrorMessage: () => {},
      setHydratingConversationId: () => {},
      setHydrationFailedConversationId: () => {},
    }),
  );

  return { actions, checkpoints, persistCalls, windowRequests, state };
}

test("checkpoint 置位后 persistConversation 跳过历史写；重拉权威窗口后恢复", async () => {
  const { actions, checkpoints, persistCalls, windowRequests, state } = mountHistoryActions();

  const persistParams = {
    conversationId: "conversation-1",
    sessionId: "session-1",
    providerId: "p",
    model: "m",
    state,
    fallbackTitle: "标题",
    createdAt: 1,
    titlePromise: null,
  };

  // 基线：未置位时正常落库。
  assert.equal(await actions.persistConversation(persistParams), true);
  assert.equal(persistCalls.length, 1);

  // 中途 checkpoint 落库后：前端整轮禁写，但返回 true——调用方（终态
  // finalize 链）不应把「以引擎为准」当成失败。
  checkpoints.markCompactionCheckpoint("conversation-1");
  assert.equal(await actions.persistConversation(persistParams), true);
  assert.equal(persistCalls.length, 1);

  // 重拉权威窗口 → 游标对齐 → 解除禁写。
  await actions.reloadConversationFromHistory("conversation-1");
  assert.equal(windowRequests.length, 1);
  assert.equal(checkpoints.hasPendingCompactionCheckpoint("conversation-1"), false);

  assert.equal(await actions.persistConversation(persistParams), true);
  assert.equal(persistCalls.length, 2);
});
