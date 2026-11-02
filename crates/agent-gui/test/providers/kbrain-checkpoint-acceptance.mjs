import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const [pagePath, baseUrl, token, phase] = process.argv.slice(2);
assert.ok(pagePath && baseUrl && token);
assert.ok(["import", "rewind", "seed-unresolved", "repair"].includes(phase));
const page = JSON.parse(await readFile(pagePath, "utf8"));
if (phase === "seed-unresolved") {
  delete page.conversations[0].checkpoint;
  page.conversations[0].checkpointStatus = "unresolved";
}
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
  get length() { return values.size; },
  key: (index) => [...values.keys()][index] ?? null,
};
let nativeCalls = 0;
const loader = createTsModuleLoader({ mocks: {
  "@liveagent/app/shims/tauriCore": { invoke: async (command, args) => {
    assert.equal(command, "legacy_history_migration_page");
    assert.equal(args.cursor, undefined);
    nativeCalls++;
    return structuredClone(page);
  } },
  "../host": { isTauriHost: () => true },
} });
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
runtime.setKBrainRuntimeConnection({ baseUrl, token, protocolVersion: "kbrain.agent.v1" });
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
const client = createKBrainClient({ baseUrl, token });
const source = page.conversations[0];
const workspace = source.cwd;
const file = `${workspace}/binary.dat`;
const migrate = async (expectedStatus) => {
  const result = await migration.migrateLegacyHistoryOnce();
  assert.deepEqual(result.failures, []);
  assert.equal(result.complete, phase !== "seed-unresolved");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, expectedStatus);
  assert.equal(result.results[0].checkpoint, phase === "seed-unresolved" ? "unresolved" : "available");
  assert.equal(mapping.getKBrainSessionId(source.id, baseUrl), source.id);
};
try {
  await migrate(["import", "seed-unresolved"].includes(phase) ? "imported" : "already_imported");
  if (phase === "seed-unresolved") {
    assert.deepEqual(await client.listCheckpoints(source.id), []);
    await migrate("already_imported");
    console.log(JSON.stringify({ phase, nativeCalls, checkpoint: "unresolved", complete: false }));
  } else {
  const checkpoints = await client.listCheckpoints(source.id);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].turn_seq, 1);
  assert.equal(checkpoints[0].turn_id, "user-native");
  assert.equal(checkpoints[0].incomplete, false);
  const preview = await client.checkpointPreview(source.id, 1, [workspace]);
  assert.equal(preview.restore_files, 1);
  assert.equal(preview.capture_errors, 0);
  assert.equal(preview.entries[0].path, file);
  assert.deepEqual(await readFile(file), Buffer.from("modified workspace"));
  if (phase === "rewind") {
    const result = await client.checkpointRewind(source.id, 1, [workspace],
      preview.entries.map((entry) => ({ key: entry.key, currentHash: entry.current_hash })),
    );
    assert.equal(result.restored_files, 1);
    assert.equal(result.capture_errors, 0);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(await readFile(file), Buffer.from([0, 255, 1, 128]));
    const partialSource = structuredClone(source);
    partialSource.id = `partial-${source.id}`;
    partialSource.checkpoint.status = "partial";
    partialSource.checkpoint.records[0].blobBase64 = null;
    partialSource.checkpoint.invalidLines = ["acceptance: missing blob"];
    const partialImport = await migration.migrateLegacyHistoryPage({ conversations: [partialSource], complete: true });
    assert.deepEqual(partialImport.failures, []);
    assert.equal(partialImport.complete, false);
    assert.equal(partialImport.results[0].checkpoint, "partial");
    const partialPreview = await client.checkpointPreview(partialSource.id, 1, [workspace]);
    assert.deepEqual(partialPreview.entries, []);
    assert.equal(partialPreview.capture_errors, 1);
    const partialRewind = await client.checkpointRewind(partialSource.id, 1, [workspace], []);
    assert.equal(partialRewind.capture_errors, 1);
    assert.equal(partialRewind.restored_files, 0);
    assert.deepEqual(partialRewind.conflicts, []);
    assert.deepEqual(partialRewind.failed, []);
    assert.deepEqual(await readFile(file), Buffer.from([0, 255, 1, 128]));
  }
  await migrate("already_imported");
  const history = await client.getHistory(source.id, { maxMessages: 20 });
  assert.equal(history.total_message_count, 2);
  assert.equal(history.session.messages[1].id, "user-native");
  assert.equal(nativeCalls, 2);
  console.log(JSON.stringify({ phase, nativeCalls, checkpoint: "available", mappedTurn: 1, binaryRestored: phase === "rewind", historyMessages: history.total_message_count }));
  }
} finally {
  runtime.clearKBrainRuntimeConnection();
}
