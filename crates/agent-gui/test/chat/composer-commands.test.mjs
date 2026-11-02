import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
const env = await createDomTestEnv();
const { buildComposerCommands, parseComposerCommandDraft, runComposerCommand, filterComposerCommands, normalizeLoopInterval } = env.loadModule("@liveagent/ui/lib/chat/composerCommands.ts");
const catalog = [
  ...["goal", "loop", "plan", "model", "compact", "rewind"].map(name => ({name,kind:"action",source:"builtin",description:name})),
  {name:"init",kind:"prompt",source:"builtin",description:"init"},
  {name:"deploy",kind:"prompt",source:"user",description:"Deploy"},
];
function fixture() {
  const calls=[];
  const host={sendTurn:async (...args)=>calls.push(["send",...args]),clearGoal:()=>calls.push(["clear"]),enablePlanMode:()=>calls.push(["plan"]),openModelPicker:()=>calls.push(["picker"]),selectModel:name=>calls.push(["model",name]),compact:()=>calls.push(["compact"]),rewindLastTurn:()=>calls.push(["rewind"]),loops:{create:async(interval,prompt)=>({id:"loop-abc123",interval,prompt,enabled:true}),list:async()=>[],cancel:async id=>calls.push(["cancel",id])},recordCommandResult:async (...args)=>calls.push(["record",...args])};
  const skills=[{name:"reviewer",description:"Review",skillFile:"/skills/reviewer/SKILL.md",baseDir:"/skills/reviewer"}];
  const commands=buildComposerCommands({host,catalog,skills});
  const effects={host,t:key=>key,consumeDraft:()=>calls.push(["consume"]),showPanel:panel=>calls.push(["panel",panel])};
  return {host,calls,commands,async run(text){const parsed=parseComposerCommandDraft(text,commands);assert.ok(parsed);await runComposerCommand(parsed,effects);}};
}
test("desktop catalog gates unsupported actions and keeps skills",()=>{
 const f=fixture();assert.deepEqual(f.commands.map(c=>c.name),["goal","loop","plan","model","compact","rewind","init","deploy","reviewer"]);
 assert.equal(parseComposerCommandDraft("/new",f.commands),null);
 assert.equal(parseComposerCommandDraft("/usr/bin",f.commands),null);
 assert.deepEqual(filterComposerCommands(f.commands,"skill:rev",30).map(c=>c.name),["reviewer"]);
});
test("plan preserves command text and applies only one submission",async()=>{
 const f=fixture();await f.run("/plan write tests");assert.deepEqual(f.calls.at(-1),["send","/plan write tests",undefined,{planMode:true}]);
 f.calls.length=0;await f.run("/plan");assert.deepEqual(f.calls,[["consume"],["plan"]]);
});
test("goal dispatch preserves display text and structural goal",async()=>{
 const f=fixture();await f.run("/goal ship it");assert.deepEqual(f.calls.at(-1),["send","/goal ship it",{kind:"goal",action:"set",goal:"ship it"}]);
 await f.run("/goal resume");assert.deepEqual(f.calls.at(-1),["send","/goal resume",{kind:"goal",action:"resume"}]);
});
test("model without argument opens picker; name selects directly",async()=>{
 const f=fixture();await f.run("/model");assert.deepEqual(f.calls.at(-1),["picker"]);await f.run("/model Sonnet");assert.deepEqual(f.calls.at(-1),["model","Sonnet"]);
});
test("prompt commands are sent verbatim for backend expansion",async()=>{const f=fixture();await f.run('/deploy staging');assert.deepEqual(f.calls.at(-1),["send","/deploy staging",{kind:"prompt"}]);});
test("loop results go into conversation and invalid intervals do not mutate",async()=>{
 const f=fixture();await f.run("/loop 1m report time");assert.equal(f.calls.at(-1)[0],"record");assert.equal(f.calls.at(-1)[1],"/loop 1m report time");
 f.calls.length=0;await f.run("/loop 0s test");assert.equal(f.calls[0][0],"panel");assert.equal(f.calls[0][1].type,"error");
 for (const interval of ["30s", "90s", "90m", "25h", "7d"]) assert.equal(normalizeLoopInterval(interval), interval);
 for (const interval of ["0m", "8d", "1.5h", "1w"]) assert.equal(normalizeLoopInterval(interval), null);
});
test("builtins localize while author descriptions remain unchanged",()=>{
 const f=fixture();const list=buildComposerCommands({host:f.host,catalog,skills:[],t:key=>key==='chat.commands.builtin.goal.description'?'持续执行目标':key});assert.equal(list[0].description,'持续执行目标');assert.equal(list.at(-1).description,'Deploy');
});
const { extractSkillMentionNamesFromText } = env.loadModule("@liveagent/ui/lib/skills/index.ts");
const draftOf=(segments)=>{const text=segments.map(s=>s.type==="text"?s.text:s.type==="largePaste"?s.paste.text:"").join("");return {segments,text,textWithoutLargePastes:text,largePastes:segments.filter(s=>s.type==="largePaste").map(s=>s.paste),skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],conversationMentions:segments.filter(s=>s.type==="conversationMention").map(s=>s.conversation),codeMentions:[],isEmpty:false};};
async function runWith(f,text,extra={}){const parsed=parseComposerCommandDraft(text,f.commands);assert.ok(parsed);const restored=[];await runComposerCommand(parsed,{host:f.host,t:key=>key,consumeDraft:()=>f.calls.push(["consume"]),restoreDraft:()=>restored.push(true),showPanel:panel=>f.calls.push(["panel",panel]),...extra});return restored.length;}
test("goal subcommands are case-insensitive and pause uses the host",async()=>{
 const f=fixture();f.host.pauseGoal=()=>f.calls.push(["pause"]);
 await f.run("/goal Clear");assert.ok(f.calls.some(c=>c[0]==="clear"));assert.ok(!f.calls.some(c=>c[0]==="send"));
 f.calls.length=0;await f.run("/goal PAUSE");assert.deepEqual(f.calls.slice(0,2),[["consume"],["pause"]]);
 f.calls.length=0;await f.run("/goal Resume");assert.deepEqual(f.calls.at(-1),["send","/goal Resume",{kind:"goal",action:"resume"}]);
});
test("goal pause without host support errors instead of replacing the goal",async()=>{
 const f=fixture();const restored=await runWith(f,"/goal pause");
 assert.ok(!f.calls.some(c=>c[0]==="send"));assert.equal(f.calls.at(-1)[1].type,"error");assert.equal(restored,1);
});
test("a rejected send restores the draft and reports the error",async()=>{
 const f=fixture();f.host.sendTurn=async()=>{throw new Error("chat.commands.busy");};
 const restored=await runWith(f,"/plan write tests");assert.equal(restored,1);
 assert.equal(f.calls.at(-1)[0],"panel");assert.match(f.calls.at(-1)[1].message,/chat\.commands\.busy/);
});
test("prompt commands use the catalog spelling of the template name",()=>{
 const f=fixture();const commands=buildComposerCommands({host:f.host,catalog:[{name:"Deploy",kind:"prompt",source:"user",description:""}],skills:[]});
 assert.equal(parseComposerCommandDraft("/deploy staging",commands).text,"/Deploy staging");
});
test("structured draft context is carried by capable hosts and refused otherwise",async()=>{
 const conversation={type:"conversationMention",conversation:{id:"c2",title:"Other"}};
 const draft=draftOf([{type:"text",text:"/DEPLOY with "},conversation]);
 const f=fixture();const restored=await runWith(f,"/deploy with @Other",{draft});
 assert.equal(restored,1);assert.ok(!f.calls.some(c=>c[0]==="send"));assert.equal(f.calls.at(-1)[1].message,"chat.commands.contextUnsupported");assert.equal(f.calls.at(-1)[1].command,"deploy");
 const g=fixture();g.host.carriesComposerContext=true;await runWith(g,"/DEPLOY with @Other",{draft});
 const sent=g.calls.find(c=>c[0]==="send");assert.equal(sent[1],"/deploy with @Other");assert.equal(sent[3].draft.segments[0].text,"/deploy with ");assert.equal(sent[3].draft.segments[1],conversation);
 const h=fixture();h.host.carriesComposerContext=true;await runWith(h,"/goal ship it",{draft:draftOf([{type:"text",text:"/goal ship it "},conversation])});
 assert.ok(!h.calls.some(c=>c[0]==="send"));
});
test("skill references: /skill:name resolves and command names are skipped only as the leading token",()=>{
 assert.deepEqual(extractSkillMentionNamesFromText("/skill:foo do it"),["foo"]);
 assert.deepEqual(extractSkillMentionNamesFromText("/plan use /plan skill",["plan"]),["plan"]);
 assert.deepEqual(extractSkillMentionNamesFromText("  /plan task",["plan"]),[]);
});

test.after(()=>env.cleanup());
