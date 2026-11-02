import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const settings = { revision: 1, connections: [{ id: "ic_test", name: "Service", vendor: "openai", enabled: true, maxConcurrent: 1, credentialConfigured: false, binding: { kind: "independent", baseUrl: "https://api.openai.com/v1", authKind: "bearer", secretRefs: {} } }], targets: [] };

test("input target settings expose targets without separate credential configuration", async () => {
  const env = await createDomTestEnv();
  const { ImageSettings } = env.loadModule("@liveagent/ui/pages/settings/ImageSettings");
  const container = document.createElement("div"); const root = env.createRoot(container);
  try {
    await env.act(async () => root.render(env.React.createElement(ImageSettings, { client: { getSettings: async () => settings }, panel: "targets" })));
    const buttons = [...container.querySelectorAll("button")].map(b => b.textContent);
    assert.ok(buttons.includes("新增目标")); assert.ok(!buttons.includes("新增连接"));
    assert.equal(container.querySelector('input[type="password"]'), null);
    assert.match(container.textContent, /后端配置管理/);
    assert.doesNotMatch(container.textContent, /供应商设置/);
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});

test("empty image targets do not point to the removed provider settings option", async () => {
  const env = await createDomTestEnv();
  const { ImageSettings } = env.loadModule("@liveagent/ui/pages/settings/ImageSettings");
  const container = document.createElement("div");
  const root = env.createRoot(container);
  try {
    await env.act(async () => root.render(env.React.createElement(ImageSettings, {
      client: { getSettings: async () => ({ revision: 1, connections: [], targets: [] }) },
      panel: "targets",
    })));
    assert.match(container.textContent, /当前没有可用的图像连接，请先配置后端图像连接/);
    assert.doesNotMatch(container.textContent, /供应商设置|图像服务/);
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});

test("input target dialog protects an unsaved model draft before closing", async()=>{
 const env=await createDomTestEnv();const {ImageTargetSettings}=env.loadModule("@liveagent/ui/features/image-studio/ImageTargetSettings");
 const container=document.createElement("div");document.body.append(container);const root=env.createRoot(container);
 const button=label=>Array.from(document.querySelectorAll("button")).find(b=>b.textContent===label);
 try {
  await env.act(async()=>root.render(env.React.createElement(ImageTargetSettings,{client:{getSettings:async()=>settings}})));
  await env.act(async()=>button("目标设置").click());assert.ok(document.querySelector('[role="dialog"]'));
  await env.act(async()=>button("新增目标").click());
  window.confirm=()=>false;await env.act(async()=>button("关闭目标设置").click());assert.ok(document.querySelector('[role="dialog"]'));
  window.confirm=()=>true;await env.act(async()=>button("关闭目标设置").click());
  await new Promise(r=>setTimeout(r,200));assert.equal(document.querySelector('[role="dialog"]'),null);
 }finally{await env.act(async()=>root.unmount());env.cleanup();}
});
