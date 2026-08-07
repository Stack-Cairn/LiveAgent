import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// useBackendEventSubscription 只做一件事：把 core 的 WireEvent 路由到对应的
// 消费者。这里用最小 react 替身跑 useEffect，拿到订阅回调后直接喂事件。
function createHookHarness() {
  const effects = [];
  let effectIndex = 0;

  const react = {
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
      effectIndex = 0;
      return run();
    },
    cleanup() {
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}

function mountSubscription(overrides = {}) {
  const harness = createHookHarness();
  let emit = () => {};
  const calls = { compactionStatus: [], toolStatus: [], warnings: [] };

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

  const originalWarn = console.warn;
  console.warn = (...args) => calls.warnings.push(args);
  try {
    harness.render(() =>
      useBackendEventSubscription({
        // 空串会跳过快照拉取的那个 effect，测试只关心事件路由。
        currentConversationId: "",
        getConversationLiveTranscriptStore: (id) => ({ id }),
        updateToolStatus: (status, store) => calls.toolStatus.push({ status, store }),
        updateCompactionStatus: (conversationId, status) =>
          calls.compactionStatus.push({ conversationId, status }),
        appendDraftAssistantText: () => {},
        batchLiveRoundsUpdate: () => {},
        settleLiveTranscript: () => {},
        getLiveSnapshot: () => ({ draftAssistantText: "", liveRounds: [] }),
        ...overrides,
      }),
    );
  } finally {
    console.warn = originalWarn;
  }

  return { emit: (event, payload) => emit({ event, payload }), calls, harness };
}

test("compaction_status reaches the runtime entry so the failure toast can fire", () => {
  const { emit, calls } = mountSubscription();

  const running = {
    phase: "running",
    trigger: "pre-send",
    startedAt: 1,
    sourceSegmentIndex: 0,
  };
  emit("compaction_status", { conversation_id: "conversation-1", status: running });
  const failed = { phase: "failed", trigger: "pre-send", failedAt: 2, message: "上游 429" };
  emit("compaction_status", { conversation_id: "conversation-1", status: failed });

  assert.deepEqual(calls.compactionStatus, [
    { conversationId: "conversation-1", status: running },
    { conversationId: "conversation-1", status: failed },
  ]);
});

test("compaction_status without a usable status payload is ignored", () => {
  const { emit, calls } = mountSubscription();

  emit("compaction_status", { conversation_id: "conversation-1" });
  emit("compaction_status", { conversation_id: "conversation-1", status: "running" });

  assert.deepEqual(calls.compactionStatus, []);
});

test("background events stay out of the chat whitelist and log no warning", () => {
  const { emit, calls } = mountSubscription();

  // 这两条没有 conversation_id；漏进白名单就会刷「missing conversation_id」告警。
  emit("memory_organize_progress", { run_id: "run-1", phase: "clustering" });
  emit("cron_prompt_started", { run_id: "run-2" });

  assert.deepEqual(calls.compactionStatus, []);
  assert.deepEqual(calls.warnings, []);
});

test("tool_status_change still routes to the conversation's transcript store", () => {
  const { emit, calls } = mountSubscription();

  const status = { kind: "compaction_prune_fallback", pruned_message_count: 3 };
  emit("tool_status_change", { conversation_id: "conversation-1", status });

  assert.equal(calls.toolStatus.length, 1);
  assert.deepEqual(calls.toolStatus[0].status, status);
  assert.deepEqual(calls.toolStatus[0].store, { id: "conversation-1" });
});
