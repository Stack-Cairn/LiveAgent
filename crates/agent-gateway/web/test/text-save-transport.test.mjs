import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const base = createWebModuleLoader();
const adapters = base.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const { WebClientFrameSchema } = base.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");
const { fromBinary } = base.loadModule("@bufbuild/protobuf");
const source = (name) => fileURLToPath(new URL(`../src/lib/${name}`, import.meta.url));
const loader = createWebModuleLoader({
  mocks: {
    "@liveagent/ui/lib/sftp/normalization": {},
    "@liveagent/ui/lib/terminal/normalization": {},
    "@liveagent/ui/lib/terminal/sshLocalForwardTypes": {},
    "@/lib/chat/goalState": {},
    "@/lib/chat/stream/conversationStreamClient": {},
    "@/lib/chat/stream/streamTypes": {},
    "@/lib/terminal/gatewayTerminalStreamClient": {},
    [source("gatewaySocketShared.ts")]: {
      getRuntimeHost: () => globalThis,
      DEFAULT_REQUEST_TIMEOUT_MS: 5000,
    },
    [source("gatewaySocketV2/adapters.ts")]: adapters,
  },
});
const { GatewayWebSocketTransport } = loader.loadModule("src/lib/gatewaySocketTransport.ts");

function transport() {
  // Exercise the real send queue and pending-request implementation without
  // starting unrelated subscriptions or a browser connection handshake.
  const client = Object.create(GatewayWebSocketTransport.prototype);
  client.textSaveQueue = Promise.resolve();
  client.socket = {};
  client.authenticated = true;
  client.activeAgentId = "agent";
  client.pending = new Map();
  client.shouldTreatRequestTimeoutAsTransportStall = () => false;
  let seq = 0;
  client.nextRequestId = () => `save-${++seq}`;
  return client;
}

function settle(client, id, value, error) {
  const pending = client.pending.get(id);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  client.pending.delete(id);
  if (error) pending.reject(error);
  else pending.resolve(value);
}

test("concurrent fs and sftp saves serialize every ACK through the final response", async () => {
  const client = transport();
  const sent = [];
  let retained = null;
  client.sendFrame = (bytes) => {
    const frame = fromBinary(WebClientFrameSchema, bytes);
    sent.push(frame);
    assert.equal(client.pending.size, 1);
    const chunk = frame.payload.value;
    const final = chunk.offset + BigInt(chunk.data.byteLength) === chunk.totalBytes;
    if (frame.requestId === "save-1" && final) {
      retained = () => settle(client, frame.requestId, { saved: "filesystem" });
    } else {
      queueMicrotask(() => settle(client, frame.requestId, final ? { saved: "sftp" } : { ok: true }));
    }
  };
  const content = "猫".repeat(500000);
  const first = client.sendConnectedRequest("fs.write_text", { workdir: "/work", path: "file", content }, undefined, "agent");
  const second = client.sendConnectedRequest("sftp.write_text", { session_id: "ssh", remote_path: "/file", content }, undefined, "agent");
  // Drain the finite chain of ACK microtasks until the first final response is held.
  for (let index = 0; index < 30 && !retained; index++) await Promise.resolve();
  assert.ok(retained);
  assert.ok(sent.every((frame) => frame.requestId === "save-1"));
  retained();
  assert.deepEqual(await first, { saved: "filesystem" });
  assert.deepEqual(await second, { saved: "sftp" });
  const firstSecondSave = sent.findIndex((frame) => frame.requestId === "save-2");
  assert.ok(firstSecondSave > 1);
  assert.ok(sent.slice(firstSecondSave).every((frame) => frame.requestId === "save-2"));
  assert.equal(client.pending.size, 0);
});

test("a chunk request failure sends scoped cancellation and allows the next queued save", async (t) => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: { OPEN: 1 } });
  t.after(() => originalWebSocket
    ? Object.defineProperty(globalThis, "WebSocket", originalWebSocket)
    : delete globalThis.WebSocket);
  const client = transport();
  client.socket.readyState = 1;
  const sent = [];
  client.sendFrame = (bytes) => {
    const frame = fromBinary(WebClientFrameSchema, bytes);
    sent.push(frame);
    if (frame.payload.case === "agentRequestChunk" && frame.payload.value.cancel) return;
    queueMicrotask(() => settle(client, frame.requestId, { saved: true },
      frame.requestId === "save-1" ? new Error("upload rejected") : undefined));
  };
  const first = client.sendConnectedRequest("fs.write_text", { workdir: "/work", path: "file", content: "x".repeat(2 * 1024 * 1024) }, undefined, "agent");
  const failed = assert.rejects(first, /upload rejected/);
  const second = client.sendConnectedRequest("fs.write_text", { workdir: "/work", path: "file", content: "small" }, undefined, "agent");
  await failed;
  assert.deepEqual(await second, { saved: true });
  const cancel = sent.find((frame) => frame.payload.case === "agentRequestChunk" && frame.payload.value.cancel);
  assert.equal(cancel.requestId, "save-1");
  assert.equal(cancel.agentId, "agent");
  assert.equal(sent.at(-1).requestId, "save-2");
  assert.equal(client.pending.size, 0);
});
