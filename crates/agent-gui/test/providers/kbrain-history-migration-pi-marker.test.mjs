import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Pi sessions used to be rescanned (every file opened and parsed, page after page) on every
// launch. An unchanged session directory whose last complete pass is still in K-brain is now
// skipped, exactly like the legacy database.

const native = {};
const loader = createTsModuleLoader({
  mocks: {
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command) => {
        native.calls.push(command);
        if (command === "legacy_history_migration_signature") return native.legacySignature;
        if (command === "legacy_history_migration_page") return { complete: true, conversations: [] };
        if (command === "pi_history_migration_signature") {
          if (native.piSignature instanceof Error) throw native.piSignature;
          return native.piSignature;
        }
        if (command === "pi_history_migration_page") return piPage();
        throw new Error(`unexpected invoke ${command}`);
      },
    },
    "../host": { isTauriHost: () => true },
  },
});
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

function piPage() {
  return {
    complete: true,
    source: "pi-jsonl",
    conversations: [{
      id: "pi-a", title: "Pi session", providerId: "p", model: "m", sessionId: "pi-session-a",
      createdAt: 1000, updatedAt: 2000, isPinned: false, isShared: false,
      redactToolContent: false, contextMetaJson: "{}",
      checkpoint: { status: "not_found", nativePath: "", reason: "no native checkpoint" },
      segments: [{ segmentIndex: 0, segmentId: "s0", messagesJson: JSON.stringify([
        { id: "u0", role: "user", content: "hello", timestamp: 1000 },
      ]) }],
    }],
  };
}

function backend() {
  const existing = new Set();
  const calls = { posts: 0 };
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") {
      return new Response(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", capabilities: { session_exists: 1 } }));
    }
    if (path === "/v1/sessions/exists") {
      const { ids } = JSON.parse(init.body);
      return new Response(JSON.stringify({ existing: ids.filter((id) => existing.has(id)) }));
    }
    if (path === "/v1/migrations/liveagent-history") {
      calls.posts++;
      existing.add("pi-a");
      return new Response(JSON.stringify({ source_id: "pi-a", backend_id: "pi-a", status: "imported", checkpoint: "not_found", fingerprint: "fp" }));
    }
    return new Response(JSON.stringify({ sessions: [], total_count: 0 }));
  };
  return { fetch, calls, existing };
}

function setup(t, baseUrl) {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "", protocolVersion: "kbrain.agent.v1" });
  Object.assign(native, { calls: [], legacySignature: "legacy-1", piSignature: "pi:1:aaaa" });
  t.after(() => runtime.clearKBrainRuntimeConnection());
  return values;
}

const piPageReads = () => native.calls.filter((command) => command === "pi_history_migration_page").length;
const legacyPageReads = () => native.calls.filter((command) => command === "legacy_history_migration_page").length;

test("an unchanged Pi session directory is not rescanned after a complete pass", async (t) => {
  setup(t, "http://pi-skip.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(piPageReads(), 1);
  assert.equal(kbrain.calls.posts, 1);

  const second = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(piPageReads(), 1, "the session files are not read again");
  assert.equal(kbrain.calls.posts, 1);
  assert.equal(second.complete, true);
  assert.equal(second.failures.length, 0);
});

test("a changed Pi directory or a session missing from K-brain triggers the full pass", async (t) => {
  setup(t, "http://pi-change.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  // A session file was added, removed, appended to or touched.
  native.piSignature = "pi:2:bbbb";
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(piPageReads(), 2);
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(piPageReads(), 2, "the new signature is remembered after its pass");

  kbrain.existing.clear();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(piPageReads(), 3, "a wiped K-brain store is repaired");
  assert.equal(kbrain.calls.posts, 2);
});

test("legacy and Pi completions are tracked separately", async (t) => {
  const storage = setup(t, "http://pi-separate.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(legacyPageReads(), 1);
  assert.equal(piPageReads(), 1);
  const keys = [...storage.keys()].filter((key) => key.startsWith("liveagent.kbrain-history-migration-complete.v1:"));
  assert.equal(keys.length, 2, "one completion per source");

  native.legacySignature = "legacy-2";
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(legacyPageReads(), 2, "the changed legacy source runs");
  assert.equal(piPageReads(), 1, "the unchanged Pi source stays skipped");
});

test("without a Pi signature (older desktop) every launch runs the full pass, as before", async (t) => {
  setup(t, "http://pi-no-signature.test");
  native.piSignature = new Error("unknown command pi_history_migration_signature");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(piPageReads(), 2);
  native.piSignature = null;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch });
  assert.equal(piPageReads(), 3);
});
