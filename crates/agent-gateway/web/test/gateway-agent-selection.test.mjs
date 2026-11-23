// A fresh browser must land on an Agent that can chat: never the workspace
// watcher the gateway registers for offline workspaces, and never a stale
// stored watcher id from an older build.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const selection = loader.loadModule("src/lib/gatewayAgentSelection.ts");
const shared = loader.loadModule("src/lib/gatewaySocketShared.ts");

const WATCHER = "gateway-local-workspace-b259d2ba975893f8";
const watcher = {
  agent_id: WATCHER,
  online: true,
  agent_ready: true,
  runtime_state: "protocol_incompatible",
};
const kbrain = { agent_id: "kbrain", name: "K-brain", online: true, agent_ready: true };
const desktop = { agent_id: "desktop-1", name: "Work desktop", online: false };

test("a fresh browser picks the chat-capable Agent over a workspace watcher", () => {
  // The watcher sorts first by id and reports online; the old ranking took it.
  assert.equal(selection.pickActiveAgentId([watcher, kbrain], ""), "kbrain");
  assert.equal(selection.pickActiveAgentId([watcher, desktop, kbrain], ""), "kbrain");
});

test("a stored watcher id is replaced instead of kept", () => {
  assert.equal(selection.pickActiveAgentId([watcher, kbrain], WATCHER), "kbrain");
});

test("the watcher is only used when it is the sole entry and online", () => {
  assert.equal(selection.pickActiveAgentId([watcher], ""), WATCHER);
  assert.equal(selection.pickActiveAgentId([{ ...watcher, online: false }], ""), "");
  assert.deepEqual(
    selection.selectableAgents([watcher, kbrain]).map((agent) => agent.agent_id),
    ["kbrain"],
  );
});

test("an offline stored desktop stays selected and a chat-capable switch is offered", () => {
  assert.equal(selection.pickActiveAgentId([watcher, desktop, kbrain], "desktop-1"), "desktop-1");
  assert.equal(
    selection.suggestAlternativeAgent([watcher, desktop, kbrain], "desktop-1")?.agent_id,
    "kbrain",
  );
  assert.equal(selection.suggestAlternativeAgent([watcher, desktop, kbrain], "kbrain"), null);
  assert.equal(selection.suggestAlternativeAgent([watcher, desktop], "desktop-1"), null);
});

test("protocol-incompatible desktops rank below chat-capable ones", () => {
  const oldDesktop = { agent_id: "a-old", online: true, runtime_state: "protocol_incompatible" };
  assert.equal(selection.pickActiveAgentId([oldDesktop, kbrain], ""), "kbrain");
  assert.equal(selection.isChatCapableAgent(oldDesktop), false);
});

test("a persisted watcher id is not restored on page load", () => {
  const storage = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  try {
    storage.set(shared.ACTIVE_AGENT_STORAGE_KEY, WATCHER);
    assert.equal(shared.loadPersistedActiveAgent(), "");
    storage.set(shared.ACTIVE_AGENT_STORAGE_KEY, "kbrain");
    assert.equal(shared.loadPersistedActiveAgent(), "kbrain");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

test("the transport's directory and auto-selection skip the watcher", () => {
  const { GatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  const client = new GatewayWebSocketClient("token");
  try {
    // Directory order puts the watcher first; it reports itself online.
    const agents = [watcher, kbrain];
    client.updateAgentDirectory(agents);
    assert.equal(client.reconcileActiveAgent(agents, false), "kbrain");
    assert.equal(client.getActiveAgent(), "kbrain");
    assert.deepEqual(
      client.snapshotAgents().map((agent) => agent.agent_id),
      ["kbrain"],
      "the avatar menu never lists the watcher next to real Agents",
    );
  } finally {
    client.dispose();
  }
});
