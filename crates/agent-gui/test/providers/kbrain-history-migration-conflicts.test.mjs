import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Conflict records used to block a conversation forever: they named no K-brain store, so a
// replaced store kept skipping it, and a backend that can extend an imported prefix never got
// to try. Records now carry the store and backend identity, and a 409 with a machine-readable
// reason keeps that reason for the settings list.

const native = { conversations: [] };
const loader = createTsModuleLoader({
  mocks: {
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command) => {
        // The database signature changes with its content, as the real one does.
        if (command === "legacy_history_migration_signature") return `legacy:${JSON.stringify(native.conversations)}`;
        if (command === "legacy_history_migration_page") {
          native.pages++;
          return { complete: true, conversations: native.conversations };
        }
        if (command === "pi_history_migration_signature") return null;
        if (command === "pi_history_migration_page") return { complete: true, conversations: [] };
        throw new Error(`unexpected invoke ${command}`);
      },
    },
    "../host": { isTauriHost: () => true },
  },
});
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const failures = loader.loadModule("src/lib/kbrain/historyMigrationFailures.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");

function conversation(id, messages = ["hello"]) {
  return {
    id, title: `Conversation ${id}`, providerId: "removed", model: "removed", createdAt: 1000, updatedAt: 2000,
    isPinned: false, isShared: false, redactToolContent: false, contextMetaJson: "{}", checkpoint: { status: "not_found" },
    segments: [{ segmentIndex: 0, segmentId: "first", messagesJson: JSON.stringify(
      messages.map((content, index) => ({ id: `${id}-${index}`, role: "user", content, timestamp: 1000 + index })),
    ) }],
  };
}

const OLD_BUILD = { version: "0.107.46" };
const PREFIX_BUILD = { version: "dev" };

/** A K-brain whose import answer is scripted per request. */
function backend({ build = OLD_BUILD, prefixUpdate = false } = {}) {
  const kbrain = { build, prefixUpdate, posts: [], existing: new Set(), answer: () => imported() };
  kbrain.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") {
      const capabilities = { session_exists: 1, ...(kbrain.prefixUpdate ? { history_import_prefix_update: 1 } : {}) };
      return new Response(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", build: kbrain.build, capabilities }));
    }
    if (path === "/v1/sessions/exists") {
      const { ids } = JSON.parse(init.body);
      return new Response(JSON.stringify({ existing: ids.filter((id) => kbrain.existing.has(id)) }));
    }
    if (path === "/v1/migrations/liveagent-history") {
      const body = JSON.parse(init.body);
      kbrain.posts.push(body.source_id);
      const response = await kbrain.answer(body);
      // Imported, or refused because K-brain already holds a session under this id.
      if (response.status === 200 || response.status === 409) kbrain.existing.add(body.source_id);
      return response;
    }
    return new Response(JSON.stringify({ sessions: [], total_count: 0 }));
  };
  return kbrain;
}

const imported = (extra = {}) => (body) => {
  return new Response(JSON.stringify({ source_id: body.source_id, backend_id: body.source_id, status: "imported", checkpoint: "not_found", fingerprint: body.source_fingerprint, ...extra }));
};
const conflict = (extra = {}) => () =>
  new Response(JSON.stringify({ version: "kbrain.agent.v1", error: "import source conflicts with existing session", ...extra }), { status: 409 });

function setup(t, baseUrl, conversations) {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "", protocolVersion: "kbrain.agent.v1" });
  Object.assign(native, { conversations, pages: 0, storage: values });
  t.after(() => runtime.clearKBrainRuntimeConnection());
  return () => failures.readHistoryMigrationFailures(mapping.kBrainStorageScope());
}

test("a 409 with an import_conflict reason keeps the reason; an old backend's 409 stays as it was", async (t) => {
  const records = setup(t, "http://conflict-reason.test", [conversation("a"), conversation("b")]);
  const kbrain = backend();
  kbrain.answer = (body) =>
    body.source_id === "a"
      ? conflict({ errorCode: "import_conflict", reason: "diverged" })()
      : conflict()();
  const result = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  const byId = Object.fromEntries(result.failures.map((failure) => [failure.sourceId, failure]));
  assert.equal(byId.a.kind, "conflict");
  assert.equal(byId.a.reason, "diverged");
  assert.equal(byId.b.kind, "conflict");
  assert.equal(byId.b.reason, undefined, "an old backend sends no reason");
  const stored = Object.fromEntries(records().map((record) => [record.sourceId, record]));
  assert.equal(stored.a.reason, "diverged");
  assert.equal(stored.a.store, mapping.kBrainStorageScope());
  assert.equal(stored.a.backend, "0.107.46|-");
  assert.equal("reason" in stored.b, false);

  // Both stay deterministic: the next launch does not re-send them, even past its marker.
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  const page = await migration.migrateLegacyHistoryPage({ complete: true, conversations: native.conversations }, { fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "b"]);
  assert.equal(page.failures.every((failure) => failure.skipped), true);
  assert.equal(page.failures.find((failure) => failure.sourceId === "a").reason, "diverged");

  // The manual import still retries every known failure.
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, retryKnownFailures: true });
  assert.deepEqual(kbrain.posts, ["a", "b", "a", "b"]);
});

