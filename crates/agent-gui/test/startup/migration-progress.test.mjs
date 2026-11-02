import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createStartupProgress, applyMigrationProgress, migrationCounts } = loader.loadModule("src/lib/startup/progress.ts");
const { createStartupRenderer, startupLanguage } = loader.loadModule("src/lib/startup/render.ts");

test("interleaved sources keep exclusive counts and never end the other source", () => {
  let state = createStartupProgress(10);
  state = applyMigrationProgress(state, {source: "legacy", operation: "importing"}, 20);
  state = applyMigrationProgress(state, {source: "pi", operation: "settled", outcome: "partial"}, 30);
  state = applyMigrationProgress(state, {source: "pi", operation: "done"}, 40);
  assert.equal(state.sources.legacy.operation, "importing");
  for (const outcome of ["imported", "alreadyImported", "skipped", "failed"]) state = applyMigrationProgress(state, {source: "legacy", operation: "settled", outcome}, 50);
  assert.deepEqual(JSON.parse(JSON.stringify(migrationCounts(state))), {imported:1, alreadyImported:1, skipped:1, failed:1, partial:1, processed:5});
  state = applyMigrationProgress(state, {source: "legacy", operation: "reading"}, 60);
  state = applyMigrationProgress(state, {source: "legacy", operation: "reading"}, 70);
  assert.equal(state.lastProgressAt, 60);
});

test("loading screen shows real work, slow waits, accessible failure, and isolates old callbacks", (t) => {
  const dom = new JSDOM(readFileSync(new URL("../../index.html", import.meta.url), "utf8"), {url:"http://localhost"});
  const doc = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem("liveagent.ui-settings.v1", JSON.stringify({locale:"en"}));
  assert.equal(startupLanguage(), "en");
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; dom.window.close(); delete globalThis.localStorage; });
  const old = createStartupRenderer(doc);
  let current;
  t.after(() => { old.dispose(); current?.dispose(); });
  old.phase("checking");
  now = 32_000;
  // Force a paint without inventing settled work.
  old.progress({source:"pi", operation:"done"});
  now = 64_000;
  old.progress({source:"pi", operation:"done"});
  assert.match(doc.querySelector("[data-boot-waiting]").textContent, /taking a while/);
  assert.equal(doc.querySelector("[data-boot-counts]").textContent, "");
  old.progress({source:"legacy", operation:"settled", outcome:"imported"});
  old.phase("migrating");
  assert.match(doc.querySelector("[data-boot-counts]").textContent, /Processed 1/);
  assert.doesNotMatch(doc.querySelector("[data-static-boot-shell]").textContent, /%/);
  let retries = 0;
  old.fail(() => { retries++; current = createStartupRenderer(doc); });
  assert.equal(doc.querySelector("[data-static-boot-shell]").getAttribute("aria-busy"), "false");
  assert.equal(doc.querySelector("[data-boot-retry]").hidden, false);
  doc.querySelector("[data-boot-retry]").click();
  doc.querySelector("[data-boot-retry]").click();
  assert.equal(retries, 1);
  old.progress({source:"legacy", operation:"settled", outcome:"imported"});
  current.phase("checking");
  assert.equal(doc.querySelector("[data-boot-counts]").textContent, "");
  assert.equal(doc.querySelector("[data-boot-title]").textContent, "Checking old data");
  current.dispose();
  current.phase("opening");
  assert.equal(doc.querySelector("[data-boot-title]").textContent, "Checking old data");
});

function oldConversation(id) {
  return { id, title:"private title", providerId:"removed", model:"removed", createdAt:1000, updatedAt:2000, isPinned:false, isShared:false, redactToolContent:false, contextMetaJson:"{}", checkpoint:{status:"not_found"}, segments:[{segmentIndex:0, segmentId:"first", messagesJson:JSON.stringify([{id:"user", role:"user", content:"private body", timestamp:1000}])}] };
}

