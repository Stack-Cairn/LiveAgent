import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// A changed Pi session directory used to be read in full: every session file opened and
// parsed, page after page, because one appended file changed the whole-directory marker.
// Now each file's size, mtime and outcome are kept with the marker, so only new and changed
// files are read, and files another client is still writing are left for later.

const MINUTE = 60_000;
const native = {};
const loader = createTsModuleLoader({
  mocks: {
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command, args) => {
        native.calls.push(command);
        if (command === "legacy_history_migration_signature") return null;
        if (command === "legacy_history_migration_page") return { complete: true, conversations: [] };
        if (command === "pi_history_migration_signature") return signature();
        if (command === "pi_history_migration_manifest") {
          if (!native.manifest) throw new Error("unknown command");
          return { signature: signature(), files: listing() };
        }
        if (command === "pi_history_migration_read") {
          native.read.push(...args.sourceIds);
          return readFiles(args.sourceIds);
        }
        if (command === "pi_history_migration_page") {
          native.read.push(...native.files.keys());
          return readFiles([...native.files.keys()]);
        }
        throw new Error(`unexpected invoke ${command}`);
      },
    },
    "../host": { isTauriHost: () => true },
  },
});
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

const listing = () =>
  [...native.files].map(([sourceId, file]) => ({ sourceId, size: file.size, mtimeMs: file.mtimeMs }));
const signature = () => `pi:${JSON.stringify(listing())}`;

function conversation(id, messages) {
  return {
    id, title: `Session ${id}`, providerId: "p", model: "m", sessionId: `session-${id}`,
    createdAt: 1000, updatedAt: 2000, isPinned: false, isShared: false,
    redactToolContent: false, contextMetaJson: "{}",
    checkpoint: { status: "not_found", nativePath: "", reason: "no native checkpoint" },
    segments: [{ segmentIndex: 0, segmentId: "s0", messagesJson: JSON.stringify(
      messages.map((content, index) => ({ id: `${id}-${index}`, role: "user", content, timestamp: 1000 + index })),
    ) }],
  };
}

function readFiles(ids) {
  const conversations = [];
  const files = [];
  for (const sourceId of ids) {
    const file = native.files.get(sourceId);
    if (!file) {
      files.push({ sourceId, size: 0, mtimeMs: 0, status: "missing" });
      continue;
    }
    if (file.messages) conversations.push(conversation(sourceId, file.messages));
    files.push({ sourceId, size: file.size, mtimeMs: file.mtimeMs, status: file.messages ? "read" : "skipped" });
  }
  return { complete: true, source: "pi-jsonl", conversations, files };
}

function backend() {
  const existing = new Set();
  const posts = [];
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
      const body = JSON.parse(init.body);
      posts.push(body.source_id);
      existing.add(body.source_id);
      return new Response(JSON.stringify({ source_id: body.source_id, backend_id: body.source_id, status: "imported", checkpoint: "not_found", fingerprint: body.source_fingerprint }));
    }
    return new Response(JSON.stringify({ sessions: [], total_count: 0 }));
  };
  return { fetch, posts, existing };
}

const T0 = 1_700_000_000_000;

function setup(t, baseUrl, count = 30) {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "", protocolVersion: "kbrain.agent.v1" });
  const files = new Map();
  for (let index = 0; index < count; index++) {
    files.set(`pi-${String(index).padStart(24, "0")}`, { size: 100 + index, mtimeMs: T0 + index, messages: ["hello", `answer ${index}`] });
  }
  // A file in the directory that is not a session (no header): skipped, never imported.
  files.set("pi-ffffffffffffffffffffffff", { size: 7, mtimeMs: T0, messages: null });
  Object.assign(native, { calls: [], read: [], files, manifest: true });
  t.after(() => runtime.clearKBrainRuntimeConnection());
  return values;
}

const later = (minutes) => () => T0 + minutes * MINUTE;
const completion = (values) =>
  JSON.parse([...values].find(([key]) => key.startsWith("liveagent.kbrain-history-migration-complete.v1:") && key.endsWith("|pi"))[1]);

test("after one appended session file only that file is read", async (t) => {
  setup(t, "http://pi-incremental.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.equal(native.read.length, 31, "the first pass reads every file once");
  assert.equal(kbrain.posts.length, 30);

  native.read = [];
  const appended = native.files.get("pi-000000000000000000000007");
  Object.assign(appended, { size: appended.size + 40, mtimeMs: T0 + 5 * MINUTE, messages: [...appended.messages, "more"] });
  const second = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read, ["pi-000000000000000000000007"], "unchanged files are not parsed");
  assert.deepEqual(kbrain.posts.slice(30), ["pi-000000000000000000000007"]);
  assert.equal(second.complete, true);

  native.read = [];
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read, [], "the new directory signature is remembered");
});

test("a touched but unchanged file is read once and settled without a re-import", async (t) => {
  setup(t, "http://pi-touched.test");
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  native.read = [];
  native.files.get("pi-000000000000000000000003").mtimeMs = T0 + 4 * MINUTE;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read, ["pi-000000000000000000000003"]);
  assert.equal(kbrain.posts.length, 30, "the fingerprint matched the cached import");
  native.read = [];
  native.files.set("pi-aaaaaaaaaaaaaaaaaaaaaaaa", { size: 5, mtimeMs: T0 + MINUTE, messages: ["new"] });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read, ["pi-aaaaaaaaaaaaaaaaaaaaaaaa"], "the touched file is not read again");
});