test("a busy session is a transient failure, retried on the next launch", async (t) => {
  const records = setup(t, "http://conflict-busy.test", [conversation("a")]);
  const kbrain = backend();
  kbrain.answer = conflict({ errorCode: "session_busy" });
  const first = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(first.failures[0].kind, "transient");
  assert.equal(records()[0].kind, "transient");
  kbrain.answer = imported();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "a"]);
  assert.deepEqual(records(), []);
});

test("a prefix update counts as migrated and clears the conflict record", async (t) => {
  const records = setup(t, "http://prefix-update.test", [conversation("a")]);
  const kbrain = backend({ build: PREFIX_BUILD, prefixUpdate: true });
  kbrain.answer = conflict({ errorCode: "import_conflict", reason: "modified_after_import" });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(records()[0].reason, "modified_after_import");

  native.conversations = [conversation("a", ["hello", "more"])];
  kbrain.answer = imported({ updated: true, checkpoint: "not_found" });
  const events = [];
  const result = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, onProgress: (event) => events.push(event) });
  assert.equal(result.failures.length, 0);
  assert.equal(result.results[0].updated, true);
  assert.deepEqual(events.filter((event) => event.operation === "settled").map((event) => event.outcome), ["imported"]);
  assert.deepEqual(records(), [], "the conflict record is cleared");
});

test("a recorded conflict is retried when the conversation changes", async (t) => {
  const records = setup(t, "http://conflict-fingerprint.test", [conversation("a")]);
  const kbrain = backend();
  kbrain.answer = conflict();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  native.conversations = [conversation("a", ["hello", "and more"])];
  kbrain.answer = imported();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "a"]);
  assert.deepEqual(records(), []);
});

test("a failure record from another K-brain store or from an older release does not block a retry", async (t) => {
  const records = setup(t, "http://conflict-store.test", [conversation("a"), conversation("b")]);
  const storage = native.storage;
  const kbrain = backend();
  kbrain.answer = conflict();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  const scope = mapping.kBrainStorageScope();
  const [first, second] = records();
  // "a" was recorded against a replaced store, "b" by a release that recorded no store.
  const { store: _store, ...withoutStore } = second;
  failures.writeHistoryMigrationFailures(scope, [{ ...first, store: "liveagent-managed-kbrain:old-store" }, withoutStore]);
  // The release that wrote them had another app version, so its completion marker no longer applies.
  for (const key of [...storage.keys()]) if (key.includes("migration-complete")) storage.delete(key);
  kbrain.answer = imported();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "b", "a", "b"]);
  assert.deepEqual(records(), []);
});

test("known conflicts are retried once per backend that can update an imported prefix", async (t) => {
  const records = setup(t, "http://conflict-capability.test", [conversation("a")]);
  const kbrain = backend();
  kbrain.answer = conflict();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a"], "without the capability the conflict stays skipped");
  assert.equal(native.pages, 1, "and the unchanged source keeps its marker");

  // The backend is upgraded; the source itself did not change.
  Object.assign(kbrain, { build: PREFIX_BUILD, prefixUpdate: true });
  kbrain.answer = conflict({ errorCode: "import_conflict", reason: "diverged" });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "a"], "retried once on the new backend");
  assert.equal(records()[0].reason, "diverged");
  assert.equal(records()[0].backend, "dev|history_import_prefix_update");

  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "a"], "not again on the same backend");

  kbrain.build = { version: "dev-2" };
  kbrain.answer = imported({ updated: true });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "a", "a"], "a newer build retries once more");
  assert.deepEqual(records(), []);
});

test("a conflict whose K-brain session is gone is retried", async (t) => {
  const records = setup(t, "http://conflict-missing.test", [conversation("a")]);
  const kbrain = backend();
  kbrain.answer = conflict();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a"]);
  kbrain.existing.delete("a");
  kbrain.answer = imported();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["a", "a"]);
  assert.deepEqual(records(), []);
});
