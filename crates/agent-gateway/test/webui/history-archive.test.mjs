import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayV2Codec } from "../helpers/gateway-v2.mjs";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

// Archived conversations in the WebUI ride the memory_manage passthrough. The desktop
// bridge and a direct K-brain relay both answer these three commands.
const loader = createWebModuleLoader();
const adapters = loader.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const { createWebSidebarBackend } = loader.loadModule("src/lib/sidebar/webSidebarBackend.ts");
const codec = createGatewayV2Codec(loader);

function memoryCommand(type, body) {
  const request = codec.decodeClientFrame(
    adapters.encodeRequestFrame("request-1", type, body, "desktop-agent"),
  );
  const manage = request.json.agent_request.memory_manage;
  return { command: manage.command, args: JSON.parse(manage.args_json) };
}

test("archive requests encode as memory_manage commands", () => {
  assert.deepEqual(memoryCommand("history.archive_supported", {}), {
    command: "history_archive_supported",
    args: {},
  });
  assert.deepEqual(memoryCommand("history.archived_list", { page: 2, page_size: 30 }), {
    command: "history_archived_list",
    args: { page: 2, page_size: 30 },
  });
  assert.deepEqual(
    memoryCommand("history.archive_set", { conversation_id: " conv-1 ", archived: true }),
    { command: "history_archive_set", args: { conversation_id: "conv-1", archived: true } },
  );
  assert.deepEqual(
    memoryCommand("history.archive_set", { conversation_id: "conv-1", archived: false }).args,
    { conversation_id: "conv-1", archived: false },
  );
});

function summary(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? id,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    message_count: 2,
    provider_id: "fixture",
    model: "test",
    cwd: "/repo/a",
    ...overrides,
  };
}

function backendFor(api) {
  return createWebSidebarBackend({
    api: {
      listHistory: async () => ({ conversations: [], total_count: 0 }),
      listHistoryWorkdirs: async () => ({ workdirs: [] }),
      renameHistory: async (id, title) => summary(id, { title }),
      pinHistory: async (id) => summary(id),
      setHistoryCwd: async (id, cwd) => summary(id, { cwd }),
      deleteHistory: async () => {},
      subscribeHistory: () => () => {},
      ...api,
    },
    activityStore: {
      hydrate() {},
      getSnapshot: () => ({ conversations: new Map() }),
      subscribe: () => () => {},
    },
    getProtectedConversationIds: () => [],
  });
}

test("the web sidebar backend archives only when the gateway client can", async () => {
  assert.equal(backendFor({}).archive, undefined, "an older client hides archive entirely");

  const calls = [];
  let supported = Promise.resolve(true);
  const backend = backendFor({
    historyArchiveSupported: () => supported,
    listArchivedHistory: async (page, pageSize) => {
      calls.push(["list", page, pageSize]);
      return { conversations: [summary("old", { title: "Old work", is_archived: true })], total_count: 1 };
    },
    setHistoryArchived: async (id, archived) => {
      calls.push(["set", id, archived]);
    },
  });
  assert.ok(backend.archive);
  assert.equal(await backend.archive.isSupported(), true);
  supported = Promise.reject(new Error("unknown memory command"));
  assert.equal(await backend.archive.isSupported(), false, "a desktop without the command means no archive");

  const page = await backend.archive.listArchived(1, 30);
  assert.equal(page.totalCount, 1);
  assert.equal(page.items[0].id, "old");
  assert.equal(page.items[0].title, "Old work");
  assert.equal(page.items[0].isArchived, true);
  assert.equal(page.items[0].updatedAt, 1_700_000_000_500);

  await backend.archive.setArchived("conv-1", true);
  await backend.archive.setArchived("conv-1", false);
  assert.deepEqual(calls, [
    ["list", 1, 30],
    ["set", "conv-1", true],
    ["set", "conv-1", false],
  ]);
});
