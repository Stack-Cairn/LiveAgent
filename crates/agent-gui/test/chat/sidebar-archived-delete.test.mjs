import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createSidebarStore } = loader.loadModule("@liveagent/ui/lib/sidebar/store.ts");
const { deleteSidebarConversation } = loader.loadModule("@liveagent/ui/lib/sidebar/batchDelete.ts");
const archived = { id: "archived", title: "Archived conversation", cwd: "/workspace" };

function setup({ cached = true, fail = false } = {}) {
  const requests = [];
  let confirm;
  const deletion = new Promise((resolve) => { confirm = resolve; });
  const store = createSidebarStore({
    async deleteConversation(id) {
      requests.push(id);
      await deletion;
      if (fail) throw new Error("delete failed");
    },
    async listWorkdirs() { return []; },
  });
  if (cached) store.upsertLocal({ ...archived, providerId: "test", model: "test", createdAt: 1, updatedAt: 1 });
  const context = {
    store,
    archivedConversations: [archived],
    onSetConversationArchived(item, value) {
      assert.equal(value, false);
      context.archivedConversations = context.archivedConversations.filter((row) => row.id !== item.id);
    },
  };
  return { context, store, requests, confirm };
}

for (const cached of [true, false]) {
  test(`deleting an archived conversation clears metadata only after confirmation (cached=${cached})`, async () => {
    const { context, store, requests, confirm } = setup({ cached });
    const pending = deleteSidebarConversation(archived.id, context);
    assert.deepEqual(requests, [archived.id]);
    assert.equal(context.archivedConversations.length, 1, "optimistic removal must retain archive metadata");
    confirm();
    assert.equal(await pending, true);
    assert.equal(context.archivedConversations.length, 0);
    assert.equal(store.peek(archived.id), undefined);
  });
}

test("a failed archived deletion keeps a restorable row and exposes the error", async () => {
  const { context, store, confirm } = setup({ cached: false, fail: true });
  const pending = deleteSidebarConversation(archived.id, context);
  confirm();
  assert.equal(await pending, false);
  assert.equal(context.archivedConversations.length, 1);
  assert.equal(store.peek(archived.id)?.title, archived.title);
  assert.equal(store.getSnapshot().mutationErrors.get(archived.id), "deleteFailed");
});

test("running archived conversations remain protected from deletion", async () => {
  const { context, store, requests } = setup();
  store.applyRunningPatch({ conversationId: archived.id, running: true });
  assert.equal(await deleteSidebarConversation(archived.id, context), false);
  assert.deepEqual(requests, []);
  assert.equal(context.archivedConversations.length, 1);
});

test("a repeated delete cannot recreate the row while its first deletion is pending", async () => {
  const { context, store, requests, confirm } = setup({ cached: false });
  const pending = deleteSidebarConversation(archived.id, context);
  assert.equal(await deleteSidebarConversation(archived.id, context), false);
  assert.equal(store.peek(archived.id), undefined);
  assert.deepEqual(requests, [archived.id]);
  confirm();
  assert.equal(await pending, true);
  assert.equal(context.archivedConversations.length, 0);
  assert.equal(store.peek(archived.id), undefined);
});
