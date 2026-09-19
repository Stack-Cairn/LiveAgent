import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("conversation tabs keep controlled selection, one list and manual activation", async () => {
  let env;
  const Icon=props=>env.React.createElement("svg",props);
  env=await createDomTestEnv({mocks:{
    "../../i18n/index":{useLocale:()=>({t:key=>key})},
    "../IconSet":{MessageSquareText:Icon,Waypoints:Icon},
    "@liveagent/ui/components/IconSet":{MessageSquareText:Icon,Waypoints:Icon},
  }});
  const {React,act,createRoot}=env;
  const {ConversationViewTabs}=env.loadModule("@liveagent/ui/components/chat/ConversationViewTabs.tsx");
  const host=document.createElement("div");document.body.append(host);
  const root=createRoot(host),changes=[];
  const render=async active=>act(async()=>root.render(React.createElement(ConversationViewTabs,{
    active,className:"test-custom",onChange:value=>changes.push(value),
  })));
  try {
    await render("conversation");
    const list=host.firstElementChild;
    assert.equal(list.getAttribute("role"),"tablist");
    assert.ok(list.classList.contains("test-custom"));
    assert.equal(host.querySelectorAll('[role="tablist"]').length,1);
    let tabs=[...host.querySelectorAll('[role="tab"]')];
    assert.equal(tabs.length,2);assert.ok(tabs.every(tab=>tab.parentElement===list));
    assert.ok(tabs.every(tab=>tab.tagName==="BUTTON" && !tab.hasAttribute("aria-controls")));
    await act(async()=>tabs[0].click());assert.deepEqual(changes,[]);
    await act(async()=>tabs[1].click());assert.deepEqual(changes,["trajectory"]);
    assert.equal(tabs[0].getAttribute("aria-selected"),"true");
    await render("trajectory");
    tabs=[...host.querySelectorAll('[role="tab"]')];
    assert.equal(tabs[1].getAttribute("aria-selected"),"true");
    await act(async()=>tabs[1].click());assert.deepEqual(changes,["trajectory"]);
    await act(async()=>tabs[1].focus());
    await act(async()=>tabs[1].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",code:"ArrowLeft",bubbles:true,cancelable:true})));
    assert.equal(document.activeElement,tabs[0]);
    assert.equal(tabs[1].getAttribute("aria-selected"),"true");
    assert.deepEqual(changes,["trajectory"]);
    await act(async()=>tabs[0].click());assert.deepEqual(changes,["trajectory","conversation"]);
    await render("conversation");
    assert.equal(tabs[0].getAttribute("aria-selected"),"true");
    assert.equal(host.querySelector('[role="tabpanel"]'),null);
  } finally {await act(async()=>root.unmount());host.remove();env.cleanup();}
});
