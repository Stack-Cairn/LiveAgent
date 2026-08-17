import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 不变量:Hydration 生命周期按 conversationId 分桶(remaining-work R-3,
// 任务文档 §312/§589)。两个 Pane 同时 hydrate 时状态互不覆盖;失败标记按
// ID 隔离;重试只清本会话;Controller 快照经 lifecycle slice 暴露。

const { loadModule } = createTsModuleLoader();
const { createConversationHydrationStore } = loadModule(
  "src/pages/chat/conversations/conversationHydrationStore.ts",
);
const { createConversationRuntimeRegistry } = loadModule(
  "src/pages/chat/conversations/createConversationRuntimeRegistry.ts",
);
const { createConversationSurfaceController } = loadModule(
  "src/pages/chat/conversations/createConversationSurfaceController.ts",
);

const PROJECT = { projectId: "p1", projectPathKey: "/workspaces/p1" };

function noopActions() {
  return {
    async hydrate() {},
    async send() {},
    stop() {},
    async compact() {},
    async retry() {},
  };
}

test("A and B hydrating concurrently never clobber each other", () => {
  const store = createConversationHydrationStore();
  store.markHydrating("conv-a");
  store.markHydrating("conv-b");
  assert.equal(store.getSnapshot("conv-a"), "hydrating");
  assert.equal(store.getSnapshot("conv-b"), "hydrating");

  // B finishes first: A must still be hydrating.
  store.clearHydrating("conv-b");
  assert.equal(store.getSnapshot("conv-a"), "hydrating");
  assert.equal(store.getSnapshot("conv-b"), null);
});

test("failure marks are isolated per conversation", () => {
  const store = createConversationHydrationStore();
  store.markHydrating("conv-a");
  store.markHydrating("conv-b");
  store.markFailed("conv-a");
  // A's failure replaced its own hydrating mark only.
  assert.equal(store.getSnapshot("conv-a"), "failed");
  assert.equal(store.getSnapshot("conv-b"), "hydrating");

  // B succeeding must not clear A's failure.
  store.clearHydrating("conv-b");
  assert.equal(store.getSnapshot("conv-a"), "failed");
});

test("a retry clears only its own conversation's failure", () => {
  const store = createConversationHydrationStore();
  store.markFailed("conv-a");
  store.markFailed("conv-b");
  // Retry = markHydrating(id): replaces this id's fail mark, leaves the other.
  store.markHydrating("conv-a");
  assert.equal(store.getSnapshot("conv-a"), "hydrating");
  assert.equal(store.getSnapshot("conv-b"), "failed");
});

test("clearAllHydrating drops hydrating marks but preserves failures", () => {
  const store = createConversationHydrationStore();
  store.markHydrating("conv-a");
  store.markFailed("conv-b");
  store.clearAllHydrating();
  assert.equal(store.getSnapshot("conv-a"), null);
  assert.equal(store.getSnapshot("conv-b"), "failed");
});

test("clearing a phase the conversation is not in is a no-op", () => {
  const store = createConversationHydrationStore();
  store.markFailed("conv-a");
  store.clearHydrating("conv-a");
  assert.equal(store.getSnapshot("conv-a"), "failed");
  store.clearFailed("conv-a");
  assert.equal(store.getSnapshot("conv-a"), null);
});

test("subscribers are notified per conversation, not globally", () => {
  const store = createConversationHydrationStore();
  const hits = { a: 0, b: 0 };
  store.subscribe("conv-a", () => (hits.a += 1));
  store.subscribe("conv-b", () => (hits.b += 1));
  store.markHydrating("conv-a");
  assert.deepEqual(hits, { a: 1, b: 0 });
  store.markFailed("conv-b");
  assert.deepEqual(hits, { a: 1, b: 1 });
  // Same-phase re-set does not emit (no listener churn on repeat marks).
  store.markFailed("conv-b");
  assert.deepEqual(hits, { a: 1, b: 1 });
});

test("registry delete drops the conversation's hydration bucket", () => {
  const registry = createConversationRuntimeRegistry();
  registry.hydration.markFailed("conv-a");
  registry.delete("conv-a");
  assert.equal(registry.hydration.getSnapshot("conv-a"), null);
});

test("controller snapshots expose lifecycle.hydrating/hydrationFailed per id", () => {
  const registry = createConversationRuntimeRegistry();
  const controllerA = createConversationSurfaceController({
    conversationId: "conv-a",
    project: PROJECT,
    registry,
    actions: noopActions(),
  });
  const controllerB = createConversationSurfaceController({
    conversationId: "conv-b",
    project: PROJECT,
    registry,
    actions: noopActions(),
  });

  assert.deepEqual(controllerA.getSnapshot().lifecycle, {
    hydrating: false,
    hydrationFailed: false,
  });

  let notifiedA = 0;
  controllerA.subscribe(() => (notifiedA += 1));

  registry.hydration.markHydrating("conv-a");
  assert.equal(notifiedA, 1);
  assert.deepEqual(controllerA.getSnapshot().lifecycle, {
    hydrating: true,
    hydrationFailed: false,
  });
  // B's snapshot is untouched by A's hydration.
  assert.deepEqual(controllerB.getSnapshot().lifecycle, {
    hydrating: false,
    hydrationFailed: false,
  });

  registry.hydration.markFailed("conv-a");
  assert.deepEqual(controllerA.getSnapshot().lifecycle, {
    hydrating: false,
    hydrationFailed: true,
  });

  controllerA.dispose();
  controllerB.dispose();
});

test("the page no longer holds single-slot hydration state", () => {
  const chatPageSource = readFileSync(
    new URL("../../src/pages/ChatPage.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(chatPageSource.includes("hydratingConversationId,"), false);
  assert.equal(chatPageSource.includes("setHydratingConversationId"), false);
  assert.equal(chatPageSource.includes("setHydrationFailedConversationId"), false);
  assert.match(chatPageSource, /useConversationHydrationPhase\(/);
});

test("restored panes hydrate automatically without taking global focus", () => {
  const hostSource = readFileSync(
    new URL("../../src/pages/chat/surfaces/ConversationPaneHost.tsx", import.meta.url),
    "utf8",
  );
  const historySource = readFileSync(
    new URL("../../src/pages/chat/history/useConversationHistoryActions.ts", import.meta.url),
    "utf8",
  );
  assert.match(hostSource, /void controller\.hydrate\(\)\.catch/);
  assert.match(
    hostSource,
    /snapshot\.runtime \|\| snapshot\.lifecycle\.hydrating \|\| snapshot\.lifecycle\.hydrationFailed/,
  );
  assert.match(historySource, /function hydrateInBackground\(conversationId: string\)/);
  const backgroundBlock = historySource.slice(
    historySource.indexOf("function hydrateInBackground"),
    historySource.indexOf("function loadEarlier"),
  );
  assert.match(backgroundBlock, /getChatHistoryWindow\(/);
  assert.match(backgroundBlock, /setConversationRuntimeCacheEntry\(/);
  assert.equal(backgroundBlock.includes("setCurrentConversationId"), false);
});
