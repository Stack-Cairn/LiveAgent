import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function hookHarness() {
  let index = 0;
  const state = [];
  let pending;
  let previousDeps;
  let cleanup;
  const loader = createWebModuleLoader({ mocks: { react: {
    useState(initial) {
      const slot = index++;
      if (!(slot in state)) state[slot] = initial;
      return [state[slot], (value) => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }];
    },
    useEffect(effect, deps) {
      if (!previousDeps || deps.some((value, i) => value !== previousDeps[i])) {
        pending = effect;
        previousDeps = deps;
      }
    },
  } } });
  const { useWebImageStudioHost } = loader.loadModule("src/agent-ui-adapters/imageStudio.ts");
  return {
    render(...args) { index = 0; return useWebImageStudioHost(...args); },
    flush() { if (pending) { cleanup?.(); cleanup = pending(); pending = undefined; } },
    dispose() { cleanup?.(); },
  };
}
const identity = { ownerId: "verified-user", backendId: "selected", gatewayOrigin: "https://gateway.example", accessToken: "login-token" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function withBrowser(run) {
  const properties = ["window", "localStorage", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let storageReads = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: identity.gatewayOrigin } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { storageReads++; return { getItem: () => null, setItem() { assert.fail("unexpected draft write"); }, removeItem() {} }; } });
  try { await run(() => storageReads); }
  finally {
    for (const [key, descriptor] of properties) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("actual no-identity hook exposes no client and never reads owner storage/network", async () => {
  await withBrowser(async (storageReads) => {
    globalThis.fetch = async () => assert.fail("must not invent an image backend");
    const hook = hookHarness();
    let view = hook.render("login-token", undefined, "/workspace");
    hook.flush();
    view = hook.render("login-token", undefined, "/workspace");
    assert.equal(view.host, undefined);
    assert.match(view.unavailable, /IMAGE_IDENTITY_UNAVAILABLE/);
    assert.equal(storageReads(), 0);
    hook.dispose();
  });
});

test("real 503 health response stays visible with manual retry and no available client", async () => {
  await withBrowser(async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      assert.equal(new URL(url).pathname, "/api/image/health");
      assert.equal(new URL(url).searchParams.get("backendId"), "selected");
      return Response.json({ version: "kbrain.image.v1", error: { code: "IMAGE_IDENTITY_UNAVAILABLE", message: "Not configured", requestId: "req-503", retryable: false } }, { status: 503 });
    };
    const hook = hookHarness();
    hook.render("login-token", identity, "/workspace");
    hook.flush();
    await tick();
    let view = hook.render("login-token", identity, "/workspace");
    assert.equal(view.host, undefined);
    assert.match(view.unavailable, /HTTP 503/);
    assert.match(view.unavailable, /IMAGE_IDENTITY_UNAVAILABLE/);
    assert.equal(calls, 1);
    view.retry();
    hook.render("login-token", identity, "/workspace");
    hook.flush();
    await tick();
    view = hook.render("login-token", identity, "/workspace");
    assert.equal(calls, 2);
    assert.equal(view.host, undefined);
    hook.dispose();
  });
});

test("unavailable notice follows the interface language passed by the view", async () => {
  await withBrowser(async () => {
    globalThis.fetch = async () => Response.json({ version: "kbrain.image.v1", error: { code: "IMAGE_UNAVAILABLE", message: "Not ready", requestId: "req-503", retryable: true } }, { status: 503 });
    const { t } = createWebModuleLoader().loadModule("@liveagent/ui/i18n/index");
    const hook = hookHarness();
    hook.render("login-token", identity, "/workspace", (key) => t(key, "zh-CN"));
    hook.flush();
    await tick();
    assert.equal(hook.render("login-token", identity, "/workspace", (key) => t(key, "zh-CN")).unavailable, "HTTP 503 · 图像模块不可用（IMAGE_UNAVAILABLE）");
    // The raw error is kept, so switching language re-renders the same failure in English.
    assert.equal(hook.render("login-token", identity, "/workspace", (key) => t(key, "en-US")).unavailable, "HTTP 503 · Image module unavailable（IMAGE_UNAVAILABLE）");
    hook.dispose();
  });
});

test("identity/token/workspace switches synchronously hide stale host and abort its transport", async () => {
  await withBrowser(async () => {
    globalThis.fetch = async () => Response.json({ status: "ok", capabilities: { image: { supported: true, version: "kbrain.image.v1" } } });
    const hook = hookHarness();
    hook.render("login-token", identity, "/workspace");
    hook.flush();
    await tick();
    const ready = hook.render("login-token", identity, "/workspace");
    assert.ok(ready.host);
    const changed = hook.render("new-login", identity, "/other");
    assert.equal(changed.host, undefined);
    hook.flush();
    await assert.rejects(ready.host.client.listTargets(), { code: "IMAGE_ABORTED" });
    const rejected = hook.render("new-login", identity, "/other");
    assert.equal(rejected.host, undefined);
    assert.match(rejected.unavailable, /IMAGE_AUTH_REQUIRED/);
    const logout = hook.render("", undefined, "/workspace");
    assert.equal(logout.host, undefined);
    hook.flush();
    hook.dispose();
  });
});

test("WebUI verification journal cannot cross trusted users or selected backends",()=>{
  const loader=createWebModuleLoader();const {createWebImageStudioHost}=loader.loadModule("src/agent-ui-adapters/imageStudio.ts");
  const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const connection={baseUrl:identity.gatewayOrigin,backendId:identity.backendId,token:identity.accessToken};
  const prefix=JSON.stringify([connection.baseUrl,identity.ownerId,connection.backendId,"/workspace"]);
  values.set(prefix+":image-verification:v1:it_test",JSON.stringify({version:1,targetId:"it_test",key:"stable-key",input:{expectedRevision:1,projectId:"ip_test",connectionId:"ic_test",remoteId:"gpt-image-2",targetRevision:1,operation:"generate",count:1,prompt:"fixture",confirmPaid:true}}));
  const a=createWebImageStudioHost(connection,identity,"/workspace",storage);
  const b=createWebImageStudioHost(connection,{...identity,ownerId:"another-user"},"/workspace",storage);
  const c=createWebImageStudioHost({...connection,backendId:"other"},{...identity,backendId:"other"},"/workspace",storage);
  try {assert.equal(a.host.client.loadVerificationAttempt("it_test").key,"stable-key");assert.equal(b.host.client.loadVerificationAttempt("it_test"),null);assert.equal(c.host.client.loadVerificationAttempt("it_test"),null);}
  finally {a.dispose();b.dispose();c.dispose();}
});