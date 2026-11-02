// Second review regressions for the K-brain memory master switch (MemorySwitch.tsx).
// Each test drives the shipped MemorySwitch through a real host adapter: the desktop
// kbrainSettingsAdapter against a local HTTP K-brain stand-in, or the WebUI
// settingsExtension adapter over a mocked Gateway socket client.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function startKBrain() {
  // failNext: number of upcoming requests answered with 503; down: every request 503.
  const state = { enabled: true, requests: [], failNext: 0, down: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      state.requests.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      if (state.down || state.failNext > 0) {
        if (state.failNext > 0) state.failNext -= 1;
        res.statusCode = 503;
        res.end("K-brain unavailable");
        return;
      }
      if (req.url === "/v1/health") {
        res.end(
          JSON.stringify({
            status: "ok",
            version: "kbrain.agent.v1",
            capabilities: { memory_switch: 1 },
          }),
        );
        return;
      }
      if (req.url === "/v1/settings") {
        if (req.method === "PUT") state.enabled = JSON.parse(body).memory.enabled;
        res.end(
          JSON.stringify({
            mode: "kbrain",
            defaultModel: "",
            defaultProvider: "",
            providers: [],
            models: [],
            memory: { enabled: state.enabled },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })),
  );
}

async function domEnv(toasts) {
  return createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { error: (message) => toasts.push(message), success() {} },
      },
    },
  });
}

function helpers(env) {
  const tick = () =>
    env.act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return;
      await tick();
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const row = (host) => host.querySelector('[data-testid="memory-master-switch"]');
  const toggle = (host) => host.querySelector('[role="switch"]');
  return { tick, waitFor, row, toggle };
}

async function mountDesktop(port, toasts) {
  const env = await domEnv(toasts);
  const { setKBrainRuntimeConnection } = env.loadModule(
    "@liveagent/app/lib/kbrain/runtimeConnection.ts",
  );
  const { kbrainSettingsAdapter } = env.loadModule("@liveagent/adapters/kbrainSettings.ts");
  const { MemorySwitch } = env.loadModule("@liveagent/ui/pages/settings/memory/MemorySwitch.tsx");
  setKBrainRuntimeConnection({
    baseUrl: `http://127.0.0.1:${port}`,
    token: "t",
    protocolVersion: "kbrain.agent.v1",
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () =>
    root.render(env.React.createElement(MemorySwitch, { kbrain: kbrainSettingsAdapter })),
  );
  return { env, host, root };
}

test("review2: a save that fails because K-brain is unreachable keeps the switch on screen with the last known state", async () => {
  const { server, state, port } = await startKBrain();
  const toasts = [];
  const { env, host, root } = await mountDesktop(port, toasts);
  const { tick, waitFor, row, toggle } = helpers(env);
  try {
    await waitFor(() => toggle(host), "switch to load");
    assert.equal(toggle(host).getAttribute("aria-checked"), "true");

    // The K-brain sidecar goes away (crash / restart / network): the PUT fails, and so
    // does the rollback read in change()'s catch branch.
    state.down = true;
    await env.act(async () => toggle(host).click());
    await waitFor(() => toasts.length === 1, "save failure toast");
    for (let i = 0; i < 5; i += 1) await tick();

    assert.equal(state.enabled, true, "backend never changed");
    assert.ok(
      row(host),
      "the memory switch row disappeared after a failed save; the user cannot see or retry the setting",
    );
    assert.equal(
      toggle(host).getAttribute("aria-checked"),
      "true",
      "rolls back to the last value K-brain confirmed",
    );
    assert.equal(toggle(host).hasAttribute("data-disabled"), false, "usable again for a retry");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
    server.close();
  }
});

test("review2: a transient read failure while refreshing after another section's save removes the switch row", async () => {
  const { server, state, port } = await startKBrain();
  const toasts = [];
  const { env, host, root } = await mountDesktop(port, toasts);
  const { tick, waitFor, row, toggle } = helpers(env);
  try {
    await waitFor(() => toggle(host), "switch to load");
    const before = state.requests.length;

    // AIApprovalSection / KBrainComputerSection / KBrainSettingsSection dispatch this
    // after their own save; MemorySwitch reloads /v1/health + /v1/settings. One request
    // of that reload hits a momentary 503.
    state.failNext = 1;
    await env.act(async () => {
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    });
    await waitFor(
      () => state.requests.length > before && state.failNext === 0,
      "refresh request",
    );
    for (let i = 0; i < 5; i += 1) await tick();

    assert.equal(state.enabled, true, "backend switch unchanged");
    assert.ok(
      row(host),
      "an unrelated settings save made the memory switch vanish until the panel is remounted",
    );
    assert.equal(toggle(host).getAttribute("aria-checked"), "true");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
    server.close();
  }
});

test("review2: WebUI save accepted but its read-back failed leaves the other mounted switch showing the old state", async () => {
  // The real WebUI adapter: updateSettings() writes over the Gateway socket and then calls
  // getSettings(); a socket hiccup between the two rejects updateSettings after the write
  // already landed in K-brain.
  let doc = { customProviders: [], kbrainMemory: { enabled: true } };
  let failNextRead = false;
  const client = {
    getSettings: async () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("gateway socket closed");
      }
      return doc;
    },
    updateSettings: async (update) => {
      doc = { ...doc, ...update };
      failNextRead = true;
    },
  };
  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
    mocks: {
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/components/IconSet": { MonitorSmartphone: () => null },
      "@liveagent/ui/lib/resourceHost": {
        configureResourceHostCapabilities() {},
        nativeResourceHostCapabilities: {},
      },
    },
  });
  const kbrain = loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx")
    .settingsHostAdapter.kbrain;

  const toasts = [];
  const env = await domEnv(toasts);
  const { MemorySwitch } = env.loadModule("@liveagent/ui/pages/settings/memory/MemorySwitch.tsx");
  const { waitFor, tick, toggle } = helpers(env);
  // GatewayAppView mounts the memory hub with settingsHostAdapter.kbrain, and the Settings
  // memory page gets the same adapter through settingsHost.kbrain.
  const hubHost = document.body.appendChild(document.createElement("div"));
  const settingsHost = document.body.appendChild(document.createElement("div"));
  const hub = env.createRoot(hubHost);
  const settings = env.createRoot(settingsHost);
  try {
    await env.act(async () => hub.render(env.React.createElement(MemorySwitch, { kbrain })));
    await env.act(async () =>
      settings.render(env.React.createElement(MemorySwitch, { kbrain })),
    );
    await waitFor(() => toggle(hubHost) && toggle(settingsHost), "both switches");

    await env.act(async () => toggle(settingsHost).click());
    await waitFor(
      () => toggle(settingsHost).getAttribute("aria-busy") !== "true" &&
        !toggle(settingsHost).hasAttribute("data-disabled"),
      "settings save settles",
    );
    for (let i = 0; i < 5; i += 1) await tick();
    assert.deepEqual(toasts, [], "a write that landed is not reported as a failed save");

    assert.deepEqual(doc.kbrainMemory, { enabled: false }, "K-brain now has memory off");
    assert.equal(
      toggle(settingsHost).getAttribute("aria-checked"),
      "false",
      "the saving switch read the backend back",
    );
    assert.equal(
      toggle(hubHost).getAttribute("aria-checked"),
      "false",
      "memory hub still shows memory ON: the rollback learned the backend changed but never notified the other switch",
    );
  } finally {
    await env.act(async () => {
      hub.unmount();
      settings.unmount();
    });
    hubHost.remove();
    settingsHost.remove();
    env.cleanup();
  }
});
