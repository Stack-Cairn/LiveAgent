import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("resource switches isolate card events and keep unisolated activation single", async () => {
  const env = await createDomTestEnv();
  const {React, act, createRoot} = env;
  const {ResourceActivationSwitch} = env.loadModule("@liveagent/ui/components/resources/ResourceActivationSwitch.tsx");
  const host=document.createElement("div");document.body.append(host);
  const root=createRoot(host);
  try {
    for(const isolated of [true,false]) {
      const changes=[], events=[];
      await act(async()=>root.render(React.createElement("article",{
        onClick:e=>events.push("click"),onPointerDown:()=>events.push("pointerdown"),
        onMouseDown:()=>events.push("mousedown"),onKeyDown:()=>events.push("keydown"),
      },React.createElement(ResourceActivationSwitch,{
        checked:false,label:"Resource",stopPropagation:isolated,onCheckedChange:value=>changes.push(value),
      }))));
      const button=host.querySelector('button[role="switch"]');
      for(const [type,Event] of [["pointerdown",window.MouseEvent],["mousedown",window.MouseEvent],["keydown",window.KeyboardEvent]]) {
        await act(async()=>button.dispatchEvent(new Event(type,{bubbles:true,key:"ArrowRight"})));
      }
      await act(async()=>button.click());
      assert.deepEqual(changes,[true]);
      assert.equal(button.getAttribute("aria-checked"),"false");
      assert.deepEqual(events,isolated?[]:["pointerdown","mousedown","keydown","click"]);
    }
  } finally {await act(async()=>root.unmount());host.remove();env.cleanup();}
});


test("resource switch sizes, labels and disabled state survive card composition", async () => {
  const env=await createDomTestEnv();const {React,act,createRoot}=env;
  const {ResourceActivationSwitch}=env.loadModule("@liveagent/ui/components/resources/ResourceActivationSwitch.tsx");
  const {ResourceSelectionCard}=env.loadModule("@liveagent/ui/components/resources/ResourceSelectionCard.tsx");
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  try {
    let calls=0;
    for(const compact of [false,true]) for(const checked of [false,true]) {
      await act(async()=>root.render(React.createElement(ResourceActivationSwitch,{
        compact,checked,disabled:true,label:"Locked resource",onCheckedChange:()=>calls++,
      })));
      const button=host.querySelector('button[role="switch"]');
      assert.equal(button.disabled,true);assert.equal(button.title,"Locked resource");
      assert.equal(button.getAttribute("aria-label"),"Locked resource");
      assert.equal(button.getAttribute("aria-checked"),String(checked));
      assert.ok(button.classList.contains(compact?"w-9":"w-11"));
      await act(async()=>button.click());assert.equal(calls,0);
    }
    const changes=[];
    await act(async()=>root.render(React.createElement(ResourceSelectionCard,{
      title:"Resource card",description:"description",icon:()=>null,checked:true,
      onCheckedChange:value=>changes.push(value),
    })));
    const button=host.querySelector('button[role="switch"]');
    await act(async()=>button.click());assert.deepEqual(changes,[false]);
    assert.equal(button.getAttribute("aria-checked"),"true");
  } finally {await act(async()=>root.unmount());host.remove();env.cleanup();}
});