test("real migration emits exactly one settled outcome per conversation and isolates observer failures", async (t) => {
  const values = new Map();
  globalThis.localStorage = {getItem:key=>values.get(key)??null, setItem:(key,value)=>values.set(key,String(value))};
  t.after(()=>delete globalThis.localStorage);
  const isolated = createTsModuleLoader({mocks:{
    "@liveagent/app/shims/tauriCore":{invoke:async command=>({complete:true, conversations:command==="legacy_history_migration_page"?[oldConversation("ok"),oldConversation("deleted"),oldConversation("bad"),oldConversation("partial")]:[oldConversation("other")]})},
    "../host":{isTauriHost:()=>true},
  }});
  const migration = isolated.loadModule("src/lib/kbrain/historyMigration.ts");
  const runtime = isolated.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({baseUrl:"http://migration.test", token:"", protocolVersion:"kbrain.agent.v1"});
  t.after(()=>runtime.clearKBrainRuntimeConnection());
  const events=[];
  const fetch=async (_url, init)=>{
    const payload=JSON.parse(init.body);
    if(payload.source_id==="deleted") return new Response(JSON.stringify({error:"deleted"}),{status:410});
    if(payload.source_id==="bad") return new Response(JSON.stringify({error:"offline"}),{status:500});
    return new Response(JSON.stringify({source_id:payload.source_id,backend_id:payload.source_id,status:"imported",fingerprint:"fixture",checkpoint:payload.source_id==="partial"?"partial":"not_found"}));
  };
  const result=await migration.migrateAllHistoryOnce({fetch,onProgress:event=>{events.push(event);throw new Error("observer failed");}});
  assert.equal(result.failures.length,1, JSON.stringify(result.failures.map(({sourceId,error})=>({sourceId,error}))));
  const settled=events.filter(event=>event.operation==="settled");
  assert.equal(settled.length,5);
  assert.equal(settled.filter(event=>event.outcome==="imported").length,2);
  assert.equal(settled.filter(event=>event.outcome==="skipped").length,1);
  assert.equal(settled.filter(event=>event.outcome==="failed").length,1);
  assert.equal(settled.filter(event=>event.outcome==="partial").length,1);
  assert.equal(events.filter(event=>event.operation==="done").length,2);
  assert.deepEqual([...new Set(events.map(event=>event.source))].sort(),["legacy","pi"]);
  assert.doesNotMatch(JSON.stringify(events),/private title|private body/);
  const cached=[];
  const repeated=await migration.migrateLegacyHistoryPage({complete:true,conversations:[oldConversation("ok")]},{fetch,sessionExists:async()=>true,onProgress:event=>cached.push(event)});
  assert.equal(repeated.results[0].status,"already_imported");
  assert.equal(cached.filter(event=>event.operation==="settled")[0].outcome,"alreadyImported");
});

test("a broken page marks only its own source as error", async (t) => {
  const values=new Map();globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))};t.after(()=>delete globalThis.localStorage);
  const isolated=createTsModuleLoader({mocks:{"@liveagent/app/shims/tauriCore":{invoke:async command=>{if(command==="legacy_history_migration_page")throw new Error("cannot read old data");return {complete:true,conversations:[]};}},"../host":{isTauriHost:()=>true}}});
  const migration=isolated.loadModule("src/lib/kbrain/historyMigration.ts");
  const runtime=isolated.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({baseUrl:"http://migration.test",token:"",protocolVersion:"kbrain.agent.v1"});t.after(()=>runtime.clearKBrainRuntimeConnection());
  const events=[];const result=await migration.migrateAllHistoryOnce({onProgress:event=>events.push(event)});
  assert.equal(result.complete,false);
  assert.equal(result.failures.length,1);
  assert.equal(events.some(e=>e.source==="legacy"&&e.operation==="error"),true);
  assert.equal(events.some(e=>e.source==="legacy"&&e.operation==="done"),false);
  assert.equal(events.some(e=>e.source==="pi"&&e.operation==="done"),true);
  assert.equal(events.some(e=>e.operation==="settled"),false);
});
