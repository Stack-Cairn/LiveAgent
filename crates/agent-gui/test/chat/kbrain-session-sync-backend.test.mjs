import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(predicate){for(let i=0;i<500;i++){if(predicate())return;await tick();}throw new Error("sync condition timed out");}

test("desktop coordinator converges against real K-brain HTTP mutations, deletion and reconnect",{timeout:45_000},async(t)=>{
 const root=await mkdtemp(path.join(tmpdir(),"la-session-sync-http-"));
 const config=path.join(root,"config.json");
 await writeFile(config,JSON.stringify({defaultModel:"fixture-model",providers:{fixture:{api:"openai-completions",apiKey:"fixture-key",baseUrl:"http://127.0.0.1:1/v1",models:[{id:"fixture-model",contextWindow:32768,maxTokens:256}]}}}));
 const child=spawn(await getKBrainBinary(),["backend","-listen","127.0.0.1:0","-token","sync-fixture","-config",config,"-data-dir",root],{env:{...process.env,LIVEAGENT_HOME:root,K_BRAIN_HOME:""},stdio:["ignore","pipe","pipe"]});
 let logs="";child.stderr.on("data",data=>logs+=data);
 const baseUrl=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`backend readiness: ${logs}`)),15000);child.once("exit",code=>{clearTimeout(timer);reject(new Error(`backend exit ${code}: ${logs}`));});child.stdout.on("data",data=>{logs+=data;const match=logs.match(/k-brain backend listening on (http:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
 t.after(async()=>{if(child.exitCode===null){const exited=once(child,"exit");child.kill();await exited;}});
 const loader=createTsModuleLoader();
 const {createKBrainClient}=loader.loadModule("src/lib/kbrain/client.ts");
 const {createKBrainSessionSync}=loader.loadModule("src/lib/kbrain/sessionSync.ts");
 const client=createKBrainClient({baseUrl,token:"sync-fixture"});
 const capabilities=await client.getCapabilities();
 if(typeof capabilities.session_changes!=="number" || capabilities.session_changes<2){t.skip("requires a session_changes v2 development build; set LIVEAGENT_KBRAIN_BINARY");return;}
 const initial=await client.createSession({cwd:root,model:{provider:"fixture",model:"fixture-model"}});
 await client.recordCommandNote(initial.id,"/fixture","ready");
 const seen=[];const sync=createKBrainSessionSync({client,onSnapshot:value=>seen.push(value),onHealth:()=>{},retryMs:10});
 const stop=sync.acquire();t.after(stop);
 await until(()=>sync.isHealthy());
 assert.ok(sync.getSnapshot().sessions.has(initial.id));
 const renamed=await client.updateSession(initial.id,{title:"new remote title",pinned:true});
 assert.equal(typeof renamed.sync_revision,"string");
 await sync.waitForRevision(renamed.sync_epoch,renamed.sync_revision);
 assert.equal(sync.getSnapshot().sessions.get(initial.id).title,"new remote title");
 assert.equal(sync.getSnapshot().sessions.get(initial.id).pinned,true);
 const created=await client.createSession({cwd:root,model:{provider:"fixture",model:"fixture-model"}});
 await client.recordCommandNote(created.id,"/fixture","second");
 await until(()=>sync.getSnapshot().sessions.has(created.id));
 const removed=await client.deleteSession(initial.id);
 assert.equal(removed.ok,true);
 await sync.waitForRevision(removed.sync_epoch,removed.sync_revision);
 assert.equal(sync.getSnapshot().sessions.has(initial.id),false);
 sync.restart();await until(()=>sync.isHealthy());
 assert.deepEqual([...sync.getSnapshot().sessions.keys()],[created.id]);
 assert.ok(seen.length>=4);
});
