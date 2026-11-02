import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: { react: { useCallback: (callback) => callback } },
});
const { CompactionController, createCompactionControllerRegistry } =
  loader.loadModule("src/lib/chat/compaction/controller.ts");
const { createConversationStateFromContext, buildRequestContext } =
  loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const { useManualCompaction } = loader.loadModule(
  "src/pages/chat/runtime/useManualCompaction.ts",
);

test("token accounting registry remains conversation-scoped and disposable", () => {
  const registry = createCompactionControllerRegistry();
  const first = registry.get("a");
  assert.equal(registry.get(" a "), first);
  assert.notEqual(registry.get("b"), first);
  registry.dispose("a");
  assert.notEqual(registry.get("a"), first);
});

test("historical fixed tokens and canonical usage remain displayable without an executor", () => {
  const controller = new CompactionController();
  assert.equal(controller.contextUsageTokens, undefined);
  const state = createConversationStateFromContext({
    systemPrompt: "x".repeat(400),
    messages: [],
  });
  controller.beginRequest(buildRequestContext(state), state);
  assert.equal(controller.contextUsageTokens, 100);
  assert.equal(controller.contextFixedTokens, 100);
  controller.observeContextMessages([
    {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: "kbrain.agent.v1",
      provider: "fixture",
      model: "test",
      stopReason: "stop",
      timestamp: 1,
      usage: {
        input: 120,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 125,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ]);
  assert.equal(controller.contextUsageTokens, 125);
  for (const method of [
    "bindTurn",
    "compactManually",
    "compactDuringRun",
    "maybeCompactPreSend",
    "handleTurnAbort",
  ]) {
    assert.equal(
      method in controller,
      false,
      `${method} must not expose a frontend executor`,
    );
  }
});

test("historical checkpoint accounting never drops below the persisted backend token floor", () => {
  const state = createConversationStateFromContext({
    systemPrompt: "short",
    messages: [],
  });
  state.segments[state.activeSegmentIndex].summary = {
    summaryMeta: { stats: { contextTokensAfter: 2400 } },
  };
  const controller = new CompactionController();
  assert.equal(controller.beginRequest({ messages: [] }, state), 2400);
  assert.equal(controller.contextFixedTokens, 2400);
});

test("manual compaction requires a mapped backend session without running a frontend LLM loop", async () => {
  const compact = useManualCompaction();
  for (const request of [
    undefined,
    { conversationId: "unmapped", operationId: "op" },
  ]) {
    const result = await compact(request);
    assert.equal(result.status, "skipped");
    assert.match(result.message, /backend session/i);
  }
});

test("send and manual entrypoints contain no frontend compaction execution wiring", () => {
  for (const name of ["useSendChatTurn", "useManualCompaction"]) {
    const source = readFileSync(
      new URL(`../../src/pages/chat/runtime/${name}.ts`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /\b(?:bindTurn|compactManually|compactDuringRun|handleTurnAbort|buildToolsSuffix|runCompaction|summarizeConversation)\b/,
    );
  }
});

test("manual compaction sends revision and identity and refreshes on compatible completion", async () => {
  const calls = [];
  const mockClient = {
    getSession: async () => ({ revision: "revision-1" }),
    compactSession: async (sessionId, input) => {
      calls.push({ sessionId, input });
      return { run_id: "compact-1", accepted_seq: 7, status: "accepted" };
    },
    subscribe: async (sessionId, after, handlers, signal) => {
      assert.equal(sessionId, "backend-1");
      assert.equal(after, 6);
      handlers.onEvent({ run_id: "other", type: "run.failed", payload: {} });
      handlers.onEvent({ run_id: "compact-1", type: "compaction.completed", payload: { status: "completed" } });
      assert.equal(signal.aborted, true);
    },
  };
  const isolated = createTsModuleLoader({ mocks: {
    react: { useCallback: (callback) => callback },
    "../../../lib/kbrain/client": { createKBrainClient: () => mockClient },
    "../../../lib/kbrain/mapping": { getKBrainSessionId: () => "backend-1" },
    "../../../lib/kbrain/runtimeConnection": { getConfiguredKBrainConnection: () => ({ baseUrl: "https://kbrain.test" }) },
  }});
  const { useManualCompaction: useCompact } = isolated.loadModule("src/pages/chat/runtime/useManualCompaction.ts");
  let refreshed;
  const compact = useCompact({ onCompleted: async (id) => { refreshed = id; } });
  const result = await compact({ conversationId: "local-1", operationId: "request-1" });
  assert.equal(result.status, "compacted");
  assert.equal(refreshed, "local-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "backend-1");
  assert.equal(calls[0].input.client_request_id, "request-1");
  assert.equal(calls[0].input.expected_revision, "revision-1");
});
