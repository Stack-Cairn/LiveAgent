// Review regression: the desktop settings overlay (App.tsx) is drawn above a still-mounted
// ChatPage, so the memory hub's MemorySwitch and the Settings memory page's MemorySwitch
// are mounted at the same time. Toggling one must not leave the other showing the old state.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function startKBrain() {
  const state = { enabled: true, puts: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/health") {
        res.end(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", capabilities: { memory_switch: 1 } }));
        return;
      }
      if (req.url === "/v1/settings") {
        if (req.method === "PUT") {
          const update = JSON.parse(body);
          state.puts.push(update);
          state.enabled = update.memory.enabled;
        }
        res.end(JSON.stringify({ mode: "kbrain", defaultModel: "", defaultProvider: "", providers: [], models: [], memory: { enabled: state.enabled } }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

test("review: a second mounted memory switch (memory hub under the settings overlay) follows a toggle made in the other", async () => {
  const { server, state, port } = await startKBrain();
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": { toast: { error() {}, success() {} } },
    },
  });
  const { setKBrainRuntimeConnection } = env.loadModule("@liveagent/app/lib/kbrain/runtimeConnection.ts");
  const { kbrainSettingsAdapter } = env.loadModule("@liveagent/adapters/kbrainSettings.ts");
  const { MemorySwitch } = env.loadModule("@liveagent/ui/pages/settings/memory/MemorySwitch.tsx");
  setKBrainRuntimeConnection({ baseUrl: `http://127.0.0.1:${port}`, token: "t", protocolVersion: "kbrain.agent.v1" });

  const hubHost = document.body.appendChild(document.createElement("div"));
  const settingsHost = document.body.appendChild(document.createElement("div"));
  const hub = env.createRoot(hubHost);
  const settings = env.createRoot(settingsHost);
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await env.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const toggle = (host) => host.querySelector('[role="switch"]');
  try {
    // Memory hub open in ChatPage (kbrainSettings={kbrainSettingsAdapter}).
    await env.act(async () => hub.render(env.React.createElement(MemorySwitch, { kbrain: kbrainSettingsAdapter })));
    await waitFor(() => toggle(hubHost), "hub switch");
    // Settings overlay opened on the memory page (settingsHost.kbrain is the same adapter).
    await env.act(async () => settings.render(env.React.createElement(MemorySwitch, { kbrain: kbrainSettingsAdapter })));
    await waitFor(() => toggle(settingsHost), "settings switch");

    await env.act(async () => toggle(settingsHost).click());
    await waitFor(
      () => state.puts.length === 1 && !toggle(settingsHost).hasAttribute("data-disabled") && toggle(settingsHost).getAttribute("aria-checked") === "false",
      "settings save",
    );
    assert.deepEqual(state.puts, [{ memory: { enabled: false } }]);
    assert.equal(state.enabled, false, "backend now has memory off");

    // Closing the overlay reveals the hub again; give it ample time to refresh.
    await env.act(async () => settings.unmount());
    for (let i = 0; i < 10; i += 1) await env.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.equal(
      toggle(hubHost).getAttribute("aria-checked"),
      "false",
      "memory hub still shows memory ON after it was turned off in Settings",
    );
    assert.match(hubHost.textContent, /已关闭/);
  } finally {
    await env.act(async () => hub.unmount());
    hubHost.remove();
    settingsHost.remove();
    env.cleanup();
    server.close();
  }
});
