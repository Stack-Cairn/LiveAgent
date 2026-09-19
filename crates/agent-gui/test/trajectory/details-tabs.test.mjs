import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("details tabs preserve record resets, lazy loading, retry and content lifetime", async () => {
  let env, serial=0;
  const latest={};
  const names=["Diff","Input","Options","Output","Overview","Raw","Rendered","Schema","Source","SystemPrompt","Timing","Tools","Usage"];
  const mocks={
    "../../../i18n/index":{useLocale:()=>({t:key=>key,locale:"en"})},
    "../../IconSet":{X:()=>null},
    "./DetailsResizeHandle":{DetailsResizeHandle:()=>null},
  };
  for(const name of names) mocks[`./tabs/${name}Tab`]={
    [`${name}Tab`]:props=>{
      const [instance]=env.React.useState(()=>++serial);
      latest[name]=props;
      return env.React.createElement("div",{"data-content":name,"data-instance":instance},props.sectionState.status);
    },
  };
  env=await createDomTestEnv({mocks});
  const {React,act,createRoot}=env;
  const {DetailsPanel}=env.loadModule("@liveagent/ui/components/trajectory/details/DetailsPanel.tsx");
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const pending=[];
  const loadSections=ids=>new Promise((resolve,reject)=>pending.push({ids,resolve,reject}));
  const record={recordId:"tool-1",kind:"tool",index:1};
  let props={record,header:{sections:["s1","s1"]},previousHeader:{sections:["s2"]},loadSections,
    onClose:()=>{},containerRef:{current:host},width:320,onWidthChange:()=>{}};
  const render=async patch=>{props={...props,...patch};await act(async()=>root.render(React.createElement(DetailsPanel,props)));};
  const tab=id=>[...host.querySelectorAll('[role="tab"]')].find(n=>n.textContent===`trajectory.details.tab.${id}`);
  const select=async id=>act(async()=>tab(id).click());
  const content=()=>host.querySelector('[data-content]');
  try {
    await render({});assert.equal(content().dataset.content,"Overview");assert.equal(pending.length,0);
    const initial=content().dataset.instance;
    await render({width:360});assert.equal(content().dataset.instance,initial);
    await select("overview");assert.equal(content().dataset.instance,initial);
    await select("raw");assert.equal(content().dataset.content,"Raw");assert.equal(pending.length,0);
    await select("overview");assert.notEqual(content().dataset.instance,initial);
    await select("schema");assert.equal(pending.length,1);assert.deepEqual(pending[0].ids,["s1","s2"]);
    assert.equal(content().textContent,"loading");assert.equal(host.querySelectorAll('[data-content]').length,1);
    await render({header:{sections:["s1","s1"]}});assert.equal(pending.length,1);
    await select("raw");assert.equal(content().textContent,"idle");
    await act(async()=>pending[0].resolve([{sectionId:"s1"}]));assert.equal(content().textContent,"idle");
    await select("schema");assert.equal(pending.length,2);
    await act(async()=>pending[1].reject(new Error("offline")));assert.equal(content().textContent,"failed");
    await act(async()=>latest.Schema.onRetrySections());assert.equal(pending.length,3);
    await act(async()=>pending[2].resolve([{sectionId:"s1"}]));assert.equal(content().textContent,"ready");
    assert.equal(latest.Schema.sectionById.has("s1"),true);
    await render({record:{...record,recordId:"tool-2"}});assert.equal(content().dataset.content,"Overview");
    await select("schema");assert.equal(pending.length,4);
    await render({record:{...record,recordId:"tool-2",kind:"message"}});
    assert.equal(content().dataset.content,"Overview");assert.equal(tab("schema"),undefined);
    await act(async()=>pending[3].resolve([{sectionId:"old"}]));assert.equal(content().textContent,"idle");
    await render({record:null});assert.equal(host.querySelector('[role="tablist"]'),null);assert.equal(content(),null);
    const system={recordId:"system-1",kind:"system",index:2,headerChange:"initial"};
    await render({record:system});assert.equal(content().dataset.content,"SystemPrompt");
    await select("systemPrompt");
    await render({record:{...system,headerChange:"updated"}});
    assert.equal(content().dataset.content,"SystemPrompt");
    await render({record});assert.equal(content().dataset.content,"Overview");
    await select("schema");
    await act(async()=>root.unmount());
    await act(async()=>pending.at(-1).resolve([{sectionId:"late"}]));
    assert.equal(host.children.length,0);
  } finally {await act(async()=>root.unmount());host.remove();env.cleanup();}
});
