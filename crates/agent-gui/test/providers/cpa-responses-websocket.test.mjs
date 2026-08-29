import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

// CPA 的 Responses 事件由 processResponsesStream 消费。测试只关心 transport 层
// （URL 推导 / 握手帧 / response.create 报文 / 关闭码分类），所以把转换层替换为
// 可观测的最小实现，避免真实 Responses 转换逻辑的噪声。
const loader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/constrained-sampling": {
      createGrammarToolInputProperties: () => new Map(),
    },
    "@earendil-works/pi-ai/api/openai-responses-shared": {
      convertResponsesMessages: () => [{ role: "user", content: "hi" }],
      convertResponsesTools: () => [],
      // 逐事件推进：只要收到 response.completed 就把 output 标为 stop，
      // 让主流程走到 done 分支。
      processResponsesStream: async (events, output, stream) => {
        for await (const event of events) {
          if (event?.type === "response.output_text.delta") {
            stream.push({ type: "text", delta: event.delta ?? "" });
          }
          if (event?.type === "response.completed") output.stopReason = "stop";
        }
      },
    },
  },
});

const wsModulePath = abs("src/lib/providers/runtime/cpaResponsesWebSocket.ts");
const fallbackModulePath = abs("src/lib/providers/runtime/transportFallbackMessage.ts");

// ---------------------------------------------------------------------------
// URL 推导
// ---------------------------------------------------------------------------

test("resolveCpaResponsesWebSocketUrl targets /responses on the same path and upgrades the scheme", () => {
  const { resolveCpaResponsesWebSocketUrl } = loader.loadModule(wsModulePath);

  // 本地反代基址（HTTP → ws）。CPA 的 WS 与 SSE 同路径，只是 GET 升级。
  assert.equal(
    resolveCpaResponsesWebSocketUrl("http://127.0.0.1:8765/proxy/codex/v1"),
    "ws://127.0.0.1:8765/proxy/codex/v1/responses",
  );
  // 已经指向 /responses 时不得重复追加。
  assert.equal(
    resolveCpaResponsesWebSocketUrl("http://127.0.0.1:8765/proxy/codex/v1/responses"),
    "ws://127.0.0.1:8765/proxy/codex/v1/responses",
  );
  // 直连 HTTPS 端点 → wss。
  assert.equal(
    resolveCpaResponsesWebSocketUrl("https://cpa.example.com/v1"),
    "wss://cpa.example.com/v1/responses",
  );
  // 尾斜杠不产生空路径段。
  assert.equal(
    resolveCpaResponsesWebSocketUrl("https://cpa.example.com/v1/"),
    "wss://cpa.example.com/v1/responses",
  );
});

test("resolveCpaResponsesWebSocketUrl rejects non-http(s) schemes", () => {
  const { resolveCpaResponsesWebSocketUrl } = loader.loadModule(wsModulePath);
  assert.throws(() => resolveCpaResponsesWebSocketUrl("ftp://cpa.example.com/v1"), /http\(s\)/);
});

// ---------------------------------------------------------------------------
// 回退文案：每种 reason 必须给出可区分的说明
// ---------------------------------------------------------------------------

test("describeTransportFallback distinguishes every fallback reason", () => {
  const { describeTransportFallback } = loader.loadModule(fallbackModulePath);
  const reasons = [
    "not-eligible",
    "handshake-failed",
    "message-too-big",
    "upstream-replay-required",
    "stream-incomplete",
  ];
  const messages = reasons.map((reason) =>
    describeTransportFallback({ from: "websocket", to: "sse", reason, errorMessage: "x" }),
  );
  assert.equal(new Set(messages).size, reasons.length, "每种原因都要有独立文案");
  for (const message of messages) {
    assert.match(message, /SSE/, "文案需说明已回退到 SSE");
  }
  // not-eligible 是配置问题，不能说成「连接失败」，否则用户会去反复调设置。
  const notEligible = describeTransportFallback({
    from: "websocket",
    to: "sse",
    reason: "not-eligible",
    errorMessage: "x",
  });
  assert.doesNotMatch(notEligible, /失败/);
});

// ---------------------------------------------------------------------------
// transport 端到端：握手帧、response.create 报文、关闭码分类
// ---------------------------------------------------------------------------

