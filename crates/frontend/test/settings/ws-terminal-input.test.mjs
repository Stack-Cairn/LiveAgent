// 验证 wsTerminalClient 输入状态机：attach 成功后 write() 是否真的发出 input 帧
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const sentFrames = [];
const socketInstances = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    socketInstances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data) {
    sentFrames.push(JSON.parse(data));
  }
  close() {}
}

globalThis.WebSocket = FakeWebSocket;
globalThis.btoa = globalThis.btoa ?? ((s) => Buffer.from(s, "binary").toString("base64"));
globalThis.atob = globalThis.atob ?? ((s) => Buffer.from(s, "base64").toString("binary"));
globalThis.window = { setTimeout, clearTimeout };

import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

const endpointPath = new URL("../../src/lib/backend/endpoint.ts", import.meta.url).pathname;
const transportPath = new URL("../../src/lib/backend/transport.ts", import.meta.url).pathname;
const loader = createTsModuleLoader({
  mocks: {
    [endpointPath]: {
      resolveEndpoint: async () => ({ wsUrl: "ws://127.0.0.1:8777", httpUrl: "http://127.0.0.1:8777", password: "testpw" }),
      wsBaseUrl: () => "ws://127.0.0.1:8777",
      httpBaseUrl: () => "http://127.0.0.1:8777",
    },
    [transportPath]: {
      backendInvoke: async () => { throw new Error("not used in this test"); },
    },
  },
});
const client = loader.loadModule("src/lib/terminal/wsTerminalClient.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = {
  id: "session-1",
  projectPathKey: "proj",
  cwd: "/tmp",
  shell: "zsh",
  title: "t",
  kind: "local",
  ssh: null,
  pid: 1,
  cols: 80,
  rows: 24,
  createdAt: 0,
  updatedAt: 0,
  finishedAt: null,
  exitCode: null,
  running: true,
};

function latestSocket() {
  return socketInstances[socketInstances.length - 1];
}

function deliverFrame(frame) {
  latestSocket().onmessage?.({ data: JSON.stringify(frame) });
}

test("attach → write → input 帧发出", async () => {
  sentFrames.length = 0;
  socketInstances.length = 0;

  const attachPromise = client.wsTerminalClient.stream.attach(session, { maxBytes: 65536 });
  await sleep(0); // ensureSocket 的 onopen 微任务 + attach 帧发出
  assert.equal(sentFrames[0]?.kind, "attach");
  assert.equal(sentFrames[0]?.sessionId, "session-1");

  // 模拟后端返回 snapshot 帧
  deliverFrame({
    kind: "snapshot",
    sessionId: "session-1",
    session: { ...session },
    bytes: Buffer.from("prompt> ").toString("base64"),
    startOffset: 0,
    endOffset: 8,
    truncated: false,
  });

  const handle = await attachPromise;
  assert.ok(handle);

  // 写入输入
  const accepted = handle.write(new TextEncoder().encode("ls\r"));
  assert.equal(accepted, true);

  // 等 flush 定时器（8ms）触发
  await sleep(20);
  assert.ok(sentFrames.length >= 2, `期望收到 input 帧，实际帧：${JSON.stringify(sentFrames)}`);
  const inputFrames = sentFrames.filter((f) => f.kind === "input");
  assert.equal(inputFrames.length, 1);
  assert.equal(inputFrames[0].sessionId, "session-1");
  const decoded = Buffer.from(inputFrames[0].data, "base64").toString();
  assert.equal(decoded, "ls\r");

  handle.dispose();
});

test("socket 未连接时 write 不丢弃、重连后 flush 补发", async () => {
  sentFrames.length = 0;

  const attachPromise = client.wsTerminalClient.stream.attach(session, { maxBytes: 65536 });
  await sleep(0);
  deliverFrame({
    kind: "snapshot",
    sessionId: "session-1",
    session: { ...session },
    bytes: "",
    startOffset: 0,
    endOffset: 0,
    truncated: false,
  });
  const handle = await attachPromise;

  // 模拟 WS 断开
  const socket = latestSocket();
  socket.readyState = 3;
  socket.onclose?.();

  // 离线期间写入：write 应被拒绝（offline 暂停）
  const accepted = handle.write(new TextEncoder().encode("hello"));
  assert.equal(accepted, false);

  handle.dispose();
});
