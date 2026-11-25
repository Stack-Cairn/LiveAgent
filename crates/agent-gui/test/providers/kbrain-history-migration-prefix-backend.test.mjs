import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Re-importing a conversation that grew since its first import, against a real K-brain. A
// backend with `history_import_prefix_update` extends the session in place; an older one
// refuses with a bare 409, which stays a recorded conflict exactly as before.
// LIVEAGENT_KBRAIN_PREVIOUS_BINARY (optional) names an older build to start from, to check
// that a conflict recorded there is retried once after the upgrade.

const loader = createTsModuleLoader({ mocks: { "../host": { isTauriHost: () => true } } });
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const failures = loader.loadModule("src/lib/kbrain/historyMigrationFailures.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");

function conversation(id, texts) {
  const messages = texts.map((text, index) =>
    index % 2 === 0
      ? { id: `${id}-${index}`, role: "user", content: text, timestamp: 1000 + index }
      : { id: `${id}-${index}`, role: "assistant", content: [{ type: "text", text }], timestamp: 1000 + index },
  );
  return {
    id, title: `Synthetic ${id}`, providerId: "fixture", model: "fixture-model", createdAt: 1000, updatedAt: 1000 + texts.length,
    isPinned: false, isShared: false, redactToolContent: false, contextMetaJson: "{}", checkpoint: { status: "not_found" },
    segments: [{ segmentIndex: 0, segmentId: "s0", messagesJson: JSON.stringify(messages) }],
  };
}

async function startBackend(t, binary, root) {
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({ defaultModel: "fixture-model", providers: { fixture: { api: "openai-completions", apiKey: "fixture-key", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "fixture-model", contextWindow: 32768, maxTokens: 256 }] } } }));
  const child = spawn(binary, ["backend", "-listen", "127.0.0.1:0", "-token", "prefix-fixture", "-config", config, "-data-dir", root], { env: { ...process.env, LIVEAGENT_HOME: root, K_BRAIN_HOME: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stderr.on("data", (data) => { logs += data; });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend readiness: ${logs}`)), 15_000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`backend exit ${code}: ${logs}`)); });
    child.stdout.on("data", (data) => {
      logs += data;
      const match = logs.match(/k-brain backend listening on (http:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const stop = async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } };
  t.after(stop);
  // One storage identity across restarts and ports, like the managed desktop backend.
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "prefix-fixture", protocolVersion: "kbrain.agent.v1", managedLocal: true, storageId: "prefix-e2e" });
  const health = await createKBrainClient({}).getHealth();
  return { stop, prefixUpdate: health.capabilities?.history_import_prefix_update === 1, health };
}

function memoryStorage(t) {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  t.after(() => { delete globalThis.localStorage; runtime.clearKBrainRuntimeConnection(); });
}

const page = (...conversations) => ({ complete: true, conversations });
const outcomes = async (...conversations) => {
  const events = [];
  const result = await migration.migrateLegacyHistoryPage(page(...conversations), { onProgress: (event) => events.push(event) });
  return { result, outcomes: events.filter((event) => event.operation === "settled").map((event) => event.outcome) };
};
const records = () => failures.readHistoryMigrationFailures(mapping.kBrainStorageScope());

test("a grown conversation is updated in place, or stays a plain conflict on an older backend", { timeout: 60_000 }, async (t) => {
  memoryStorage(t);
  const root = await mkdtemp(path.join(tmpdir(), "la-prefix-e2e-"));
  const backend = await startBackend(t, await getKBrainBinary(), root);
  const first = await outcomes(conversation("pi-e2e-grow", ["hello", "hi there"]), conversation("pi-e2e-fork", ["start", "ok"]));
  assert.deepEqual(first.outcomes, ["imported", "imported"]);

  const grown = await outcomes(conversation("pi-e2e-grow", ["hello", "hi there", "and then?", "more"]));
  const diverged = await outcomes(conversation("pi-e2e-fork", ["start", "a different answer", "next"]));
  if (backend.prefixUpdate) {
    assert.deepEqual(grown.outcomes, ["imported"]);
    assert.equal(grown.result.results[0].updated, true);
    assert.equal(grown.result.results[0].status, "imported");
    assert.deepEqual(diverged.outcomes, ["failed"]);
    assert.equal(diverged.result.failures[0].kind, "conflict");
    assert.equal(diverged.result.failures[0].reason, "diverged");
    assert.deepEqual(records().map(({ sourceId, kind, reason }) => ({ sourceId, kind, reason })), [{ sourceId: "pi-e2e-fork", kind: "conflict", reason: "diverged" }]);
    // The same history again (sent to K-brain, not answered from the cache) is already
    // imported, not updated.
    const empty = new Map();
    globalThis.localStorage = { getItem: (key) => empty.get(key) ?? null, setItem: (key, value) => empty.set(key, String(value)), removeItem: (key) => empty.delete(key) };
    const again = await migration.migrateLegacyHistoryPage(page(conversation("pi-e2e-grow", ["hello", "hi there", "and then?", "more"])), { retryKnownFailures: true });
    assert.equal(again.results[0].status, "already_imported");
    assert.equal(again.results[0].updated, undefined);
  } else {
    // Older backend: today's behaviour, a conflict without a reason.
    for (const run of [grown, diverged]) {
      assert.deepEqual(run.outcomes, ["failed"]);
      assert.equal(run.result.failures[0].kind, "conflict");
      assert.equal(run.result.failures[0].reason, undefined);
    }
    assert.equal(records().every((record) => record.kind === "conflict" && !("reason" in record)), true);
  }
});

test("a conflict recorded on an older backend is retried once after the upgrade", { timeout: 60_000, skip: !process.env.LIVEAGENT_KBRAIN_PREVIOUS_BINARY && "set LIVEAGENT_KBRAIN_PREVIOUS_BINARY to an older build" }, async (t) => {
  memoryStorage(t);
  const root = await mkdtemp(path.join(tmpdir(), "la-prefix-upgrade-e2e-"));
  const previous = await startBackend(t, process.env.LIVEAGENT_KBRAIN_PREVIOUS_BINARY, root);
  assert.equal(previous.prefixUpdate, false, "the previous build must predate prefix updates");
  await outcomes(conversation("pi-e2e-upgrade", ["hello", "hi there"]));
  const grown = conversation("pi-e2e-upgrade", ["hello", "hi there", "and then?", "more"]);
  assert.deepEqual((await outcomes(grown)).outcomes, ["failed"]);
  assert.deepEqual((await outcomes(grown)).outcomes, ["skipped"], "the old backend's conflict stays skipped");
  await previous.stop();

  const current = await startBackend(t, await getKBrainBinary(), root);
  if (!current.prefixUpdate) { t.skip("LIVEAGENT_KBRAIN_BINARY does not advertise history_import_prefix_update"); return; }
  const upgraded = await outcomes(grown);
  assert.deepEqual(upgraded.outcomes, ["imported"], "retried once on the new backend and updated in place");
  assert.equal(upgraded.result.results[0].updated, true);
  assert.deepEqual(records(), []);
  const session = await createKBrainClient({}).getSession(upgraded.result.results[0].backend_id);
  assert.ok(JSON.stringify(session).includes("and then?"), "the new messages are in K-brain");
});
