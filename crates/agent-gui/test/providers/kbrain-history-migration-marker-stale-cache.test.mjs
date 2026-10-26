import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Regressions for stale migration cache entries and the startup completion marker. The real historyMigration
// module runs end to end; only the Tauri IPC boundary and the K-brain HTTP endpoint are faked.

const native = { signature: "sig-1", pages: 0, legacy: null, pi: null };
const loader = createTsModuleLoader({
  mocks: {
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command) => {
        if (command === "legacy_history_migration_signature") return native.signature;
        if (command === "legacy_history_migration_page") {
          native.pages++;
          return native.legacy;
        }
        if (command === "pi_history_migration_page") return native.pi;
        throw new Error(`unexpected invoke ${command}`);
      },
    },
    "../host": { isTauriHost: () => true },
  },
});
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

function conversation(id, text = "hello") {
  return {
    id,
    title: `Conversation ${id}`,
    providerId: "p",
    model: "m",
    createdAt: 1000,
    updatedAt: 2000,
    isPinned: false,
    isShared: false,
    redactToolContent: false,
    contextMetaJson: "{}",
    checkpoint: { status: "not_found" },
    segments: [
      {
        segmentIndex: 0,
        segmentId: `${id}-s0`,
        messagesJson: JSON.stringify([{ id: `${id}-u0`, role: "user", content: text, timestamp: 1000 }]),
      },
    ],
  };
}

const page = (...conversations) => ({ complete: true, conversations });

// Mirrors K-brain: an existing session with another fingerprint is a 409 conflict, a deleted one
// leaves a tombstone that answers 410, and /v1/sessions/exists reports only live sessions.
function backend() {
  const sessions = new Map(); // id -> fingerprint
  const tombstones = new Set();
  const posts = [];
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") {
      return new Response(JSON.stringify({ status: "ok", capabilities: { session_exists: 1 } }));
    }
    if (path === "/v1/sessions/exists") {
      const { ids } = JSON.parse(init.body);
      return new Response(JSON.stringify({ existing: ids.filter((id) => sessions.has(id)) }));
    }
    if (path === "/v1/migrations/liveagent-history") {
      const body = JSON.parse(init.body);
      posts.push(body.source_id);
      const existing = sessions.get(body.source_id);
      if (existing !== undefined && existing !== body.source_fingerprint) {
        return new Response(JSON.stringify({ error: "conflicts with existing session" }), { status: 409 });
      }
      if (existing === undefined && tombstones.has(body.source_id)) {
        return new Response(JSON.stringify({ error: "history was explicitly deleted" }), { status: 410 });
      }
      sessions.set(body.source_id, body.source_fingerprint);
      return new Response(
        JSON.stringify({
          source_id: body.source_id,
          backend_id: body.source_id,
          status: existing === undefined ? "imported" : "already_imported",
          checkpoint: "not_found",
          fingerprint: body.source_fingerprint,
        }),
      );
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  const remove = (id) => {
    sessions.delete(id);
    tombstones.add(id);
  };
  return { fetch, posts, sessions, remove };
}

function setup(t, baseUrl) {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "", protocolVersion: "kbrain.agent.v1" });
  Object.assign(native, { signature: "sig-1", pages: 0, legacy: page(), pi: page() });
  t.after(() => runtime.clearKBrainRuntimeConnection());
  return values;
}

async function launch(kbrain) {
  const before = native.pages;
  const result = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  return { result, readLegacyExport: native.pages > before };
}

test("deleting a conversation that is skipped as a known conflict must not disable the marker forever", async (t) => {
  setup(t, "http://marker-stale-known-conflict.test");
  const kbrain = backend();
  native.legacy = page(conversation("legacy-a"), conversation("legacy-b"));
  await launch(kbrain); // both imported and cached
  assert.deepEqual([...kbrain.sessions.keys()].sort(), ["legacy-a", "legacy-b"]);

  // The user keeps writing legacy-b in the old build: K-brain answers 409 (deterministic
  // "conflict"), which is recorded and skipped at startup; its old cache entry stays.
  native.legacy = page(conversation("legacy-a"), conversation("legacy-b", "edited in v1"));
  native.signature = "sig-2";
  const conflicted = await launch(kbrain);
  assert.equal(conflicted.result.failures[0]?.kind, "conflict", JSON.stringify(conflicted.result.failures));

  // Control: with the conflict recorded, the marker does skip the unchanged legacy DB.
  assert.equal((await launch(kbrain)).readLegacyExport, false, "control: marker skips");

  // Then deletes the conflicting copy in v2. The legacy DB does not change.
  kbrain.remove("legacy-b");
  await launch(kbrain); // one full pass to notice is acceptable
  kbrain.posts.length = 0;
  const next = await launch(kbrain);
  const after = await launch(kbrain);
  assert.equal(
    next.readLegacyExport || after.readLegacyExport,
    false,
    "the stale cache entry of a conversation startup always skips keeps cachedSessionsStillExist false, " +
      "so every launch re-reads the full legacy export",
  );
});

test("a pi cache entry whose source file and session are both gone must not disable the legacy marker forever", async (t) => {
  setup(t, "http://marker-stale-pi-orphan.test");
  const kbrain = backend();
  native.legacy = page(conversation("legacy-a"));
  native.pi = page(conversation("pi-0123456789abcdef01234567"));
  await launch(kbrain);
  assert.equal(kbrain.sessions.size, 2);
  assert.equal((await launch(kbrain)).readLegacyExport, false, "control: marker skips");

  // The user deletes the pi conversation in v2 and later cleans up ~/.pi; the legacy DB is untouched.
  kbrain.remove("pi-0123456789abcdef01234567");
  native.pi = page();
  await launch(kbrain); // one full pass to notice is acceptable
  const next = await launch(kbrain);
  const after = await launch(kbrain);
  assert.equal(
    next.readLegacyExport || after.readLegacyExport,
    false,
    "a cache entry no current source can reach is never re-imported or removed, " +
      "so the legacy marker check fails on every launch",
  );
});
