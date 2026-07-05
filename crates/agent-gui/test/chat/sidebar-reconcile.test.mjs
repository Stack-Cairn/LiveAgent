import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const reconcile = loader.loadModule("src/lib/sidebar/reconcile.ts");
const scope = loader.loadModule("src/lib/sidebar/scope.ts");

function conversation(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? id,
    providerId: overrides.providerId ?? "provider",
    model: overrides.model ?? "model",
    cwd: overrides.cwd,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    isPinned: overrides.isPinned,
    pinnedAt: overrides.pinnedAt,
    isShared: overrides.isShared,
    isPending: overrides.isPending,
  };
}

test("sort puts pinned first, then pinnedAt desc, then updatedAt desc, then id", () => {
  const sorted = reconcile.sortSidebarConversations([
    conversation("c", { updatedAt: 30 }),
    conversation("a", { updatedAt: 30 }),
    conversation("old-pin", { isPinned: true, pinnedAt: 10, updatedAt: 1 }),
    conversation("new-pin", { isPinned: true, pinnedAt: 20, updatedAt: 1 }),
    conversation("recent", { updatedAt: 50 }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["new-pin", "old-pin", "recent", "a", "c"],
  );
});

test("merge preserves identity when nothing changed", () => {
  const existing = conversation("one", { updatedAt: 5 });
  const merged = reconcile.mergeSidebarConversation(existing, conversation("one", { updatedAt: 5 }));
  assert.equal(merged, existing);
});

test("merge keeps the newer title by updatedAt", () => {
  const existing = conversation("one", { title: "newer title", updatedAt: 10 });
  const merged = reconcile.mergeSidebarConversation(
    existing,
    conversation("one", { title: "stale title", updatedAt: 5 }),
  );
  assert.equal(merged.title, "newer title");
});

test("merge clears isPending when the persisted upsert arrives", () => {
  const pending = conversation("draft", { isPending: true, updatedAt: 5 });
  const merged = reconcile.mergeSidebarConversation(
    pending,
    conversation("draft", { updatedAt: 6 }),
  );
  assert.equal(merged.isPending, undefined);
});

test("reconcile drops server-absent rows when the page covers the scope", () => {
  const current = [
    conversation("keep", { updatedAt: 30 }),
    conversation("ghost", { updatedAt: 20 }),
  ];
  const next = reconcile.reconcileSidebarConversations(current, [
    conversation("keep", { updatedAt: 30 }),
  ]);
  assert.deepEqual(
    next.map((item) => item.id),
    ["keep"],
  );
});

test("reconcile keeps pending drafts and retained ids", () => {
  const current = [
    conversation("draft", { isPending: true, updatedAt: 40 }),
    conversation("mutating", { updatedAt: 30 }),
    conversation("ghost", { updatedAt: 20 }),
  ];
  const next = reconcile.reconcileSidebarConversations(current, [], {
    retainConversationIds: ["mutating"],
  });
  assert.deepEqual(
    next.map((item) => item.id),
    ["draft", "mutating"],
  );
});

test("incomplete pages only have authority over their sorted prefix", () => {
  const current = [
    conversation("ghost-inside", { updatedAt: 90 }),
    conversation("page-a", { updatedAt: 80 }),
    conversation("page-b", { updatedAt: 70 }),
    conversation("deep", { updatedAt: 10 }),
  ];
  const next = reconcile.reconcileSidebarConversations(
    current,
    [conversation("page-a", { updatedAt: 80 }), conversation("page-b", { updatedAt: 70 })],
    { authoritativeComplete: false },
  );
  // ghost-inside sorts above the page boundary and is absent → dropped;
  // deep sorts below the boundary → outside the page's authority, kept.
  assert.deepEqual(
    next.map((item) => item.id),
    ["page-a", "page-b", "deep"],
  );
});

test("reconcile preserves updatedAt for locked ids", () => {
  const current = [conversation("locked", { updatedAt: 100 })];
  const next = reconcile.reconcileSidebarConversations(
    current,
    [conversation("locked", { updatedAt: 200 })],
    { preserveUpdatedAtConversationIds: ["locked"] },
  );
  assert.equal(next[0].updatedAt, 100);
});

test("backend events: delete removes, running/idle leave the list untouched", () => {
  const items = [conversation("one"), conversation("two")];
  const afterDelete = reconcile.applySidebarBackendEvent(items, {
    kind: "delete",
    conversationId: "one",
  });
  assert.deepEqual(
    afterDelete.map((item) => item.id),
    ["two"],
  );
  assert.equal(
    reconcile.applySidebarBackendEvent(items, { kind: "running", conversationId: "one" }),
    items,
  );
  assert.equal(
    reconcile.applySidebarBackendEvent(items, { kind: "idle", conversationId: "one" }),
    items,
  );
});

test("scope matching: workdir, unscoped, none", () => {
  const inProject = conversation("a", { cwd: "/tmp/project" });
  const chatOnly = conversation("b");
  const workdirScope = { kind: "workdir", cwd: "/tmp/project" };
  const unscoped = { kind: "unscoped" };
  const none = { kind: "none" };

  assert.equal(scope.conversationMatchesScope(inProject, workdirScope), true);
  assert.equal(scope.conversationMatchesScope(chatOnly, workdirScope), false);
  assert.equal(scope.conversationMatchesScope(chatOnly, unscoped), true);
  assert.equal(scope.conversationMatchesScope(inProject, unscoped), false);
  assert.equal(scope.conversationMatchesScope(inProject, none), false);

  assert.equal(scope.sidebarScopeKey(workdirScope), "cwd:/tmp/project");
  assert.equal(scope.sidebarScopeKey(unscoped), "cwd-empty");
  assert.equal(scope.sidebarScopeKey(none), "none");
});

test("scope filter preserves identity when everything matches", () => {
  const items = [conversation("a", { cwd: "/p" }), conversation("b", { cwd: "/p" })];
  assert.equal(scope.filterConversationsForScope(items, { kind: "workdir", cwd: "/p" }), items);
});
