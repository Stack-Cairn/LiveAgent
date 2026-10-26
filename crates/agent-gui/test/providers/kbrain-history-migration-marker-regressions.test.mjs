import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Regressions for the startup completion marker. Each test uses the real
// historyMigration module; only the Tauri IPC boundary and the K-brain HTTP endpoint are faked.

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

function conversation(id, messagesJson, extra = {}) {
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
        messagesJson:
          messagesJson ??
          JSON.stringify([{ id: `${id}-u0`, role: "user", content: "hello", timestamp: 1000 }]),
      },
    ],
    ...extra,
  };
}

function page(...conversations) {
  return { complete: true, conversations };
}

function backend({ importStatus = () => 200, importDelay = () => 0 } = {}) {
  const existing = new Set();
  const posts = [];
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") {
      return new Response(JSON.stringify({ status: "ok", capabilities: { session_exists: 1 } }));
    }
    if (path === "/v1/sessions/exists") {
      const { ids } = JSON.parse(init.body);
      return new Response(JSON.stringify({ existing: ids.filter((id) => existing.has(id)) }));
    }
    if (path === "/v1/sessions") {
      return new Response(
        JSON.stringify({ sessions: [...existing].map((id) => ({ id })), total_count: existing.size }),
      );
    }
    if (path === "/v1/migrations/liveagent-history") {
      const body = JSON.parse(init.body);
      posts.push(body.source_id);
      const delay = importDelay(body.source_id);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const status = importStatus(body.source_id);
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "rejected payload" }), { status });
      }
      existing.add(body.source_id);
      return new Response(
        JSON.stringify({
          source_id: body.source_id,
          backend_id: body.source_id,
          status: "imported",
          checkpoint: "not_found",
          fingerprint: body.source_fingerprint,
        }),
      );
    }
    if (path.startsWith("/v1/sessions/")) {
      const id = decodeURIComponent(path.slice("/v1/sessions/".length));
      if (!existing.has(id)) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ id }));
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  return { fetch, posts, existing };
}

function setup(t, baseUrl) {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "", protocolVersion: "kbrain.agent.v1" });
  Object.assign(native, { signature: "sig-1", pages: 0, legacy: page(), pi: page() });
  t.after(() => runtime.clearKBrainRuntimeConnection());
  return values;
}

test("a legacy conversation that can never convert locally does not disable the marker forever", async (t) => {
  setup(t, "http://marker-regression-local-failure.test");
  // One unparseable segment: the same DB content fails the same way on every launch and never
  // reaches K-brain, but it is classified "transient" because no import POST was attempted.
  native.legacy = page(conversation("legacy-good"), conversation("legacy-bad", "{not json"));
  const kbrain = backend();
  const first = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(first.failures.length, 1);
  assert.equal(first.failures[0].sourceId, "legacy-bad");

  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(
    native.pages,
    1,
    "unchanged legacy DB + deterministic local failure should be covered by the marker, " +
      "otherwise startup re-reads the whole legacy export on every launch",
  );
});

test("a deterministic import rejection is retried after an app upgrade changes the export of the same DB", async (t) => {
  setup(t, "http://marker-regression-export-version.test");
  globalThis.__LIVEAGENT_APP_VERSION__ = "2.0.0-beta.22";
  t.after(() => delete globalThis.__LIVEAGENT_APP_VERSION__);
  native.legacy = page(conversation("legacy-a"));
  // K-brain rejects this payload (400 -> "rejected", deterministic); the marker is written.
  let reject = true;
  const kbrain = backend({ importStatus: () => (reject ? 400 : 200) });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["legacy-a"]);

  // A later LiveAgent release exports the same, untouched DB differently (the Rust exporter or the
  // TS converter changed), so the source fingerprint changes while the DB signature does not.
  // Before the marker existed, the changed fingerprint no longer matched the failure record and
  // startup re-sent it.
  globalThis.__LIVEAGENT_APP_VERSION__ = "2.0.0-beta.23";
  native.legacy = page(conversation("legacy-a", undefined, { exportFormat: 2 }));
  reject = false;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(
    kbrain.posts,
    ["legacy-a", "legacy-a"],
    "the marker must not hide a payload change produced by a new exporter/converter",
  );
});

test("the marker skip re-imports a legacy session K-brain lost even when legacy and pi passes raced on the cache", async (t) => {
  const storage = setup(t, "http://marker-regression-cache-race.test");
  native.legacy = page(conversation("legacy-a"));
  native.pi = page(conversation("pi-a"));
  // The pi import finishes after the legacy one; both pages read the cache before either wrote.
  const kbrain = backend({ importDelay: (id) => (id === "pi-a" ? 30 : 5) });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts.sort(), ["legacy-a", "pi-a"]);
  const cacheKey = [...storage.keys()].find((key) =>
    key.startsWith("liveagent.kbrain-history-migration.v1:"),
  );
  const cachedIds = Object.keys(JSON.parse(storage.get(cacheKey)));

  // K-brain loses the migrated legacy session (store wiped / restored from an older backup).
  kbrain.existing.delete("legacy-a");
  kbrain.posts.length = 0;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.ok(
    kbrain.posts.includes("legacy-a"),
    `the lost legacy session must be re-imported; cache after first pass held only ${JSON.stringify(cachedIds)}`,
  );
});

test("the marker skip re-imports lost sessions when the cache write was rejected by storage quota", async (t) => {
  const storage = setup(t, "http://marker-regression-cache-quota.test");
  // Large caches hit the WebView localStorage quota first; the tiny marker still fits.
  globalThis.localStorage.setItem = (key, value) => {
    if (key.startsWith("liveagent.kbrain-history-migration.v1:")) {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    storage.set(key, String(value));
  };
  native.legacy = page(conversation("legacy-a"));
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(kbrain.posts, ["legacy-a"]);

  kbrain.existing.clear();
  kbrain.posts.length = 0;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.deepEqual(
    kbrain.posts,
    ["legacy-a"],
    "with no cache to verify against, the marker must not vouch for K-brain still holding the import",
  );
});
