import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function harness() {
  const calls = [];
  const loader = createTsModuleLoader({ mocks: { "@tauri-apps/api/core": { async invoke(command, args) {
    calls.push({command,args});
    if (command === "planning_mutate") return { status: "conflict", item: { revision: 2 } };
    return { timeZone:"UTC", todos: [{id:"t",title:"task",notes:"",tagIds:["tag"],status:"open",priority:"high",dueDate:"2000-01-01"},{id:"x",title:"other",notes:"",parentId:"t"},{id:"nested",title:"nested",notes:"",parentId:"x"}],events:[{id:"e",todoId:"t",tagIds:["tag"]},{id:"z",todoId:"x"}],reminders:[{targetType:"todo",targetId:"t"},{targetType:"event",targetId:"z"}],sources:[],groups:[],tags:[{id:"tag"}] };
  } } } });
  return { bundle: loader.loadModule("src/lib/tools/planningTools.ts").createPlanningTools(), calls };
}
test("Planning tools read related tasks and filter context", async () => {
  const { bundle } = harness();
  const result = await bundle.executeToolCall({id:"q",name:"PlanningQuery",arguments:{todoId:"t"}});
  assert.equal(result.isError,false);
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value.todos.map(t=>t.id),["t"]);assert.deepEqual(value.events.map(e=>e.id),["e"]);
  assert.equal(value.reminders.length,1);assert.equal(value.projects,undefined);
});
test("Planning tools preserve revision conflicts, support classification and reject source side effects", async () => {
  const { bundle, calls } = harness();
  const result = await bundle.executeToolCall({id:"m",name:"PlanningMutate",arguments:{requestId:"stable-123",action:"tag.update",id:"tag",expectedRevision:1,data:{name:"renamed"}}});
  assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).status,"conflict");
  assert.equal(calls[0].args.input.expectedRevision,1);
  const denied=await bundle.executeToolCall({id:"m2",name:"PlanningMutate",arguments:{action:"source.create",data:{}}});
  assert.equal(denied.isError,true);assert.equal(calls.length,1);
  assert.equal(bundle.metadataByName.get("PlanningQuery").isReadOnly,true);
  assert.equal(bundle.metadataByName.get("PlanningMutate").isReadOnly,false);
});


test("Agent tools read recursive tasks and expose scheduling, ordering, import and timezone mutations", async () => {
 const {bundle,calls}=harness();
 const result=await bundle.executeToolCall({id:"tree",name:"PlanningQuery",arguments:{todoId:"t",includeDescendants:true}});
 assert.deepEqual(JSON.parse(result.content[0].text).todos.map(t=>t.id).sort(),["nested","t","x"]);
 const children=await bundle.executeToolCall({id:"children",name:"PlanningQuery",arguments:{parentId:"x"}});
 assert.deepEqual(JSON.parse(children.content[0].text).todos.map(t=>t.id),["nested"]);
 for (const action of ["todo.move","todo.schedule","calendar.import","timezone.set","event.restoreException"]) {
  const before=calls.length;
  const response=await bundle.executeToolCall({id:action,name:"PlanningMutate",arguments:{action,requestId:`test-${action}`,id:"t",expectedRevision:7,data:{parentId:null,beforeId:"x",relativeRevision:4}}});
  assert.equal(calls.length,before+1);assert.equal(calls.at(-1).args.input.action,action);assert.equal(response.isError,true); // Preserve backend conflict handling.
 }
 const before=calls.length;
 await bundle.executeToolCall({id:"invalid",name:"PlanningMutate",arguments:{action:"calendar.schedule",data:{}}});
 assert.equal(calls.length,before);
});

test("Planning query mirrors the UI's starred list and overdue rollup", async () => {
 const {bundle}=harness();
 const starred=await bundle.executeToolCall({id:"s",name:"PlanningQuery",arguments:{starred:true}});
 assert.deepEqual(JSON.parse(starred.content[0].text).todos.map(t=>t.id),["t"]);
 const overdue=await bundle.executeToolCall({id:"o",name:"PlanningQuery",arguments:{overdue:true}});
 const value=JSON.parse(overdue.content[0].text);
 assert.deepEqual(value.todos.map(t=>t.id),["t"]);assert.deepEqual(value.events.map(e=>e.id),["e"]);
});
