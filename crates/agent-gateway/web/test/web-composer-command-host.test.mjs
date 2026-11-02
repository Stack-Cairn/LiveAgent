import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";
const loader=createWebModuleLoader();
const {createWebComposerCommandHost}=loader.loadModule("src/app/webComposerCommandHost.ts");
function fixture(){const calls=[];const host=createWebComposerCommandHost({t:key=>key,client:{listCommands:async workdir=>({commands:[{name:"goal",description:workdir,kind:"action",source:"builtin",argumentHint:"<goal>"}]}),clearGoal:async id=>calls.push(["clear",id]),listLoops:async()=>({loops:[]}),createLoop:async input=>{calls.push(input);return {loops:[{id:"loop-1",...input,enabled:true}]};},cancelLoop:async(id,loopId)=>calls.push([id,loopId])},getConversationId:()=>"local-1",getWorkdir:()=>"/repo",getRuntimeControls:()=>({planModeEnabled:false}),sendTurn:(...args)=>calls.push(args)});return {host,calls};}
test("WebUI gets desktop catalog through gateway",async()=>{const f=fixture();assert.equal((await f.host.listCommands())[0].description,"/repo");});
test("WebUI loops delegate elapsed scheduling to the backend",async()=>{const f=fixture();await f.host.loops.create("90m","check");assert.deepEqual(f.calls[0],{conversationId:"local-1",interval:"90m",prompt:"check"});});
test("WebUI plan mode applies to submission defaults",()=>{const f=fixture();f.host.sendTurn("/plan task",undefined,{planMode:true});assert.equal(f.calls[0][2].planModeEnabled,true);});
test("background host excludes unavailable model and compaction",()=>{const f=fixture();assert.equal(f.host.compact,undefined);assert.equal(f.host.selectModel,undefined);});
