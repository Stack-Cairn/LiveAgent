import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("manual import merges double clicks, publishes results, notifies history and remains retryable", async () => {
  let calls = 0;
  let resolve;
  let fail = false;
  const loader = createTsModuleLoader({ mocks: {
    "../host": { isTauriHost: () => true },
    "./historyMigration": { migrateAllHistoryOnce: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return new Promise(r => { resolve = r; });
    } },
  } });
  const api = loader.loadModule("src/lib/kbrain/manualHistoryImport.ts");
  let changed = 0;
  const unsubscribe = api.subscribeHistoryImported(() => changed++);
  const first = api.importOldConversations();
  assert.equal(api.getHistoryImportState().running, true);
  assert.equal(first, api.importOldConversations());
  assert.equal(calls, 1);
  resolve({results:[{source_id:"old",backend_id:"old",status:"imported",checkpoint:"not_found"}],failures:[{sourceId:"bad",error:"invalid"}],complete:false});
  await first;
  assert.equal(changed, 1);
  assert.equal(api.getHistoryImportState().result.failures.length, 1);
  fail = true;
  await api.importOldConversations();
  assert.equal(api.getHistoryImportState().running, false);
  assert.equal(api.getHistoryImportState().error, "offline");
  assert.equal(changed, 1);
  fail = false;
  const retry = api.importOldConversations();
  resolve({results:[],failures:[],complete:true});
  await retry;
  assert.equal(api.getHistoryImportState().error, undefined);
  assert.equal(calls, 3);
  unsubscribe();
});

test("browser cannot report a successful native import", async () => {
  const loader = createTsModuleLoader({ mocks: {
    "../host": { isTauriHost: () => false },
    "./historyMigration": { migrateAllHistoryOnce: () => { throw new Error("must not run"); } },
  } });
  const api = loader.loadModule("src/lib/kbrain/manualHistoryImport.ts");
  await assert.rejects(api.importOldConversations(), /desktop app/);
  assert.equal(api.getHistoryImportState().result, undefined);
});

test("deferred sessions are picked up later in the session by one timer, not a watcher", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const passes = [];
  const answers = [
    { results: [], failures: [], complete: false, deferred: 2 },
    { results: [{ source_id: "pi-a", backend_id: "pi-a", status: "imported", checkpoint: "not_found" }], failures: [], complete: true, deferred: 0 },
  ];
  const loader = createTsModuleLoader({ mocks: {
    "../host": { isTauriHost: () => true },
    "./historyMigration": { migrateAllHistoryOnce: async (options) => { passes.push(options); return answers.shift(); } },
  } });
  const api = loader.loadModule("src/lib/kbrain/manualHistoryImport.ts");
  let changed = 0;
  api.subscribeHistoryImported(() => changed++);
  api.scheduleDeferredHistoryImport(1000);
  api.scheduleDeferredHistoryImport(1000);
  t.mock.timers.tick(999);
  assert.equal(passes.length, 0);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes.length, 1, "one timer, however often it is asked for");
  assert.equal(passes[0]?.retryKnownFailures, undefined, "the ordinary pass, not the manual retry");
  // Still being written: checked again, later.
  t.mock.timers.tick(1999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes.length, 1);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes.length, 2);
  assert.equal(changed, 1, "the chat list refreshes once the session is imported");
  t.mock.timers.tick(60 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes.length, 2, "nothing left to wait for");
});
