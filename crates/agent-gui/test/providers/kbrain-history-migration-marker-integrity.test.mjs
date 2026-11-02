import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Integrity checks for the JSON completion marker ({marker, backendIds}). The real
// historyMigration module runs end to end; only Tauri IPC and the K-brain HTTP endpoint are faked.

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

// Mirrors K-brain: a different fingerprint is 409, a deleted session leaves a tombstone (410)
// stored inside the sessions directory, so wiping the store also forgets deletions.
function backend() {
  const sessions = new Map();
  const tombstones = new Set();
  const posts = [];
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") {
      return new Response(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", capabilities: { session_exists: 1 } }));
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
        return new Response(JSON.stringify({ error: "conflicts" }), { status: 409 });
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
  return {
    fetch,
    posts,
    sessions,
    remove(id) {
      sessions.delete(id);
      tombstones.add(id);
    },
    wipe() {
      sessions.clear();
      tombstones.clear();
    },
  };
}

const COMPLETE_PREFIX = "liveagent.kbrain-history-migration-complete.v1:";

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
  const completionKey = () => [...values.keys()].find((key) => key.startsWith(COMPLETE_PREFIX));
  return { values, completion: () => JSON.parse(values.get(completionKey())) , completionKey };
}

async function launch(kbrain) {
  const before = native.pages;
  const result = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  return { result, readLegacyExport: native.pages > before };
}

test("backendIds lists exactly this pass's legacy results, never pi, skipped or invalid sources", async (t) => {
  const store = setup(t, "http://marker-integrity-ids.test");
  const kbrain = backend();
  const broken = conversation("legacy-bad");
  broken.segments[0].messagesJson = "{not json";
  native.legacy = page(conversation("legacy-a"), conversation("legacy-gone"), broken);
  native.pi = page(conversation("pi-0123456789abcdef01234567"));
  kbrain.remove("legacy-gone");
  const first = await launch(kbrain);
  assert.deepEqual(
    first.result.failures.map((failure) => [failure.sourceId, failure.invalidSource === true]),
    [["legacy-bad", true]],
  );
  assert.deepEqual(store.completion().backendIds, ["legacy-a"]);
  kbrain.posts.length = 0;
  const second = await launch(kbrain);
  assert.equal(second.readLegacyExport, false, "marker applies with a 410 and an invalid source");
  assert.deepEqual(kbrain.posts, [], "the deleted conversation is no longer re-posted each launch");
});

test("an empty legacy database writes a marker with no ids and is skipped next launch", async (t) => {
  const store = setup(t, "http://marker-integrity-empty.test");
  const kbrain = backend();
  await launch(kbrain);
  assert.deepEqual(store.completion().backendIds, []);
  assert.equal((await launch(kbrain)).readLegacyExport, false);
});

test("a tampered or legacy-format marker falls back to one full pass and is rewritten", async (t) => {
  const store = setup(t, "http://marker-integrity-tamper.test");
  const kbrain = backend();
  native.legacy = page(conversation("legacy-a"));
  await launch(kbrain);
  const key = store.completionKey();
  const valid = store.values.get(key);
  for (const raw of [
    "1||sig-1",
    "null",
    "[]",
    JSON.stringify({ marker: JSON.parse(valid).marker, backendIds: [1] }),
    JSON.stringify({ marker: JSON.parse(valid).marker }),
    "{truncated",
  ]) {
    store.values.set(key, raw);
    assert.equal((await launch(kbrain)).readLegacyExport, true, `full pass for ${raw}`);
    assert.equal(store.values.get(key), valid, `rewritten after ${raw}`);
  }
});

test("a wiped K-brain store re-imports every legacy conversation, including ones deleted before", async (t) => {
  setup(t, "http://marker-integrity-wipe.test");
  const kbrain = backend();
  native.legacy = page(conversation("legacy-a"), conversation("legacy-deleted"));
  await launch(kbrain);
  kbrain.remove("legacy-deleted");
  await launch(kbrain); // notices the deletion once
  assert.equal((await launch(kbrain)).readLegacyExport, false, "control: marker skips");
  kbrain.wipe();
  kbrain.posts.length = 0;
  const after = await launch(kbrain);
  assert.equal(after.readLegacyExport, true);
  assert.deepEqual(kbrain.posts.sort(), ["legacy-a", "legacy-deleted"], "same as the pass before the marker");
});
