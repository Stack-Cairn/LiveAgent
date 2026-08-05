import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createFakeStoreIpc, sleep } from "./harness.mjs";

const loader = createTsModuleLoader();
const storeModule = loader.loadModule("src/lib/subagents/store.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");

const SCHEMA_VERSION = 2;

function makeIdentity(agentId, overrides = {}) {
  return {
    parentConversationId: overrides.parentConversationId ?? "conversation-1",
    agentId,
    name: overrides.name ?? `Name of ${agentId}`,
    role: overrides.role ?? "Role",
    identityPrompt: "",
    lastMode: overrides.lastMode ?? "readonly",
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

function makeRunSummary(id, agentId, overrides = {}) {
  return {
    id,
    parentConversationId: overrides.parentConversationId ?? "conversation-1",
    parentToolCallId: overrides.parentToolCallId ?? "call-agent",
    agentId,
    agentIndex: 0,
    agentTotal: 1,
    prompt: overrides.prompt ?? "task",
    mode: overrides.mode ?? "readonly",
    status: overrides.status ?? "completed",
    providerId: "codex",
    model: "gpt-5",
    contextSchemaVersion: overrides.contextSchemaVersion ?? SCHEMA_VERSION,
    activeSegmentIndex: 0,
    totalSegmentCount: 1,
    totalMessageCount: overrides.totalMessageCount ?? 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: overrides.summary,
    startedAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

function makeRunRecord(id, agentId, overrides = {}) {
  return {
    run: makeRunSummary(id, agentId, overrides),
    segments: [
      {
        segmentIndex: 0,
        segmentId: `${id}-segment-0`,
        messagesJson: JSON.stringify(
          overrides.messages ?? [
            { role: "user", content: `stored task for ${agentId}`, timestamp: 10 },
            {
              role: "assistant",
              content: [{ type: "text", text: `stored answer for ${agentId}` }],
              api: "openai-responses",
              provider: "openai",
              model: "gpt-5",
              stopReason: "stop",
              timestamp: 11,
            },
          ],
        ),
        messageCount: overrides.messages?.length ?? 2,
        createdAt: 10,
        updatedAt: 11,
      },
    ],
  };
}

function makeViewState(messages) {
  return conversationState.createConversationStateFromContext({
    systemPrompt: "system",
    tools: [],
    messages,
  });
}

function makePersistInput(id, agentId, state, overrides = {}) {
  return {
    id,
    parentToolCallId: overrides.parentToolCallId ?? "call-agent",
    agentId,
    agentIndex: 0,
    agentTotal: 1,
    prompt: overrides.prompt ?? "task",
    mode: overrides.mode ?? "readonly",
    status: overrides.status ?? "completed",
    providerId: "codex",
    model: "gpt-5",
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: overrides.summary,
    startedAt: 1,
    endedAt: overrides.endedAt,
    state,
  };
}

function createStore(ipc, params = {}) {
  return storeModule.createSubagentConversationStore({
    conversationId: params.conversationId ?? "conversation-1",
    ipc,
    ...params,
  });
}

test("ready() hydrates identities and the latest run per agent from ipc", async () => {
  const ipc = createFakeStoreIpc();
  ipc.seedIdentity(makeIdentity("agent-a", { updatedAt: 5 }));
  ipc.seedIdentity(makeIdentity("agent-b", { updatedAt: 9 }));
  ipc.seedIdentity(makeIdentity("other", { parentConversationId: "conversation-2" }));
  ipc.seedRun(makeRunRecord("run-1", "agent-a", { updatedAt: 5, summary: "old" }));
  ipc.seedRun(makeRunRecord("run-2", "agent-a", { updatedAt: 9, summary: "new" }));
  ipc.seedRun(makeRunRecord("run-x", "other", { parentConversationId: "conversation-2" }));

  const store = createStore(ipc);
  await store.ready();

  assert.deepEqual(
    store.listIdentities().map((identity) => identity.agentId),
    ["agent-b", "agent-a"],
  );
  assert.deepEqual(store.knownAgentIds().sort(), ["agent-a", "agent-b"]);
  assert.equal(store.getLatestRun("agent-a").id, "run-2");
  assert.equal(store.getLatestRun("agent-a").summary, "new");
  assert.equal(store.getIdentity("agent-b").name, "Name of agent-b");
  assert.equal(store.latestRunsByAgent().size, 1);
});

test("saveRunState updates latest runs and the hydrated cache even when the durable write fails", async () => {
  const ipc = createFakeStoreIpc({ saveRunError: new Error("io error") });
  const store = createStore(ipc);
  await store.ready();

  const state = makeViewState([{ role: "user", content: "do it", timestamp: 1 }]);
  await assert.rejects(
    () => store.saveRunState(makePersistInput("run-1", "agent-a", state, { summary: "done" })),
    /io error/,
  );

  // In-memory tiers still advanced.
  const latest = store.getLatestRun("agent-a");
  assert.equal(latest.id, "run-1");
  assert.equal(latest.summary, "done");
  // Resume hits the hydrated cache without an ipc load.
  const restored = await store.loadRunState({
    runSummary: latest,
    systemPrompt: "resumed system",
    tools: [],
  });
  assert.ok(restored);
  assert.deepEqual(ipc.loadRunIds, []);
});

test("loadRunState prefers cached segments and rebases onto the provided system prompt and tools", async () => {
  const ipc = createFakeStoreIpc();
  const store = createStore(ipc);
  await store.ready();

  const state = makeViewState([{ role: "user", content: "original ask", timestamp: 1 }]);
  await store.saveRunState(makePersistInput("run-1", "agent-a", state));

  const newTools = [{ name: "Read", description: "Read", parameters: {} }];
  const restored = await store.loadRunState({
    runSummary: store.getLatestRun("agent-a"),
    systemPrompt: "REBASED SYSTEM PROMPT",
    tools: newTools,
  });
  assert.ok(restored);
  assert.equal(restored.meta.systemPrompt, "REBASED SYSTEM PROMPT");
  assert.deepEqual(restored.meta.tools, newTools);
  const texts = restored.segments.flatMap((segment) =>
    segment.messages.map((message) => message.content),
  );
  assert.ok(texts.includes("original ask"));
  assert.deepEqual(ipc.loadRunIds, []);
});

test("loadRunState falls back to ipc.loadRun on cache miss and caches the result", async () => {
  const ipc = createFakeStoreIpc();
  ipc.seedRun(makeRunRecord("run-9", "agent-a"));
  const store = createStore(ipc);
  await store.ready();

  const summary = makeRunSummary("run-9", "agent-a");
  const restored = await store.loadRunState({
    runSummary: summary,
    systemPrompt: "sys",
    tools: [],
  });
  assert.ok(restored);
  assert.deepEqual(ipc.loadRunIds, ["run-9"]);
  const texts = restored.segments.flatMap((segment) =>
    segment.messages.map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.text).join(""),
    ),
  );
  assert.ok(texts.some((text) => /stored task for agent-a/.test(text)));

  // Second load is served from the hydrated cache.
  const again = await store.loadRunState({ runSummary: summary, systemPrompt: "sys", tools: [] });
  assert.ok(again);
  assert.deepEqual(ipc.loadRunIds, ["run-9"]);
});

test("a stored context with a different schema version is discarded", async () => {
  const ipc = createFakeStoreIpc();
  ipc.seedRun(makeRunRecord("run-old", "agent-a", { contextSchemaVersion: 1 }));
  const store = createStore(ipc);
  await store.ready();

  const restored = await store.loadRunState({
    runSummary: makeRunSummary("run-old", "agent-a", { contextSchemaVersion: 1 }),
    systemPrompt: "sys",
    tools: [],
  });
  assert.equal(restored, null);
  assert.deepEqual(ipc.loadRunIds, ["run-old"]);
});

test("hydrated contexts are evicted LRU beyond maxHydratedEntries", async () => {
  const ipc = createFakeStoreIpc();
  const store = createStore(ipc, { maxHydratedEntries: 2 });
  await store.ready();

  for (const agentId of ["agent-a", "agent-b", "agent-c"]) {
    const state = makeViewState([{ role: "user", content: `ask ${agentId}`, timestamp: 1 }]);
    await store.saveRunState(makePersistInput(`run-${agentId}`, agentId, state));
    await sleep(2);
  }

  // agent-a was evicted; loading it needs the ipc.
  const restoredA = await store.loadRunState({
    runSummary: store.getLatestRun("agent-a"),
    systemPrompt: "sys",
    tools: [],
  });
  assert.ok(restoredA);
  assert.deepEqual(ipc.loadRunIds, ["run-agent-a"]);

  // agent-c stayed cached; no additional ipc load.
  const restoredC = await store.loadRunState({
    runSummary: store.getLatestRun("agent-c"),
    systemPrompt: "sys",
    tools: [],
  });
  assert.ok(restoredC);
  assert.deepEqual(ipc.loadRunIds, ["run-agent-a"]);
});

test("warmup pre-hydrates latest runs and is invalidated by a generation bump", async () => {
  const ipc = createFakeStoreIpc();
  ipc.seedIdentity(makeIdentity("agent-a"));
  ipc.seedRun(makeRunRecord("run-warm", "agent-a"));

  const warmStore = createStore(ipc);
  warmStore.warmup();
  await sleep(30);
  assert.deepEqual(ipc.loadRunIds, ["run-warm"]);
  const restored = await warmStore.loadRunState({
    runSummary: makeRunSummary("run-warm", "agent-a"),
    systemPrompt: "sys",
    tools: [],
  });
  assert.ok(restored);
  // Warm cache hit: no extra load beyond the warmup itself.
  assert.deepEqual(ipc.loadRunIds, ["run-warm"]);

  // A warmup immediately followed by invalidate() must not repopulate caches.
  const ipc2 = createFakeStoreIpc();
  ipc2.seedIdentity(makeIdentity("agent-a"));
  ipc2.seedRun(makeRunRecord("run-warm", "agent-a"));
  const invalidatedStore = createStore(ipc2);
  invalidatedStore.warmup();
  invalidatedStore.invalidate();
  await sleep(30);
  // The generation bump stops the stale warmup before it hydrates any run
  // segments (a fresh ready() may still refetch the roster, which is fine).
  assert.deepEqual(ipc2.loadRunIds, []);
});

test("collectRetainedSubagentParentToolCallIds keeps Agent/SendMessage/subagent_message results", () => {
  const state = {
    segments: [
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "toolResult", toolName: "Agent", toolCallId: "call-agent-1", details: {} },
          { role: "toolResult", toolName: "SendMessage", toolCallId: " call-send-1 ", details: {} },
          {
            role: "toolResult",
            toolName: "LegacyMessenger",
            toolCallId: "call-legacy",
            details: { kind: "subagent_message" },
          },
          { role: "toolResult", toolName: "Read", toolCallId: "call-read", details: {} },
          { role: "toolResult", toolName: "Agent", toolCallId: "", details: {} },
        ],
      },
      {
        messages: [
          { role: "toolResult", toolName: "Agent", toolCallId: "call-agent-2", details: {} },
        ],
      },
    ],
  };
  const kept = storeModule.collectRetainedSubagentParentToolCallIds(state);
  assert.deepEqual(
    kept.sort(),
    ["call-agent-1", "call-agent-2", "call-legacy", "call-send-1"],
  );
});

