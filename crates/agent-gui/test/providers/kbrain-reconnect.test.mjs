import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const old = { baseUrl: "http://old.test", token: "old", protocolVersion: "kbrain.agent.v1" };
const fresh = { ...old, baseUrl: "http://new.test", token: "new" };

function setup(t, fetch, desktop = true) {
  let connections = 0;
  const loader = createTsModuleLoader({ mocks: {
    "@liveagent/app/shims/tauriCore": { invoke: async (command) => { assert.equal(command, "planning_migrate_legacy"); } },
    "@tauri-apps/api/core": { invoke: async () => { connections++; return fresh; } },
    [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => desktop },
  } });
  t.mock.method(globalThis, "fetch", fetch);
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection(old);
  return {
    runtime,
    connections: () => connections,
    transport: loader.loadModule("src/lib/kbrain/transport.ts"),
    client: loader.loadModule("src/lib/kbrain/client.ts").createKBrainClient(),
    planning: loader.loadModule("src/lib/planning/kbrain.ts"),
    cron: loader.loadModule("src/lib/automation/kbrainCron.ts"),
    prompts: loader.loadModule("src/lib/kbrain/prompts.ts").createKBrainPromptClient(),
    trajectory: loader.loadModule("src/lib/kbrain/trajectory.ts").createKBrainTrajectoryHost(),
    hooks: loader.loadModule("src/lib/automation/kbrainHooks.ts"),
    mapping: loader.loadModule("src/lib/kbrain/mapping.ts"),
    runTurn: loader.loadModule("src/lib/kbrain/turn.ts").runKBrainTurn,
  };
}

test("concurrent stale desktop reads reconnect once and existing clients use new credentials", async (t) => {
  const calls = [];
  const app = setup(t, async (url, init) => {
    calls.push({ url, token: new Headers(init.headers).get("Authorization") });
    if (url.startsWith(old.baseUrl)) throw new TypeError("Load failed");
    return Response.json({ models: [] });
  });
  await Promise.all([app.client.listModels(), app.planning.requestPlanning("query"), app.cron.fetchKBrainCron(), app.prompts.get(), app.trajectory.loadStats("1234abcd"), app.hooks.fetchKBrainHooks()]);
  assert.equal(app.connections(), 1);
  assert.equal(calls.filter(c => c.url.startsWith(fresh.baseUrl)).length, 6);
  assert.ok(calls.filter(c => c.url.startsWith(fresh.baseUrl)).every(c => c.token === "Bearer new"));
  await app.client.listModels();
  assert.equal(calls.at(-1).url, fresh.baseUrl + "/v1/models");
});

test("failed mutation refreshes the connection without automatically replaying the write", async (t) => {
  let calls = 0;
  const app = setup(t, async () => { calls++; throw new TypeError("Load failed"); });
  await assert.rejects(app.planning.requestPlanning("mutate", { action: "todo.create" }), /Load failed/);
  assert.equal(calls, 1);
  assert.equal(app.connections(), 1);
  assert.equal(app.runtime.getConfiguredKBrainConnection().baseUrl, fresh.baseUrl);
});

test("expired token reconnects reads, while HTTP business errors do not reconnect", async (t) => {
  const app = setup(t, async url => url.startsWith(old.baseUrl)
    ? new Response("expired", { status: 401 }) : Response.json({ models: [] }));
  await app.client.listModels();
  assert.equal(app.connections(), 1);
  t.mock.method(globalThis, "fetch", async () => new Response("conflict", { status: 409 }));
  await assert.rejects(app.client.listModels(), /conflict/);
  assert.equal(app.connections(), 1);
});

