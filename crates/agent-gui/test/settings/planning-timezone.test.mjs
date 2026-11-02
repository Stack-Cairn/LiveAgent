import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("shared timezone picker reads remote state, uses revision checks and preserves save errors", async () => {
  let env, picker, listener;
  let state={preference:"Asia/Shanghai",timeZone:"Asia/Shanghai",systemTimeZone:"Asia/Shanghai",revision:1};
  let reject=false;
  const calls=[];
  const backend={scope:()=>"same-backend",subscribe:fn=>{listener=fn;return ()=>{};},call:async(action,input)=>{
    calls.push({action,input});
    if(action==="timezone") {
      if(reject)throw Error("E:conflict");
      assert.equal(input.expectedRevision,state.revision);
      state={...state,preference:input.preference,revision:state.revision+1};
    }
    return {...state};
  }};
  env=await createDomTestEnv({mocks:{
    "@liveagent/app/lib/planning/backend":{backend},
    [new URL("../../../agent-ui/src/components/settings/TimeZonePicker.tsx", import.meta.url).pathname]:{TimeZonePicker:props=>{picker=props;return env.React.createElement("span",null,props.value);}},
    [new URL("../../../agent-ui/src/components/ui/button.tsx", import.meta.url).pathname]:{Button:props=>env.React.createElement("button",{onClick:props.onClick},props.children)},
    [new URL("../../../agent-ui/src/lib/planning/i18n.ts", import.meta.url).pathname]:{localizePlanningError:e=>String(e)},
    [new URL("../../../agent-ui/src/i18n/index.ts", import.meta.url).pathname]:{useLocale:()=>({t:k=>k,locale:"en-US"})},
  }});
  const {PlanningTimeZoneSetting}=env.loadModule("@liveagent/ui/pages/settings/PlanningTimeZoneSetting.tsx");
  const host=document.createElement("div");document.body.append(host);const root=env.createRoot(host);
  try {
    await env.act(async()=>root.render(env.React.createElement(PlanningTimeZoneSetting)));
    assert.equal(picker.value,"Asia/Shanghai");
    state={...state,preference:"Europe/London",revision:2};await env.act(async()=>listener());assert.equal(picker.value,"Europe/London");
    await env.act(async()=>picker.onChange(""));assert.equal(picker.value,"");
    assert.deepEqual(calls.find(c=>c.action==="timezone").input,{preference:"",expectedRevision:2});
    reject=true;await env.act(async()=>picker.onChange("Asia/Tokyo"));assert(host.querySelector('[role="alert"]'));
    await env.act(async()=>listener());assert(host.querySelector('[role="alert"]'),"polling must not hide failed save");
    reject=false;await env.act(async()=>picker.onChange("Asia/Tokyo"));assert.equal(picker.value,"Asia/Tokyo");assert.equal(host.querySelector('[role="alert"]'),null);
  } finally {await env.act(async()=>root.unmount());host.remove();env.cleanup();}
});
