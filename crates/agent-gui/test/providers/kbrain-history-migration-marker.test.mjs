import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const native = { signature: "sig-1", pages: 0, signatureCalls: 0, page: null };
const loader = createTsModuleLoader({
  mocks: {
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command) => {
        if (command === "legacy_history_migration_signature") {
          native.signatureCalls++;
          return native.signature;
        }
        if (command === "legacy_history_migration_page") {
          native.pages++;
          return native.page;
        }
        if (command === "pi_history_migration_page") return { complete: true, conversations: [] };
        throw new Error(`unexpected invoke ${command}`);
      },
    },
    "../host": { isTauriHost: () => true },
  },
});
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

function legacyPage(checkpoint = { status: "not_found" }) {
  return {
    complete: true,
    conversations: [{
      id: "legacy-a", title: "Old conversation", providerId: "p", model: "m",
      createdAt: 1000, updatedAt: 2000, isPinned: false, isShared: false,
      redactToolContent: false, contextMetaJson: "{}", checkpoint,
      segments: [{ segmentIndex: 0, segmentId: "s0", messagesJson: JSON.stringify([
        { id: "u0", role: "user", content: "hello", timestamp: 1000 },
      ]) }],
    }],
  };
}

function backend({ capability = 1, importStatus = 200, checkpoint = "not_found" } = {}) {
  const existing = new Set();
  const calls = { posts: 0, exists: 0, listings: 0 };
  const state = { deleted: false };
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") {
      return new Response(JSON.stringify({ status: "ok", capabilities: capability ? { session_exists: capability } : {} }));
    }
    if (path === "/v1/sessions/exists") {
      calls.exists++;
      const { ids } = JSON.parse(init.body);
      return new Response(JSON.stringify({ existing: ids.filter((id) => existing.has(id)) }));
    }
    if (path === "/v1/sessions") {
      calls.listings++;
      return new Response(JSON.stringify({ sessions: [...existing].map((id) => ({ id })), total_count: existing.size }));
    }
    if (path === "/v1/migrations/liveagent-history") {
      calls.posts++;
      if (state.deleted) return new Response(JSON.stringify({ error: "history was explicitly deleted" }), { status: 410 });
      if (importStatus !== 200) return new Response(JSON.stringify({ error: "busy" }), { status: importStatus });
      existing.add("legacy-a");
      return new Response(JSON.stringify({ source_id: "legacy-a", backend_id: "legacy-a", status: "imported", checkpoint, fingerprint: "fp" }));
    }
    return new Response(JSON.stringify({ id: "legacy-a" }));
  };
  return { fetch, calls, existing, state };
}

function setup(t, baseUrl) {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "", protocolVersion: "kbrain.agent.v1" });
  Object.assign(native, { signature: "sig-1", pages: 0, signatureCalls: 0, page: legacyPage() });
  t.after(() => runtime.clearKBrainRuntimeConnection());
}

test("an unchanged legacy source is skipped after a complete pass when K-brain still has its sessions", async (t) => {
  setup(t, "http://marker-skip.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(native.pages, 1);
  assert.equal(kbrain.calls.posts, 1);

  const second = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(native.pages, 1, "the legacy export is not read again");
  assert.equal(kbrain.calls.posts, 1);
  assert.equal(kbrain.calls.listings, 0);
  assert.equal(second.failures.length, 0);
  assert.equal(second.complete, true);
});

test("a changed signature or a missing K-brain session runs the full pass again", async (t) => {
  setup(t, "http://marker-change.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  native.signature = "sig-2";
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(native.pages, 2);
  assert.equal(kbrain.calls.posts, 1, "unchanged content is still confirmed from the cache");

  kbrain.existing.clear();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(native.pages, 3);
  assert.equal(kbrain.calls.posts, 2, "a wiped K-brain store is repaired by re-importing");
});

test("a transient failure or unresolved checkpoint leaves no marker, so the next launch retries", async (t) => {
  setup(t, "http://marker-transient.test");
  const failing = backend({ importStatus: 503 });
  await migration.migrateAllHistoryOnce({ fetch: failing.fetch });
  await migration.migrateAllHistoryOnce({ fetch: failing.fetch });
  assert.equal(native.pages, 2);

  setup(t, "http://marker-unresolved.test");
  const unresolved = backend({ checkpoint: "unresolved" });
  await migration.migrateAllHistoryOnce({ fetch: unresolved.fetch });
  await migration.migrateAllHistoryOnce({ fetch: unresolved.fetch });
  assert.equal(native.pages, 2);
});

test("without session_exists, or for a manual import, the full pass always runs", async (t) => {
  setup(t, "http://marker-old-backend.test");
  const old = backend({ capability: 0 });
  await migration.migrateAllHistoryOnce({ fetch: old.fetch });
  await migration.migrateAllHistoryOnce({ fetch: old.fetch });
  assert.equal(native.pages, 2, "an older K-brain keeps the previous behavior");

  setup(t, "http://marker-manual.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, retryKnownFailures: true });
  assert.equal(native.pages, 2, "the manual import never trusts the startup marker");
});

test("an unreadable signature never skips the legacy source", async (t) => {
  setup(t, "http://marker-no-signature.test");
  native.signature = null;
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(native.pages, 2);
});

test("a conversation deleted in K-brain stops blocking the marker after one pass", async (t) => {
  setup(t, "http://marker-deleted.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  // The user deletes the migrated conversation: K-brain keeps a tombstone and answers 410.
  kbrain.existing.clear();
  kbrain.state.deleted = true;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(native.pages, 2);
  assert.equal(kbrain.calls.posts, 2);
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(native.pages, 2, "the deleted conversation no longer forces a full pass");
  assert.equal(kbrain.calls.posts, 2);
});