test("explicit endpoints, browser requests and cancellation never start a desktop reconnect", async (t) => {
  const app = setup(t, async () => { throw new TypeError("Load failed"); });
  await assert.rejects(app.transport.fetchKBrain("/v1/models", {}, { baseUrl: "https://remote.test" }), /Load failed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(app.transport.fetchKBrain("/v1/models", { signal: controller.signal }));
  assert.equal(app.connections(), 0);
});

test("browser errors stay on their configured endpoint", async (t) => {
  const app = setup(t, async () => { throw new TypeError("Load failed"); }, false);
  await assert.rejects(app.client.listModels(), /Load failed/);
  assert.equal(app.connections(), 0);
});

test("a second transport failure is returned without an infinite retry", async (t) => {
  let calls = 0;
  const app = setup(t, async () => { calls++; throw new TypeError("Load failed"); });
  await assert.rejects(app.client.listModels(), /Load failed/);
  assert.equal(calls, 2);
  assert.equal(app.connections(), 1);
});

test("run acceptance response loss queries the original request ID without repeating POST", async (t) => {
  const calls = [];
  const accepted = { version: "kbrain.agent.v1", conversation_id: "1234abcd", run_id: "original-run", accepted_seq: 1 };
  const app = setup(t, async (url, init) => {
    calls.push({url, method:init.method ?? "GET"});
    if (init.method === "POST") throw new TypeError("Load failed");
    assert.equal(new URL(url).searchParams.get("client_request_id"), "same/request");
    return Response.json(accepted);
  });
  assert.deepEqual(await app.client.startRun({conversation_id:"1234abcd",client_request_id:"same/request",prompt:"hello"}),accepted);
  assert.deepEqual(calls.map(c=>c.method),["POST","GET"]);
  assert.ok(calls[1].url.startsWith(fresh.baseUrl));
});

test("unknown lost acceptance returns transport error instead of manufacturing a new run", async (t) => {
  const calls = [];
  const app = setup(t, async (_url, init) => {
    calls.push(init.method ?? "GET");
    if(init.method === "POST") throw new TypeError("Load failed");
    return new Response("not found",{status:404});
  });
  await assert.rejects(app.client.startRun({conversation_id:"1234abcd",client_request_id:"unknown",prompt:"hello"}), {code:"KBRAIN_TRANSPORT_UNAVAILABLE"});
  assert.deepEqual(calls,["POST","GET"]);
});

test("cancelled reconnect waiter stops promptly without cancelling a shared reconnect", async (t) => {
  let resolveConnection;
  let entered;
  const started = new Promise(resolve=>{entered=resolve});
  const calls=[];
  const loader=createTsModuleLoader({mocks:{
    "@tauri-apps/api/core":{invoke:()=>{entered();return new Promise(resolve=>{resolveConnection=resolve})}},
    [new URL("../../src/lib/host.ts",import.meta.url).pathname]:{isTauriHost:()=>true},
  }});
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection(old);
  const {fetchKBrain}=loader.loadModule("src/lib/kbrain/transport.ts");
  t.mock.method(globalThis,"fetch",async url=>{
    calls.push(url);
    if(url.startsWith(old.baseUrl)) throw new TypeError("Load failed");
    return Response.json({});
  });
  const controller=new AbortController();
  const cancelled=fetchKBrain("/cancelled",{signal:controller.signal});
  const survivor=fetchKBrain("/survivor");
  await started;
  controller.abort(new Error("cancelled by user"));
  await assert.rejects(cancelled,/cancelled by user/);
  resolveConnection(fresh);
  assert.equal((await survivor).status,200);
  assert.ok(!calls.includes(fresh.baseUrl+"/cancelled"));
});

test("SSE consumer errors cancel the underlying stream", async(t)=>{
  let cancelled=false;
  const app=setup(t,async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode('data: {"version":"wrong"}\n\n'));},
    cancel(){cancelled=true},
  })));
  await assert.rejects(app.client.subscribe("1234abcd",0,{onEvent(){}}),/Unsupported K-brain protocol/);
  assert.equal(cancelled,true);
});

test("managed chat reconnects a live stream with its applied cursor and does not start another run", async(t)=>{
  const storage=new Map();
  const previousStorage=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  t.after(()=>{if(previousStorage)Object.defineProperty(globalThis,"localStorage",previousStorage);else delete globalThis.localStorage;});
  let starts=0, streams=0;
  const cursors=[];
  const ev=(seq,type,payload={})=>'data: '+JSON.stringify({version:"kbrain.agent.v1",conversation_id:"1234abcd",run_id:"one-run",seq,type,payload})+'\n\n';
  const app=setup(t,async(url,init)=>{

    const parsed=new URL(url);
    if(parsed.pathname.endsWith('/runs')){starts++;return Response.json({version:"kbrain.agent.v1",conversation_id:"1234abcd",run_id:"one-run",accepted_seq:1});}
    assert.ok(parsed.pathname.endsWith('/events'));
    streams++;
    cursors.push(parsed.searchParams.get('after_seq'));
    if(streams===1) return new Response(ev(2,'assistant.text.delta',{text:'first'}));
    if(parsed.origin===old.baseUrl) throw new TypeError('Load failed');
    return new Response(ev(3,'assistant.text.delta',{text:'second'})+ev(4,'run.completed'));
  });

  app.mapping.setKBrainSessionId('local','1234abcd');

  const beforeScope=app.mapping.kBrainStorageScope();
  const text=[];
  const result=await app.runTurn({conversationId:'local',sessionId:'host',cwd:'/tmp',model:{provider:'fixture',model:'fixture'},prompt:'hi',context:{messages:[]},signal:new AbortController().signal,onTextDelta:x=>text.push(x),onThinkingDelta(){},onToolCall(){},onToolResult(){}});

  assert.equal(result.stopReason,'stop');
  assert.equal(starts,1);
  assert.deepEqual(cursors,['1','2','2']);
  assert.deepEqual(text,['first','second']);
  assert.equal(app.mapping.getKBrainSessionId('local'),'1234abcd');
  assert.equal(app.mapping.kBrainStorageScope(),beforeScope);
});