test("pruneSubagentRunsForConversation trims ids and skips empty conversations", async () => {
  const ipc = createFakeStoreIpc({
    pruneResult: {
      removedRunIds: ["gone"],
      removedMessageCount: 3,
      removedIdentityCount: 1,
      worktreeCleanupErrors: [],
    },
  });
  const result = await storeModule.pruneSubagentRunsForConversation(
    { parentConversationId: " conversation-1 ", keepParentToolCallIds: [" keep-1 ", "", "keep-2"] },
    ipc,
  );
  assert.deepEqual(result.removedRunIds, ["gone"]);
  assert.deepEqual(ipc.pruneCalls, [
    { parentConversationId: "conversation-1", keepParentToolCallIds: ["keep-1", "keep-2"] },
  ]);

  const empty = await storeModule.pruneSubagentRunsForConversation(
    { parentConversationId: "   ", keepParentToolCallIds: ["keep-1"] },
    ipc,
  );
  assert.deepEqual(empty, {
    removedRunIds: [],
    removedMessageCount: 0,
    removedIdentityCount: 0,
    worktreeCleanupErrors: [],
  });
  assert.equal(ipc.pruneCalls.length, 1);
});

test("store manager reuses per-conversation stores; invalidate clears and rehydrates; dispose drops", async () => {
  const ipc = createFakeStoreIpc();
  ipc.seedIdentity(makeIdentity("agent-a"));
  const manager = storeModule.createSubagentStoreManager({ ipc });

  const store = manager.get("conversation-1");
  assert.equal(manager.get(" conversation-1 "), store);
  await store.ready();
  assert.equal(store.listIdentities().length, 1);

  store.invalidate();
  assert.deepEqual(store.listIdentities(), []);
  await store.ready();
  assert.equal(store.listIdentities().length, 1);

  manager.dispose("conversation-1");
  const fresh = manager.get("conversation-1");
  assert.notEqual(fresh, store);

  manager.disposeAll();
  assert.notEqual(manager.get("conversation-1"), fresh);
});
