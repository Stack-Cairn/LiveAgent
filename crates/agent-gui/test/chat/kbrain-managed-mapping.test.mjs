import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("managed backend history identity survives port and token rotation without merging remote backends", () => {
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  const loader = createTsModuleLoader();
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
  try {
    runtime.setKBrainRuntimeConnection({ baseUrl: "http://127.0.0.1:40101", token: "first-secret", protocolVersion: "kbrain.agent.v1" });
    mapping.setKBrainSessionId("local-chat", "stored-session", "http://127.0.0.1:40101");
    mapping.setKBrainSessionId("local-chat", "remote-session", "https://remote.example");
    runtime.clearKBrainRuntimeConnection();
    runtime.setKBrainRuntimeConnection({ baseUrl: "http://127.0.0.1:40202", token: "second-secret", protocolVersion: "kbrain.agent.v1" });
    assert.equal(mapping.getKBrainSessionId("local-chat", "http://127.0.0.1:40202"), "stored-session");
    assert.equal(mapping.getKBrainConversationId("stored-session"), "local-chat");
    assert.equal(mapping.getKBrainSessionId("local-chat", "https://remote.example"), "remote-session");
    assert.equal(mapping.getKBrainSessionId("local-chat", "https://other.example"), undefined);
    assert.deepEqual(mapping.listKBrainSessionMappings(), [{ conversationId: "local-chat", sessionId: "stored-session" }]);
    assert.doesNotMatch([...values.values()].join(""), /first-secret|second-secret|40101|40202/);
    mapping.clearKBrainSessionId("local-chat");
    assert.equal(mapping.getKBrainSessionId("local-chat"), undefined);
    assert.equal(mapping.getKBrainSessionId("local-chat", "https://remote.example"), "remote-session");
  } finally {
    runtime.clearKBrainRuntimeConnection();
    globalThis.localStorage = originalStorage;
  }
});

test("ensure persists one ID even when storage writes fail and isolates managed data roots", () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem() { return null; }, setItem() { throw new Error("quota"); } };
  const loader = createTsModuleLoader();
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
  try {
    runtime.setKBrainRuntimeConnection({ baseUrl: "http://127.0.0.1:40101", token: "secret", protocolVersion: "kbrain.agent.v1", managedLocal: true, storageId: "root-a" });
    const first = mapping.ensureKBrainConversationId("backend-one");
    assert.equal(mapping.ensureKBrainConversationId("backend-one"), first);
    assert.equal(mapping.getKBrainSessionId(first), "backend-one");
    runtime.setKBrainRuntimeConnection({ baseUrl: "http://127.0.0.1:40101", token: "secret", protocolVersion: "kbrain.agent.v1", managedLocal: true, storageId: "root-b" });
    assert.equal(mapping.getKBrainConversationId("backend-one"), undefined);
  } finally { runtime.clearKBrainRuntimeConnection(); globalThis.localStorage = previous; }
});

test("mapping batches persist once and migrate old managed aliases to only one identified root", () => {
 const previous=globalThis.localStorage; const values=new Map(); let writes=0;
 globalThis.localStorage={ getItem:key=>values.get(key)??null, setItem(key,value){writes++;values.set(key,value);} };
 const loader=createTsModuleLoader();const runtime=loader.loadModule("src/lib/kbrain/runtimeConnection.ts");const mapping=loader.loadModule("src/lib/kbrain/mapping.ts");
 try {
  runtime.setKBrainRuntimeConnection({baseUrl:"http://127.0.0.1:40001",token:"test",protocolVersion:"kbrain.agent.v1"});
  mapping.setKBrainSessionId("existing-local","existing-backend");
  runtime.setKBrainRuntimeConnection({baseUrl:"http://127.0.0.1:40002",token:"test",protocolVersion:"kbrain.agent.v1",managedLocal:true,storageId:"data-root-a"});
  assert.equal(mapping.ensureKBrainConversationId("existing-backend"),"existing-local");
  writes=0;
  mapping.withKBrainMappingBatch(()=>{for(let i=0;i<248;i++) mapping.ensureKBrainConversationId(`batch-${i}`);});
  assert.equal(writes,1);
  mapping.withKBrainMappingBatch(()=>{for(let i=0;i<248;i++) mapping.ensureKBrainConversationId(`batch-${i}`);});
  assert.equal(writes,1);
  runtime.setKBrainRuntimeConnection({baseUrl:"http://127.0.0.1:40003",token:"test",protocolVersion:"kbrain.agent.v1",managedLocal:true,storageId:"data-root-b"});
  assert.equal(mapping.getKBrainConversationId("existing-backend"),undefined);
 } finally {runtime.clearKBrainRuntimeConnection();globalThis.localStorage=previous;}
});

test("deleting a migrated managed mapping cannot restore it from the old namespace",()=>{
 const original=globalThis.localStorage;const values=new Map();globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const loader=createTsModuleLoader();const runtime=loader.loadModule("src/lib/kbrain/runtimeConnection.ts");const mapping=loader.loadModule("src/lib/kbrain/mapping.ts");
 try{
 runtime.setKBrainRuntimeConnection({baseUrl:"http://127.0.0.1:40101",token:"t",protocolVersion:"kbrain.agent.v1"});mapping.setKBrainSessionId("old-local","backend");
 runtime.setKBrainRuntimeConnection({baseUrl:"http://127.0.0.1:40102",token:"t",protocolVersion:"kbrain.agent.v1",managedLocal:true,storageId:"root-a"});
 assert.equal(mapping.ensureKBrainConversationId("backend"),"old-local");mapping.clearKBrainSessionId("old-local");
 assert.equal(mapping.getKBrainConversationId("backend"),undefined);assert.equal(mapping.getKBrainSessionId("old-local"),undefined);
 }finally{runtime.clearKBrainRuntimeConnection();globalThis.localStorage=original;}
});
