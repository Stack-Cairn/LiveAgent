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
