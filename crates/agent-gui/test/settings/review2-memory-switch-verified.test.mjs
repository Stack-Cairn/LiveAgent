// Second review: behaviours of the cross-instance refresh in MemorySwitch.tsx that were
// checked and hold (kept as guards). Real desktop adapter against a local HTTP stand-in.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function startKBrain() {
  // readDelay delays GET responses so refreshes overlap later writes.
  const state = { enabled: true, requests: [], readDelay: 0, failPut: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      state.requests.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/health") {
        res.end(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", capabilities: { memory_switch: 1 } }));
        return;
      }
      if (req.method === "PUT") {
        if (state.failPut) {
          res.statusCode = 500;
          res.end("persist failed");
          return;
        }
        state.enabled = JSON.parse(body).memory.enabled;
        res.end(JSON.stringify({ mode: "kbrain", providers: [], models: [], memory: { enabled: state.enabled } }));
        return;
      }
      const snapshot = state.enabled;
      setTimeout(
        () => res.end(JSON.stringify({ mode: "kbrain", providers: [], models: [], memory: { enabled: snapshot } })),
        state.readDelay,
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })),
  );
}

async function setup(strict = false) {
  const { server, state, port } = await startKBrain();
  const toasts = [];
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { error: (m) => toasts.push(m), success() {} },
      },
    },
  });
  env.loadModule("@liveagent/app/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl: `http://127.0.0.1:${port}`,
    token: "t",
    protocolVersion: "kbrain.agent.v1",
  });
  const { kbrainSettingsAdapter } = env.loadModule("@liveagent/adapters/kbrainSettings.ts");
  const { MemorySwitch } = env.loadModule("@liveagent/ui/pages/settings/memory/MemorySwitch.tsx");
  const mounts = [];
  const mount = async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = env.createRoot(host);
    const element = env.React.createElement(MemorySwitch, { kbrain: kbrainSettingsAdapter });
    await env.act(async () =>
      root.render(strict ? env.React.createElement(env.React.StrictMode, null, element) : element),
    );
    mounts.push({ host, root });
    return { host, root };
  };
  const tick = () => env.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return;
      await tick();
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const toggle = (host) => host.querySelector('[role="switch"]');
  const checked = (host) => toggle(host)?.getAttribute("aria-checked");
  const idle = (host) => toggle(host) && !toggle(host).hasAttribute("data-disabled");
  const teardown = async () => {
    for (const { host, root } of mounts) {
      try { await env.act(async () => root.unmount()); } catch {}
      host.remove();
    }
    env.cleanup();
    server.close();
  };
  return { env, state, toasts, mount, tick, waitFor, toggle, checked, idle, teardown };
}

test("review2 guard: rapid toggles in one switch with slow refreshes end with both switches equal to the backend", async () => {
  const t = await setup();
  try {
    const a = await t.mount();
    const b = await t.mount();
    await t.waitFor(() => t.toggle(a.host) && t.toggle(b.host), "both loaded");
    t.state.readDelay = 60;
    for (let i = 0; i < 4; i += 1) {
      await t.waitFor(() => t.idle(a.host), "a idle");
      await t.env.act(async () => t.toggle(a.host).click());
    }
    await t.waitFor(() => t.idle(a.host), "a idle");
    for (let i = 0; i < 20; i += 1) await t.tick();
    const expected = String(t.state.enabled);
    assert.equal(t.checked(a.host), expected);
    assert.equal(t.checked(b.host), expected);
    assert.equal(t.state.requests.filter((r) => r.startsWith("PUT")).length, 4);
  } finally {
    await t.teardown();
  }
});

test("review2 guard: a foreign settings-changed event keeps the row mounted during the reload (no hide/show flicker)", async () => {
  const t = await setup();
  try {
    const a = await t.mount();
    await t.waitFor(() => t.toggle(a.host), "loaded");
    t.state.readDelay = 80;
    const observed = [];
    const observer = new MutationObserver(() => observed.push(Boolean(t.toggle(a.host))));
    observer.observe(a.host, { childList: true, subtree: true });
    await t.env.act(async () => { window.dispatchEvent(new Event("kbrain:settings-changed")); });
    for (let i = 0; i < 15; i += 1) await t.tick();
    observer.disconnect();
    assert.ok(!observed.includes(false), "row was removed during reload");
    assert.equal(t.checked(a.host), "true");
  } finally {
    await t.teardown();
  }
});

test("review2 guard: failed save with backend unchanged leaves the other switch correct and the saver rolled back", async () => {
  const t = await setup();
  try {
    const a = await t.mount();
    const b = await t.mount();
    await t.waitFor(() => t.toggle(a.host) && t.toggle(b.host), "both loaded");
    t.state.failPut = true;
    await t.env.act(async () => t.toggle(a.host).click());
    await t.waitFor(() => t.toasts.length === 1 && t.idle(a.host), "failure settles");
    assert.equal(t.checked(a.host), "true");
    assert.equal(t.checked(b.host), "true");
  } finally {
    await t.teardown();
  }
});

test("review2 guard: StrictMode double mount leaves one listener; unmount removes it", async () => {
  const t = await setup(true);
  try {
    const a = await t.mount();
    await t.waitFor(() => t.toggle(a.host), "loaded");
    for (let i = 0; i < 5; i += 1) await t.tick();
    let before = t.state.requests.length;
    await t.env.act(async () => { window.dispatchEvent(new Event("kbrain:settings-changed")); });
    for (let i = 0; i < 10; i += 1) await t.tick();
    assert.equal(t.state.requests.length - before, 2, "one reload = /v1/health + /v1/settings");
    await t.env.act(async () => a.root.unmount());
    before = t.state.requests.length;
    await t.env.act(async () => { window.dispatchEvent(new Event("kbrain:settings-changed")); });
    for (let i = 0; i < 10; i += 1) await t.tick();
    assert.equal(t.state.requests.length, before, "unmounted switch still reloads");
  } finally {
    await t.teardown();
  }
});
