import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The JSON-RPC bridge every sandboxed frame talks through: method allowlist, size and rate
// limits, and the event.source check (the only proof of where a message came from).
const loader = createTsModuleLoader();
const protocol = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/protocol.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function bridgeWith(methods, extra = {}) {
  const posted = [];
  const bridge = protocol.createSandboxedUiBridge({
    post: (message) => posted.push(message),
    methods,
    ...extra,
  });
  return { bridge, posted };
}

test("the sandbox attribute is allow-scripts and nothing else", () => {
  assert.equal(protocol.SANDBOXED_UI_SANDBOX, "allow-scripts");
  assert.ok(!protocol.SANDBOXED_UI_SANDBOX.includes("allow-same-origin"));
});

test("only allowlisted methods are answered; others get -32601", async () => {
  const { bridge, posted } = bridgeWith({ "host.getTheme": () => ({ mode: "dark" }) });
  bridge.receive({ jsonrpc: "2.0", id: 1, method: "host.getTheme" });
  bridge.receive({ jsonrpc: "2.0", id: 2, method: "host.readSecrets" });
  // Inherited object keys are not methods.
  bridge.receive({ jsonrpc: "2.0", id: 3, method: "toString" });
  bridge.receive({ jsonrpc: "2.0", id: 4, method: "__proto__" });
  await flush();
  const byId = new Map(posted.map((message) => [message.id, message]));
  assert.deepEqual(byId.get(1), { jsonrpc: "2.0", id: 1, result: { mode: "dark" } });
  for (const id of [2, 3, 4]) {
    assert.equal(byId.get(id).error.code, protocol.JSONRPC_METHOD_NOT_FOUND);
  }
});

test("malformed messages and responses from the page are ignored", async () => {
  const { bridge, posted } = bridgeWith({ ping: () => ({}) });
  for (const data of [null, "ping", 42, [], { id: 1, method: "ping" }, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1, result: {} }]) {
    bridge.receive(data);
  }
  await flush();
  assert.deepEqual(posted, []);
});

test("oversized messages are rejected with -32003 before any handler runs", async () => {
  let ran = false;
  const { bridge, posted } = bridgeWith({ "host.notify": () => { ran = true; } }, { maxMessageBytes: 1024 });
  bridge.receive({ jsonrpc: "2.0", id: 7, method: "host.notify", params: { message: "x".repeat(4096) } });
  // A huge notification is simply dropped.
  bridge.receive({ jsonrpc: "2.0", method: "host.notify", params: { message: "x".repeat(4096) } });
  await flush();
  assert.equal(ran, false);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].id, 7);
  assert.equal(posted[0].error.code, protocol.SANDBOXED_UI_LIMIT_EXCEEDED);
  assert.ok(protocol.SANDBOXED_UI_MAX_MESSAGE_BYTES <= 1024 * 1024);
});

test("requests beyond the per-second budget are refused", async () => {
  let clock = 1000;
  const { bridge, posted } = bridgeWith({ ping: () => ({}) }, { maxRequestsPerSecond: 3, now: () => clock });
  for (let id = 1; id <= 5; id += 1) bridge.receive({ jsonrpc: "2.0", id, method: "ping" });
  await flush();
  assert.deepEqual(posted.filter((m) => "result" in m).map((m) => m.id), [1, 2, 3]);
  assert.deepEqual(posted.filter((m) => m.error?.code === protocol.SANDBOXED_UI_LIMIT_EXCEEDED).map((m) => m.id), [4, 5]);
  clock += 1000;
  bridge.receive({ jsonrpc: "2.0", id: 6, method: "ping" });
  await flush();
  assert.equal(posted.at(-1).id, 6);
  assert.ok("result" in posted.at(-1));
});

test("handler errors map to codes; a disposed bridge never answers", async () => {
  const { bridge, posted } = bridgeWith({
    denied: () => { throw new protocol.SandboxedUiError(protocol.SANDBOXED_UI_DENIED, "Denied by user"); },
    broken: async () => { throw new Error("boom"); },
    slow: () => new Promise((resolve) => setTimeout(() => resolve("late"), 5)),
  });
  bridge.receive({ jsonrpc: "2.0", id: 1, method: "denied" });
  bridge.receive({ jsonrpc: "2.0", id: 2, method: "broken" });
  bridge.receive({ jsonrpc: "2.0", id: 3, method: "slow" });
  await flush();
  const byId = new Map(posted.map((message) => [message.id, message]));
  assert.deepEqual(byId.get(1).error, { code: protocol.SANDBOXED_UI_DENIED, message: "Denied by user" });
  assert.deepEqual(byId.get(2).error, { code: protocol.SANDBOXED_UI_EXECUTION_FAILED, message: "boom" });
  bridge.dispose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(posted.length, 2);
  bridge.notify("panel.themeChanged", {});
  assert.equal(posted.length, 2);
});

test("listenToSandboxedFrame passes on only messages whose source is the frame", () => {
  const listeners = new Set();
  const target = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const frameWindow = { name: "frame" };
  const received = [];
  const stop = protocol.listenToSandboxedFrame(target, () => frameWindow, (data) => received.push(data));
  const dispatch = (event) => { for (const listener of listeners) listener(event); };
  // origin is "null" for every opaque sandbox: it proves nothing either way.
  dispatch({ source: { name: "other frame" }, origin: "null", data: "foreign" });
  dispatch({ source: null, origin: "https://example.invalid", data: "no source" });
  dispatch({ source: frameWindow, origin: "null", data: "mine" });
  assert.deepEqual(received, ["mine"]);
  stop();
  assert.equal(listeners.size, 0);
  // A frame that is gone (no contentWindow) receives nothing.
  const none = protocol.listenToSandboxedFrame(target, () => null, (data) => received.push(data));
  dispatch({ source: null, data: "orphan" });
  none();
  assert.deepEqual(received, ["mine"]);
});