/**
 * 最小 WebSocket 替身。安装 codexWebSocketProxy 后会被其包装，所以本替身收到的
 * 第一帧应当是代理注入的握手帧 —— 这正是我们要断言的链路。
 */
function installFakeWebSocket() {
  const sockets = [];
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.sent = [];
      this.binaryType = "blob";
      sockets.push(this);
      // 让构造函数先返回，调用方装好监听器再触发 open。
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.closeCalls = (this.closeCalls ?? 0) + 1;
    }
    emitMessage(payload) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: typeof payload === "string" ? payload : JSON.stringify(payload),
        }),
      );
    }
    emitClose(code, reason = "") {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  return sockets;
}

function baseModel() {
  return {
    api: "openai-responses",
    provider: "openai",
    id: "gpt-5.6-luna",
    baseUrl: "http://127.0.0.1:8765/proxy/codex/v1",
    maxTokens: 128_000,
    compat: { supportsStrictMode: true },
  };
}

function baseOptions(overrides = {}) {
  return {
    apiKey: "cpa-test-key",
    headers: {
      Authorization: "Bearer cpa-test-key",
      "x-liveagent-upstream-origin": "https://cpa.example.com",
      "x-liveagent-proxy-token": "proxy-token",
    },
    sessionId: "session-1",
    ...overrides,
  };
}

