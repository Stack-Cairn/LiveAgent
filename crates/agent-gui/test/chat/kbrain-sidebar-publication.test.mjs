import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}throw new Error("publication timed out");}

test("desktop republishes authority after a fast Gateway reconnect without waiting for a K-brain change",async()=>{
 let configuration;let healthy=false;let heartbeat;let gatewaySession="first";const calls=[];
 const originalInterval=globalThis.setInterval;const originalClear=globalThis.clearInterval;
 globalThis.setInterval=(callback)=>{heartbeat=callback;return 123;};globalThis.clearInterval=()=>{};
 const loader=createTsModuleLoader({mocks:{
  "@liveagent/app/shims/tauriCore":{invoke:async(command,args)=>{if(command==="gateway_status")return{online:true,agentId:"agent",sessionId:gatewaySession};calls.push(args.input);return{accepted:true,needsResync:false};}},
  "./client":{createKBrainClient:()=>({})},
  "./history":{summaryForSession:(session,id)=>({id,title:session.title,sessionId:session.id,createdAt:1,updatedAt:2,providerId:"fixture",model:"test",messageCount:2})},
  "./sessionSync":{createKBrainSessionSync:options=>{configuration=options;return{isHealthy:()=>healthy,restart:()=>{},acquire:()=>()=>{},getSnapshot:()=>undefined,waitForRevision:async()=>{}};}},
  "./sessionSyncState":{setKBrainMutationSync:()=>{}},
 }});
 let stop;
 try{
  const {kBrainSidebarSync}=loader.loadModule("src/lib/kbrain/sidebarSync.ts");stop=kBrainSidebarSync.subscribe(()=>{});
  healthy=true;configuration.onSnapshot({epoch:"epoch",revision:"1",sessions:new Map([["backend",{id:"backend",title:"title"}]]),workdirs:[]});configuration.onHealth(true);
  await until(()=>calls.filter(call=>call.kind==="snapshot").length===1);
  await tick();gatewaySession="replacement";heartbeat();
  await until(()=>calls.filter(call=>call.kind==="snapshot").length===2);
  const snapshots=calls.filter(call=>call.kind==="snapshot");
  assert.equal(snapshots[1].conversations[0].id,snapshots[0].conversations[0].id);
  assert.equal(snapshots[1].deliverySeq,0);
 }finally{stop?.();globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;}
});

test("debug diagnostics stay DEV-only and do not return connection or backend error text", async () => {
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(new URL("../../src/lib/kbrain/sidebarSync.ts",import.meta.url),"utf8");
 const start=source.indexOf('if (import.meta.env?.DEV && typeof window !== "undefined")');
 assert.ok(start>=0);
 const diagnostics=source.slice(start,source.indexOf("function updateHealth",start));
 assert.match(diagnostics,/__LIVEAGENT_SESSION_SYNC_DIAGNOSTICS__/);
 assert.doesNotMatch(diagnostics,/token:|baseUrl:|sourceId:|workdirs:|error:\s*lastFailure\s*,/);
 assert.match(diagnostics,/error: lastFailure \? "Session synchronization unavailable"/);
});

test("a backend epoch reset replaces the Gateway generation even at the same endpoint",async()=>{
 let configuration;let healthy=false;const calls=[];
 const loader=createTsModuleLoader({mocks:{
  "@liveagent/app/shims/tauriCore":{invoke:async(command,args)=>{if(command==="gateway_status")return{online:true,agentId:"agent",sessionId:"stable"};calls.push(args.input);return{accepted:true,needsResync:false};}},
  "./client":{createKBrainClient:()=>({})},"./history":{summaryForSession:(session,id)=>({id,title:session.title,sessionId:session.id,createdAt:1,updatedAt:2,providerId:"fixture",model:"test",messageCount:2})},
  "./sessionSync":{createKBrainSessionSync:options=>{configuration=options;return{isHealthy:()=>healthy,restart:()=>{},acquire:()=>()=>{},getSnapshot:()=>undefined,waitForRevision:async()=>{}};}},"./sessionSyncState":{setKBrainMutationSync:()=>{}}
 }});
 const {kBrainSidebarSync}=loader.loadModule("src/lib/kbrain/sidebarSync.ts");const stop=kBrainSidebarSync.subscribe(()=>{});
 try{
  healthy=true;configuration.onSnapshot({epoch:"first",revision:"1",sessions:new Map(),workdirs:[]});configuration.onHealth(true);
  await until(()=>calls.some(c=>c.kind==="snapshot"));await tick();
  const previous=calls.find(c=>c.kind==="snapshot").generation;
  configuration.onHealth(false);configuration.onSnapshot({epoch:"replacement",revision:"0",sessions:new Map(),workdirs:[]});configuration.onHealth(true);
  await until(()=>calls.filter(c=>c.kind==="snapshot").length>=2);
  const current=calls.filter(c=>c.kind==="snapshot").at(-1);
  assert.notEqual(current.generation,previous);assert.equal(current.deliverySeq,0);
 }finally{stop();}
});

test("native publication always supplies required summary booleans and messageCount",async()=>{
 let configuration;let healthy=false;const published=[];
 const loader=createTsModuleLoader({mocks:{
 "@liveagent/app/shims/tauriCore":{invoke:async(command,args)=>{if(command==="gateway_status")return{online:true,agentId:"agent",sessionId:"session"};published.push(args.input);return{accepted:true,needsResync:false};}},
 "./client":{createKBrainClient:()=>({})},"./history":{summaryForSession:(s,id)=>({id,title:s.title,sessionId:s.id,createdAt:1,updatedAt:2,providerId:"fixture",model:"test"})},
 "./sessionSync":{createKBrainSessionSync:options=>{configuration=options;return{isHealthy:()=>healthy,restart:()=>{},acquire:()=>()=>{},getSnapshot:()=>undefined,waitForRevision:async()=>{}};}},"./sessionSyncState":{setKBrainMutationSync:()=>{}}
 }});
 const {kBrainSidebarSync}=loader.loadModule("src/lib/kbrain/sidebarSync.ts");const stop=kBrainSidebarSync.subscribe(()=>{});
 try{healthy=true;configuration.onSnapshot({epoch:"e",revision:"0",sessions:new Map([["backend",{id:"backend",title:"unflagged"}]]),workdirs:[]});configuration.onHealth(true);await until(()=>published.some(p=>p.kind==="snapshot"));const item=published.find(p=>p.kind==="snapshot").conversations[0];assert.equal(item.isPinned,false);assert.equal(item.isShared,false);assert.equal(item.messageCount,0);}finally{stop();}
});
