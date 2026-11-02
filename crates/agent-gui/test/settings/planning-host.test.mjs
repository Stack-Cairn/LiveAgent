import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("Planning uses the authenticated backend after the one-time native legacy export", async () => {
  const requests = [];
  let migrations = 0;
  const loader = createTsModuleLoader({ mocks: {
    "@tauri-apps/api/core": { invoke(command) { assert.equal(command, "planning_migrate_legacy"); migrations++; return Promise.resolve(); } },
    "@tauri-apps/api/event": { listen() { throw new Error("unexpected desktop listener"); } },
  } });
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({baseUrl:"http://planning.test",token:"secret",protocolVersion:"kbrain.agent.v1"});
  const { backend } = loader.loadModule("src/lib/planning/backend.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async (url,init) => { requests.push({url,init}); return {ok:true,json:async()=>({seq:7})}; };
  try {
    assert.equal((await backend.call("query",{from:1,to:2})).seq,7);
    assert.equal(backend.scope(),"liveagent-managed-kbrain");
    assert.equal(requests[0].url,"http://planning.test/v1/planning");
    assert.equal(new Headers(requests[0].init.headers).get("Authorization"),"Bearer secret");
    assert.deepEqual(JSON.parse(requests[0].init.body),{action:"query",input:{from:1,to:2}});
    globalThis.fetch = async () => ({ok:false,status:422,json:async()=>({error:"E:conflict"})});
    await assert.rejects(backend.call("mutate",{}),/E:conflict/);
    assert.equal(migrations, 1);
  } finally {globalThis.fetch=original;}
});