/** 收集 SSE 兜底是否被调用，以及回退回调看到的 reason。 */
function createHarness() {
  const fallbacks = [];
  let sseCalls = 0;
  const { createAssistantMessageEventStream } = loader.loadModule(
    abs("node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"),
  );
  const sseFactory = () => {
    sseCalls += 1;
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [], stopReason: "stop" };
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  return {
    fallbacks,
    sseFactory,
    onTransportFallback: (info) => fallbacks.push(info),
    get sseCalls() {
      return sseCalls;
    },
  };
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

test("CPA transport sends the local-proxy handshake frame before response.create", async () => {
  const sockets = installFakeWebSocket();
  const { streamCpaResponsesWithFallback } = loader.loadModule(wsModulePath);
  const harness = createHarness();

  const stream = streamCpaResponsesWithFallback(
    baseModel(),
    { messages: [], tools: [] },
    baseOptions({ onTransportFallback: harness.onTransportFallback }),
    harness.sseFactory,
  );

  // 等到 socket 建立并收到两帧后再喂完成事件。
  await new Promise((resolve) => setTimeout(resolve, 10));
  const socket = sockets.at(-1);
  assert.ok(socket, "应当创建了 WebSocket");

  // /proxy/... 必须被改写到 /proxy-ws/...，否则 Rust 侧不会走 WS 中继路由。
  assert.match(socket.url, /\/proxy-ws\/codex\/v1\/responses$/);

  const handshake = JSON.parse(socket.sent[0]);
  assert.equal(handshake.type, "liveagent.proxy.websocket.handshake");
  assert.equal(handshake.headers["x-liveagent-proxy-token"], "proxy-token");
  assert.equal(handshake.headers["x-liveagent-upstream-origin"], "https://cpa.example.com");
  assert.equal(handshake.headers.Authorization, "Bearer cpa-test-key");
  // 凭证只走握手帧的 header 包，绝不出现在 URL 里。
  assert.doesNotMatch(socket.url, /cpa-test-key/);

  const request = JSON.parse(socket.sent[1]);
  assert.equal(request.type, "response.create");
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.deepEqual(request.input, [{ role: "user", content: "hi" }]);

  socket.emitMessage({ type: "response.completed", response: { status: "completed" } });
  const { result } = await drain(stream);
  assert.equal(result.stopReason, "stop");
  assert.equal(harness.sseCalls, 0, "成功时不应触发 SSE 兜底");
  assert.equal(harness.fallbacks.length, 0);
});

test("CPA transport closes the socket on the success path", async () => {
  const sockets = installFakeWebSocket();
  const { streamCpaResponsesWithFallback } = loader.loadModule(wsModulePath);
  const harness = createHarness();

  const stream = streamCpaResponsesWithFallback(
    baseModel(),
    { messages: [], tools: [] },
    baseOptions({ onTransportFallback: harness.onTransportFallback }),
    harness.sseFactory,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const socket = sockets.at(-1);
  socket.emitMessage({ type: "response.completed", response: { status: "completed" } });
  await drain(stream);

  // CPA 的会话是连接级的，成功后不关会一直占着它的执行会话与上游 WebSocket。
  assert.ok((socket.closeCalls ?? 0) >= 1, "成功路径必须关闭 WebSocket，否则连接泄漏");
  assert.equal(socket.readyState, 3);
});

test("CPA transport closes the socket on the fallback path", async () => {
  const sockets = installFakeWebSocket();
  const { streamCpaResponsesWithFallback } = loader.loadModule(wsModulePath);
  const harness = createHarness();

  const stream = streamCpaResponsesWithFallback(
    baseModel(),
    { messages: [], tools: [] },
    baseOptions({ onTransportFallback: harness.onTransportFallback }),
    harness.sseFactory,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const socket = sockets.at(-1);
  socket.emitClose(1009, "message too big");
  await drain(stream);

  assert.equal(harness.sseCalls, 1);
  assert.ok((socket.closeCalls ?? 0) >= 1, "回退路径同样必须关闭 WebSocket");
});

test("CPA transport maps close code 1009 to a message-too-big fallback", async () => {
  const sockets = installFakeWebSocket();
  const { streamCpaResponsesWithFallback } = loader.loadModule(wsModulePath);
  const harness = createHarness();

  const stream = streamCpaResponsesWithFallback(
    baseModel(),
    { messages: [], tools: [] },
    baseOptions({ onTransportFallback: harness.onTransportFallback }),
    harness.sseFactory,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  sockets.at(-1).emitClose(1009, "message too big");
  await drain(stream);

  assert.equal(harness.sseCalls, 1, "1009 必须回退 SSE");
  assert.equal(harness.fallbacks.length, 1);
  assert.equal(harness.fallbacks[0].reason, "message-too-big");
  assert.equal(harness.fallbacks[0].from, "websocket");
  assert.equal(harness.fallbacks[0].to, "sse");
});

test("CPA transport maps close code 1012 to an upstream-replay-required fallback", async () => {
  const sockets = installFakeWebSocket();
  const { streamCpaResponsesWithFallback } = loader.loadModule(wsModulePath);
  const harness = createHarness();

  const stream = streamCpaResponsesWithFallback(
    baseModel(),
    { messages: [], tools: [] },
    baseOptions({ onTransportFallback: harness.onTransportFallback }),
    harness.sseFactory,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  sockets.at(-1).emitClose(1012, "upstream requires HTTP replay");
  await drain(stream);

  assert.equal(harness.sseCalls, 1);
  assert.equal(harness.fallbacks[0].reason, "upstream-replay-required");
});

test("CPA transport treats an abnormal close before content as stream-incomplete", async () => {
  const sockets = installFakeWebSocket();
  const { streamCpaResponsesWithFallback } = loader.loadModule(wsModulePath);
  const harness = createHarness();

  const stream = streamCpaResponsesWithFallback(
    baseModel(),
    { messages: [], tools: [] },
    baseOptions({ onTransportFallback: harness.onTransportFallback }),
    harness.sseFactory,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  sockets.at(-1).emitClose(1006);
  await drain(stream);

  assert.equal(harness.sseCalls, 1);
  assert.equal(harness.fallbacks[0].reason, "stream-incomplete");
});

test("CPA transport accepts the [DONE] sentinel as stream termination", async () => {
  const sockets = installFakeWebSocket();
  const { streamCpaResponsesWithFallback } = loader.loadModule(wsModulePath);
  const harness = createHarness();

  const stream = streamCpaResponsesWithFallback(
    baseModel(),
    { messages: [], tools: [] },
    baseOptions({ onTransportFallback: harness.onTransportFallback }),
    harness.sseFactory,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const socket = sockets.at(-1);
  socket.emitMessage({ type: "response.completed", response: { status: "completed" } });
  // [DONE] 不是 JSON，必须被短路而不是当成解析失败。
  socket.emitMessage("[DONE]");
  const { result } = await drain(stream);

  assert.equal(result.stopReason, "stop");
  assert.equal(harness.sseCalls, 0);
});