test("a file written within the last two minutes is deferred, not marked done, and picked up later", async (t) => {
  const values = setup(t, "http://pi-defer.test");
  const kbrain = backend();
  native.files.get("pi-000000000000000000000004").mtimeMs = T0 + 9 * MINUTE;
  const events = [];
  const first = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10), onProgress: (event) => events.push(event) });
  assert.equal(first.deferred, 1);
  assert.equal(first.complete, false);
  assert.equal(first.failures.length, 0, "a deferred file is not a problem");
  assert.equal(native.read.includes("pi-000000000000000000000004"), false);
  assert.equal(kbrain.posts.includes("pi-000000000000000000000004"), false);
  assert.equal(events.filter((event) => event.outcome === "deferred").length, 1);
  assert.equal(completion(values).marker, "", "the directory is not marked done while a file waits");

  native.read = [];
  const second = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10.5) });
  assert.deepEqual(native.read, [], "still too recent; nothing else is read");
  assert.equal(second.deferred, 1);

  const third = await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(12) });
  assert.deepEqual(native.read, ["pi-000000000000000000000004"]);
  assert.equal(third.deferred, 0);
  assert.equal(kbrain.posts.includes("pi-000000000000000000000004"), true);
  assert.notEqual(completion(values).marker, "");
});

test("a file that changes while it is read is deferred too", async (t) => {
  setup(t, "http://pi-changed.test", 3);
  const kbrain = backend();
  const original = readFiles;
  native.manifest = true;
  const id = "pi-000000000000000000000001";
  const loaderWithChange = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command, args) => {
          if (command === "pi_history_migration_read") {
            const page = original(args.sourceIds);
            page.conversations = page.conversations.filter((item) => item.id !== id);
            page.files = page.files.map((file) => (file.sourceId === id ? { ...file, status: "changed" } : file));
            return page;
          }
          if (command === "pi_history_migration_manifest") return { signature: signature(), files: listing() };
          if (command === "pi_history_migration_signature") return signature();
          if (command === "legacy_history_migration_page") return { complete: true, conversations: [] };
          return null;
        },
      },
      "../host": { isTauriHost: () => true },
    },
  });
  const isolated = loaderWithChange.loadModule("src/lib/kbrain/historyMigration.ts");
  loaderWithChange.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({ baseUrl: "http://pi-changed.test", token: "", protocolVersion: "kbrain.agent.v1" });
  const result = await isolated.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.equal(result.deferred, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(kbrain.posts.includes(id), false);
});

test("an upgrade from the whole-directory marker records file state without reading any file", async (t) => {
  const values = setup(t, "http://pi-upgrade.test");
  const kbrain = backend();
  // A release without per-file state: the marker and the import cache only.
  native.manifest = false;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  const key = [...values.keys()].find((name) => name.includes("migration-complete") && name.endsWith("|pi"));
  const { sessions: _sessions, ...oldMarker } = completion(values);
  values.set(key, JSON.stringify(oldMarker));
  assert.equal(native.read.length, 31);

  native.manifest = true;
  native.read = [];
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read, [], "the unchanged directory is not read on the upgrade launch");
  assert.equal(Object.keys(completion(values).sessions.files).length, 30, "imported files got their state");

  const appended = native.files.get("pi-000000000000000000000002");
  Object.assign(appended, { size: appended.size + 9, mtimeMs: T0 + 3 * MINUTE, messages: [...appended.messages, "more"] });
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read.sort(), ["pi-000000000000000000000002", "pi-ffffffffffffffffffffffff"], "only the changed file (and the never-settled non-session file once) are read");
  native.read = [];
  appended.mtimeMs += 1;
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read, ["pi-000000000000000000000002"]);
});

test("a session lost from K-brain is read and imported again", async (t) => {
  setup(t, "http://pi-lost.test", 5);
  const kbrain = backend();
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  native.files.get("pi-000000000000000000000000").mtimeMs = T0 + 2 * MINUTE;
  kbrain.existing.delete("pi-000000000000000000000003");
  native.read = [];
  await migration.migrateAllHistoryOnce({ fetch: kbrain.fetch, now: later(10) });
  assert.deepEqual(native.read.sort(), ["pi-000000000000000000000000", "pi-000000000000000000000003"]);
  assert.equal(kbrain.posts.filter((id) => id === "pi-000000000000000000000003").length, 2);
});

test("the stored state is bounded and keeps the files modified longest ago", () => {
  const state = loader.loadModule("src/lib/kbrain/historyMigrationState.ts");
  const files = {};
  for (let index = 0; index < 10_050; index++) files[`pi-${index}`] = [1, 10_050 - index, "i", "fp"];
  const stored = state.storedSessionState(files);
  const ids = Object.keys(stored.files);
  assert.equal(ids.length, 10_000);
  assert.equal(ids.includes("pi-0"), false, "the most recently modified files are dropped first");
  assert.equal(ids.includes("pi-10049"), true);
  assert.deepEqual(state.parseSessionState(stored), stored.files);
  assert.equal(state.parseSessionState({ format: 0, files: stored.files }), null, "another format is ignored");
  assert.equal(state.isRecentlyModified(T0 - 119_000, T0), true);
  assert.equal(state.isRecentlyModified(T0 - 121_000, T0), false);
  assert.equal(state.isRecentlyModified(T0 + 3_600_000, T0), false, "a far-future mtime is not deferred forever");
});
