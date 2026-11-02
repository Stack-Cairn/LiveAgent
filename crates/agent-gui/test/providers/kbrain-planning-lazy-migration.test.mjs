import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("backend connection has no dependency on legacy planning or timezone validation", () => {
  const source = fs.readFileSync("src-tauri/src/services/kbrain_backend.rs", "utf8");
  const command = source.slice(source.indexOf("pub async fn kbrain_backend_connection"), source.indexOf("fn resolve_binary"));
  assert(!command.includes("planning::"));
  assert(!command.includes("timezone"));
});

test("planning migration runs only on demand and retries after failure", async () => {
  let calls = 0;
  let fail = true;
  const requests = [];
  const loader = createTsModuleLoader({ mocks: {
    "@liveagent/app/shims/tauriCore": { invoke: async (command) => {
      assert.equal(command, "planning_migrate_legacy");
      calls++;
      if (fail) throw new Error("E:timezone_invalid");
    } },
    "../host": { isTauriHost: () => true },
    "../kbrain/mapping": { kBrainStorageScope: () => "fixture" },
    "../kbrain/transport": { fetchKBrain: async (_path, init) => {
      requests.push(JSON.parse(init.body).action);
      return new Response("{}");
    } },
  } });
  const api = loader.loadModule("src/lib/planning/kbrain.ts");
  assert.equal(calls, 0);
  for (const action of ["timezone.get", "cron.occurrences", "reminders.claim"]) await api.requestPlanning(action);
  assert.equal(calls, 0);
  await assert.rejects(api.requestPlanning("query"), /timezone_invalid/);
  assert(!requests.includes("query"));
  fail = false;
  await Promise.all([api.requestPlanning("query"), api.requestPlanning("export")]);
  assert.equal(calls, 2);
  await api.requestPlanning("mutate");
  assert.equal(calls, 2);
});
