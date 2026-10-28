import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { createKBrainSessionSync, sessionSyncRevision } = createTsModuleLoader().loadModule("src/lib/kbrain/sessionSync.ts");
const session = (id, title = id) => ({ id, title, model: { provider: "fixture", model: "test" }, created_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:01Z", message_count: 2, cwd: "/project" });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) { for (let i=0;i<200;i++) { if(predicate()) return; await tick(); } throw new Error("condition timed out"); }

test("revision parser preserves uint64 and rejects unsafe wire values", () => {
 assert.equal(sessionSyncRevision("9007199254740993"), 9007199254740993n);
 for (const value of [1, "-1", "01", "18446744073709551616", null]) assert.throws(() => sessionSyncRevision(value));
});

test("HTTP snapshot keeps fixed R and drains >500 changes using next_since, never head", async (t) => {
 const calls=[]; let polls=0; let disposed=false;
 const server=createServer((req,res)=>{
  const url=new URL(req.url,"http://fixture"); calls.push(url.pathname+url.search);
  const send=value=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(value));};
  if(url.pathname==="/health") return send({session_changes:2});
  if(url.pathname==="/snapshot") return send({epoch:"one",revision:"0",snapshot_id:"fixed",total_count:1,expires_in_seconds:60,workdirs:[]});
  if(url.pathname==="/page") return send({epoch:"one",revision:"0",snapshot_id:"fixed",total_count:1,sessions:[session("initial")],next_offset:null});
  if(url.pathname==="/release") return send({ok:true});
  if(url.pathname==="/changes") {
   const since=Number(url.searchParams.get("since"));
  if(since<1201) {const end=Math.min(1201,since+500); return send({epoch:"one",head_revision:"1201",next_since:String(end),reset:false,more:end<1201,changes:Array.from({length:end-since},(_,i)=>({id:`s${since+i+1}`,revision:String(since+i+1),kind:"upsert",listed:true,session:session(`s${since+i+1}`)}))});}
   polls++; req.on("close",()=>{disposed=true;}); return;
  }
  res.statusCode=404;res.end();
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const get=async(path,signal)=>{const response=await fetch(base+path,{signal});return response.json();};
 const snapshots=[];const health=[];
 const sync=createKBrainSessionSync({client:{getCapabilities:s=>get("/health",s),createSessionSnapshot:s=>get("/snapshot",s),getSessionSnapshot:(_,offset,s)=>get(`/page?offset=${offset}`,s),releaseSessionSnapshot:()=>get("/release"),getSessionChanges:(p,s)=>get(`/changes?since=${p.since}&wait=${p.wait}`,s)},onSnapshot:s=>snapshots.push(s),onHealth:h=>health.push(h),retryMs:5});
 t.after(()=>{server.closeAllConnections();server.close();});
 const release=sync.acquire();const releaseSecond=sync.acquire();
 await until(()=>sync.isHealthy() && polls>0);
 assert.equal(snapshots[0].sessions.size,1202);
 assert.equal(snapshots[0].revision,"1201");
 assert.ok(calls.includes("/changes?since=500&wait=0"));
 assert.ok(calls.includes("/changes?since=1000&wait=0"));
 assert.equal(calls.filter(p=>p==="/snapshot").length,1);
 assert.equal(snapshots[0].workdirs[0].count,1202);
 release(); assert.equal(sync.isHealthy(),true);
 releaseSecond(); await until(()=>disposed);
 assert.equal(sync.isHealthy(),false); assert.equal(sync.getSnapshot(),undefined);
});

test("disposal while an uncancellable old snapshot resolves cannot publish stale state",async()=>{
 let finish;const snapshots=[];
 const sync=createKBrainSessionSync({client:{getCapabilities:async()=>({session_changes:2}),createSessionSnapshot:()=>new Promise(resolve=>finish=resolve),getSessionSnapshot:async()=>({epoch:"old",revision:"0",snapshot_id:"old",total_count:0,sessions:[],next_offset:null}),releaseSessionSnapshot:async()=>{},getSessionChanges:async()=>({epoch:"old",head_revision:"0",next_since:"0",reset:false,more:false,changes:[]})},onSnapshot:s=>snapshots.push(s),onHealth:()=>{}});
 const stop=sync.acquire();await until(()=>finish);stop();finish({epoch:"old",revision:"0",snapshot_id:"old",total_count:0});await tick();assert.equal(snapshots.length,0);
});

test("legacy capability leaves polling available without calling incomplete v2 routes",async()=>{
 let snapshots=0;let capabilities=0;
 const sync=createKBrainSessionSync({client:{getCapabilities:async()=>{capabilities++;return{session_changes:1};},createSessionSnapshot:async()=>{snapshots++;throw new Error("must not call");}},onSnapshot:()=>assert.fail("legacy published"),onHealth:()=>{},legacyProbeMs:10000});
 const stop=sync.acquire();await until(()=>capabilities===1);assert.equal(sync.isHealthy(),false);assert.equal(snapshots,0);stop();
});

for(const malformed of [
 {head_revision:"10",next_since:"10",changes:[],more:false},
 {head_revision:"2",next_since:"2",changes:[{id:"one",revision:"1",kind:"upsert",listed:true,session:session("one")}],more:false},
 {head_revision:"2",next_since:"2",changes:[{id:"two",revision:"2",kind:"delete"},{id:"one",revision:"1",kind:"delete"}],more:false},
]) test(`invalid cursor batch cannot replace the previous view (${JSON.stringify(malformed)})`,async()=>{
 const snapshots=[];const errors=[];
 const sync=createKBrainSessionSync({client:{getCapabilities:async()=>({session_changes:2}),createSessionSnapshot:async()=>({epoch:"test",revision:"0",snapshot_id:"test",total_count:0}),getSessionSnapshot:async()=>({epoch:"test",revision:"0",snapshot_id:"test",total_count:0,sessions:[],next_offset:null}),releaseSessionSnapshot:async()=>{},getSessionChanges:async()=>({epoch:"test",reset:false,...malformed})},onSnapshot:s=>snapshots.push(s),onHealth:(h,error)=>{if(error)errors.push(error);},retryMs:10000});
 const stop=sync.acquire();await until(()=>errors.length>0);assert.equal(snapshots.length,0);assert.equal(sync.isHealthy(),false);stop();
});

test("mutation confirmation does not resurrect an already removed remote session", async () => {
 const loader=createTsModuleLoader();const state=loader.loadModule("src/lib/kbrain/sessionSyncState.ts");
 let reconciles=0;
 state.setKBrainMutationSync({isHealthy:()=>true,confirm:async()=>undefined,reconcile:()=>reconciles++});
 await assert.rejects(state.confirmKBrainMutation("deleted",{sync_epoch:"e",sync_revision:"2"},true),/removed/);
 assert.equal(await state.confirmKBrainMutation("deleted",{sync_epoch:"e",sync_revision:"2"}),undefined);
 await assert.rejects(state.confirmKBrainMutation("one",{},true),/missing/);
 assert.equal(reconciles,1);state.setKBrainMutationSync(undefined);
});

test("live batches use incremental callbacks and keep the initial snapshot immutable", async (t) => {
  const snapshots = [];
  const increments = [];
  let nextPoll;
  const empty = { epoch: "e", head_revision: "0", next_since: "0", reset: false, more: false, changes: [] };
  const sync = createKBrainSessionSync({
    client: {
      getCapabilities: async () => ({ session_changes: 2 }),
      createSessionSnapshot: async () => ({ epoch: "e", revision: "0", snapshot_id: "s", total_count: 248 }),
      getSessionSnapshot: async () => ({ epoch: "e", revision: "0", snapshot_id: "s", total_count: 248, sessions: Array.from({ length: 248 }, (_, index) => session(`s${index}`)), next_offset: null }),
      releaseSessionSnapshot: async () => {},
      getSessionChanges: async (params, signal) => {
        if (params.wait === 0) return empty;
        return new Promise((resolve, reject) => {
          nextPoll = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onChanges: (change) => increments.push(change),
    onHealth: () => {},
  });
  const stop = sync.acquire();
  t.after(stop);
  await until(() => sync.isHealthy() && nextPoll);
  nextPoll({
    ...empty,
    head_revision: "2",
    next_since: "2",
    changes: [
      { kind: "upsert", id: "s0", revision: "1", listed: true, session: session("s0", "renamed") },
      { kind: "delete", id: "s0", revision: "2" },
    ],
  });
  await until(() => increments.length === 1);
  assert.equal(snapshots.length, 1, "one live row must not rebuild the full baseline");
  assert.equal(increments[0].changes.length, 2);
  assert.equal(sync.getSnapshot().sessions.has("s0"), false);
  assert.equal(snapshots[0].sessions.get("s0").title, "s0", "older snapshot cannot change behind its consumer");
  assert.equal(sync.getSnapshot().sessions.get("s247"), snapshots[0].sessions.get("s247"));
  assert.equal(snapshots.length, 1);
  assert.equal(sync.getSnapshot().sessions.size, 247);
  assert.equal(increments[0].workdirs[0].count, 247);
});
