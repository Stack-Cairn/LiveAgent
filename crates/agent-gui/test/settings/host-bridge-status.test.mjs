// The desktop host bridge serves ReadTerminal and TunnelManager to K-brain. The webview only
// learns whether the registration is live and which tools it carries (never the bridge URL or
// token), and the settings tool list shows that next to the two tools.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const icons = new Proxy({}, { get: () => () => null });
const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));
let invokeImpl = async () => {
  throw new Error("unexpected invoke");
};
const listeners = new Map();
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [iconPath]: icons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/app/shims/tauriCore": { invoke: (...args) => invokeImpl(...args) },
    "@liveagent/app/shims/tauriEvent": {
      listen: async (event, handler) => {
        listeners.set(event, handler);
        return () => listeners.delete(event);
      },
    },
  },
});
const { React, act, createRoot } = env;
const store = env.loadModule("@liveagent/ui/lib/tools/hostBridgeStatus.ts");

test.after(() => env.cleanup());

test("status payloads are parsed strictly and carry tools only while registered", () => {
  assert.deepEqual(store.parseHostBridgeStatus({ state: "registered", tools: ["ReadTerminal", 3, ""] }), {
    state: "registered",
    tools: ["ReadTerminal"],
  });
  assert.deepEqual(store.parseHostBridgeStatus({ state: "failed", tools: ["ReadTerminal"] }), {
    state: "failed",
    tools: [],
  });
  for (const value of [null, "registered", { state: "ready" }, { tools: [] }]) {
    assert.equal(store.parseHostBridgeStatus(value), null, JSON.stringify(value));
  }
});

test("tool availability follows the registration", () => {
  const registered = { state: "registered", tools: ["ReadTerminal"] };
  assert.equal(store.hostBridgeToolAvailability(registered, "ReadTerminal"), "available");
  assert.equal(store.hostBridgeToolAvailability(registered, "TunnelManager"), "tunnels_off");
  assert.equal(store.hostBridgeToolAvailability(registered, "Bash"), null);
  assert.equal(
    store.hostBridgeToolAvailability({ state: "unsupported", tools: [] }, "TunnelManager"),
    "unsupported",
  );
  assert.equal(
    store.hostBridgeToolAvailability({ state: "disconnected", tools: [] }, "ReadTerminal"),
    "unavailable",
  );
  assert.equal(store.hostBridgeToolAvailability(null, "ReadTerminal"), null);
});

test("loading asks the desktop to refresh, publishes, and never throws", async () => {
  store.resetHostBridgeStatusForTests();
  const calls = [];
  const status = await store.loadHostBridgeStatus(async (command, args) => {
    calls.push([command, args]);
    return { state: "registered", tools: ["ReadTerminal", "TunnelManager"] };
  }, { refresh: true });
  assert.deepEqual(calls, [["host_bridge_status", { refresh: true }]]);
  assert.deepEqual(status, { state: "registered", tools: ["ReadTerminal", "TunnelManager"] });
  assert.deepEqual([...store.getHostBridgeTools()], ["ReadTerminal", "TunnelManager"]);

  // A host without the command (WebUI) or a hung desktop keeps the last status.
  assert.deepEqual(
    await store.loadHostBridgeStatus(async () => {
      throw new Error("unknown command");
    }),
    status,
  );
  assert.deepEqual(
    await store.loadHostBridgeStatus(() => new Promise(() => {}), { timeoutMs: 5 }),
    status,
  );
  store.resetHostBridgeStatusForTests();
  assert.equal(
    await store.loadHostBridgeStatus(async () => {
      throw new Error("unknown command");
    }),
    null,
  );
  assert.equal(store.getHostBridgeTools().size, 0);
});

test("status events update subscribers once per change", async () => {
  store.resetHostBridgeStatusForTests();
  const handlers = [];
  const listenFn = async (event, handler) => {
    assert.equal(event, "host-bridge:status");
    handlers.push(handler);
    return () => {};
  };
  await store.watchHostBridgeStatus(listenFn);
  await store.watchHostBridgeStatus(listenFn);
  assert.equal(handlers.length, 1, "watching is idempotent");
  let notified = 0;
  store.subscribeHostBridgeStatus(() => {
    notified += 1;
  });
  handlers[0]({ payload: { state: "registered", tools: ["ReadTerminal"] } });
  handlers[0]({ payload: { state: "registered", tools: ["ReadTerminal"] } });
  handlers[0]({ payload: { state: "bogus" } });
  assert.equal(notified, 1);
  handlers[0]({ payload: { state: "disconnected", tools: [] } });
  assert.equal(notified, 2);
  assert.equal(store.getHostBridgeStatus().state, "disconnected");
  store.resetHostBridgeStatusForTests();
});

test("the settings tool list badges the bridge tools from the live status", async () => {
  store.resetHostBridgeStatusForTests();
  listeners.clear();
  invokeImpl = async (command) => {
    assert.equal(command, "host_bridge_status");
    return { state: "registered", tools: ["ReadTerminal"] };
  };
  const { SystemToolsSection } = env.loadModule("@liveagent/ui/pages/settings/SystemToolsSection.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const settings = { system: { toolPolicies: {} } };
  await act(async () => {
    root.render(React.createElement(SystemToolsSection, { settings, setSettings() {} }));
  });
  const badges = () =>
    Object.fromEntries(
      [...host.querySelectorAll("[data-host-bridge]")].map((badge) => [
        badge.parentElement.querySelector("code").textContent,
        badge.dataset.hostBridge,
      ]),
    );
  assert.deepEqual(badges(), { ReadTerminal: "available", TunnelManager: "tunnels_off" });

  // Remote tunnels switched on: the desktop re-registers and emits the new status.
  await act(async () => {
    listeners.get("host-bridge:status")({
      payload: { state: "registered", tools: ["ReadTerminal", "TunnelManager"] },
    });
  });
  assert.deepEqual(badges(), { ReadTerminal: "available", TunnelManager: "available" });

  await act(async () => {
    listeners.get("host-bridge:status")({ payload: { state: "unsupported", tools: [] } });
  });
  assert.deepEqual(badges(), { ReadTerminal: "unsupported", TunnelManager: "unsupported" });
  assert.equal(host.querySelectorAll("[data-host-bridge]").length, 2, "only the bridge tools");
  act(() => root.unmount());
  host.remove();
});

test("hosts without the bridge show no badges", async () => {
  store.resetHostBridgeStatusForTests();
  invokeImpl = async (command) => {
    throw new Error(`Unsupported WebUI command: ${command}`);
  };
  const { SystemToolsSection } = env.loadModule("@liveagent/ui/pages/settings/SystemToolsSection.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(SystemToolsSection, { settings: { system: { toolPolicies: {} } }, setSettings() {} }),
    );
  });
  assert.equal(host.querySelectorAll("[data-host-bridge]").length, 0);
  act(() => root.unmount());
  host.remove();
});
