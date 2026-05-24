import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

class FakeMessagePort {
  messages = [];
  closed = false;
  onmessage = null;
  onmessageerror = null;

  postMessage(message) {
    this.messages.push(message);
  }

  start() {}

  close() {
    this.closed = true;
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  readyState = FakeWebSocket.CONNECTING;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(envelope) {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  close(event = {}) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({
      code: event.code ?? 1006,
      reason: event.reason ?? "",
      wasClean: event.wasClean ?? false,
    });
  }
}

function installBrowser(options = {}) {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  delete globalThis.SharedWorker;
  globalThis.window = {
    location: { origin: "https://gateway.example" },
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    setInterval: options.setInterval ?? setInterval,
    clearInterval: options.clearInterval ?? clearInterval,
  };
}

class FakeSharedWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.port = new FakeMessagePort();
    FakeSharedWorker.instances.push(this);
  }
}

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 500) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

async function connectAndAuth(index = 0) {
  await waitFor(() => FakeWebSocket.instances.length > index, "websocket construction");
  const socket = FakeWebSocket.instances[index];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "auth envelope");
  assert.equal(socket.url, "wss://gateway.example/ws");
  assert.equal(socket.sent[0].type, "auth");
  assert.deepEqual(socket.sent[0].payload, { token: "token" });
  socket.receive({ id: socket.sent[0].id, type: "response", payload: { ok: true } });
  return socket;
}

test("GatewayWebSocketClient authenticates once and sends status requests over /ws", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const statusPromise = client.getStatus();
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "status envelope");
  assert.equal(socket.sent[1].type, "status.get");
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { online: true, agent_id: "desktop-agent" },
  });

  const status = await statusPromise;
  assert.deepEqual(status, { online: true, agent_id: "desktop-agent" });
  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client sends conversation cancel even without a local stream", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  assert.equal(FakeSharedWorker.instances.length, 1);
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  assert.ok(connect);
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  await client.cancelChat(" conversation-1 ");

  const cancel = port.messages.find((message) => message.type === "chat.cancel");
  assert.deepEqual(cancel, {
    type: "chat.cancel",
    connection_id: connect.connection_id,
    stream_id: "",
    conversation_id: "conversation-1",
  });

  resetGatewayWebSocketClient();
});

test("Gateway SharedWorker broadcasts events with each port connection id", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    statusListeners = [];
    historyListeners = [];
    conversationListeners = [];
    settingsListeners = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus(listener) {
      this.statusListeners.push(listener);
      return () => {};
    }

    subscribeHistory(listener) {
      this.historyListeners.push(listener);
      return () => {};
    }

    subscribeConversation(listener) {
      this.conversationListeners.push(listener);
      return () => {};
    }

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");
  assert.equal(typeof globalThis.onconnect, "function");

  const firstPort = new FakeMessagePort();
  const secondPort = new FakeMessagePort();
  globalThis.onconnect({ ports: [firstPort] });
  globalThis.onconnect({ ports: [secondPort] });

  firstPort.emit({ type: "connect", connection_id: "connection-1", token: " token " });
  secondPort.emit({ type: "connect", connection_id: "connection-2", token: "token" });

  assert.equal(clientInstances.length, 1);
  assert.equal(clientInstances[0].token, "token");
  assert.deepEqual(firstPort.messages.at(-1), {
    type: "ready",
    connection_id: "connection-1",
    payload: { status: null, error: null },
  });
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "ready",
    connection_id: "connection-2",
    payload: { status: null, error: null },
  });

  const historyEvent = { kind: "idle", conversation_id: "conversation-1" };
  clientInstances[0].historyListeners[0](historyEvent);

  assert.deepEqual(firstPort.messages.at(-1), {
    type: "event",
    event_type: "history",
    connection_id: "connection-1",
    payload: historyEvent,
  });
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "event",
    event_type: "history",
    connection_id: "connection-2",
    payload: historyEvent,
  });

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards chat metadata and uploaded files", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const chatCalls = [];

  class MockGatewayWebSocketClient {
    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    async *chat(...args) {
      chatCalls.push(args);
      yield { type: "done", conversation_id: "conversation-1" };
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  port.emit({
    type: "chat.start",
    connection_id: "connection-1",
    request_id: "request-1",
    stream_id: "stream-1",
    payload: {
      message: "inspect",
      conversation_id: "conversation-1",
      client_request_id: "client-submit-1",
      selected_model: {
        customProviderId: "gemini-provider",
        model: "gemini-test",
        providerType: "gemini",
      },
      system_settings: {
        executionMode: "text",
        workdir: "/workspace",
        selectedSystemTools: [],
      },
      uploaded_files: [
        {
          relativePath: "uploads/screenshot.png",
          absolutePath: "/workspace/uploads/screenshot.png",
          fileName: "screenshot.png",
          kind: "image",
          sizeBytes: 12,
        },
      ],
      runtime_controls: {
        thinkingEnabled: false,
        nativeWebSearchEnabled: true,
        reasoning: "medium",
      },
    },
  });

  const response = port.messages.at(-1);
  assert.equal(response.type, "response");
  assert.equal(response.connection_id, "connection-1");
  assert.equal(response.request_id, "request-1");
  assert.deepEqual(response.payload, { ok: true });
  await waitFor(() => chatCalls.length === 1, "shared worker chat call");

  assert.deepEqual(chatCalls[0], [
    "inspect",
    "conversation-1",
    {
      customProviderId: "gemini-provider",
      model: "gemini-test",
      providerType: "gemini",
    },
    {
      executionMode: "text",
      workdir: "/workspace",
      selectedSystemTools: [],
    },
    chatCalls[0][4],
    [
      {
        relativePath: "uploads/screenshot.png",
        absolutePath: "/workspace/uploads/screenshot.png",
        fileName: "screenshot.png",
        kind: "image",
        sizeBytes: 12,
      },
    ],
    "client-submit-1",
    {
      thinkingEnabled: false,
      nativeWebSearchEnabled: true,
      reasoning: "medium",
    },
  ]);
  assert.ok(chatCalls[0][4] instanceof AbortSignal);

  globalThis.onconnect = previousOnConnect;
});

test("GatewayWebSocketClient sends mention query payloads", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const mentionPromise = client.listMentionFiles("/workspace", 200, "src");
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "mentions envelope");
  assert.equal(socket.sent[1].type, "mentions.list");
  assert.deepEqual(socket.sent[1].payload, {
    workdir: "/workspace",
    max_results: 200,
    query: "src",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { entries: [{ path: "src/main.ts", kind: "file" }], truncated: false },
  });

  assert.deepEqual(await mentionPromise, {
    entries: [{ path: "src/main.ts", kind: "file" }],
    truncated: false,
  });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends memory manage payloads", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const memoryPromise = client.memoryManage({
    command: "memory_search",
    args: { query: "Kevin", limit: 3 },
  });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "memory envelope");
  assert.equal(socket.sent[1].type, "memory.manage");
  assert.deepEqual(socket.sent[1].payload, {
    command: "memory_search",
    args: { query: "Kevin", limit: 3 },
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { matches: [], usedFallback: false },
  });

  assert.deepEqual(await memoryPromise, { matches: [], usedFallback: false });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient retries recoverable memory manage commands after a clean disconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const updatePromise = client.memoryManage({
    command: "memory_organize_run_update",
    args: {
      runId: "run-1",
      safeApplied: 2,
      trimmedProtocol: {
        manualApplyState: { status: "applied" },
      },
    },
  });

  const firstSocket = await connectAndAuth(0);
  await waitFor(
    () => firstSocket.sent.some((item) => item.type === "memory.manage"),
    "initial memory update envelope",
  );
  const firstRequest = firstSocket.sent.find((item) => item.type === "memory.manage");
  assert.deepEqual(firstRequest.payload, {
    command: "memory_organize_run_update",
    args: {
      runId: "run-1",
      safeApplied: 2,
      trimmedProtocol: {
        manualApplyState: { status: "applied" },
      },
    },
  });

  firstSocket.close({ code: 1000, wasClean: true });
  await waitFor(() => FakeWebSocket.instances.length === 2, "memory update recovery websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "memory update recovery auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "memory.manage"),
    "retried memory update envelope",
  );

  const retriedRequest = reconnectSocket.sent.find((item) => item.type === "memory.manage");
  assert.deepEqual(retriedRequest.payload, firstRequest.payload);
  const payload = {
    runId: "run-1",
    status: "succeeded",
    trimmedProtocol: {
      manualApplyState: { status: "applied" },
    },
  };
  reconnectSocket.receive({
    id: retriedRequest.id,
    type: "response",
    payload,
  });

  assert.deepEqual(await updatePromise, payload);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not replay memory apply batch after a disconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const applyPromise = client.memoryManage({
    command: "memory_apply_batch",
    args: {
      trigger: "memory-organize",
      decisions: [
        {
          op: "delete",
          slug: "stale-memory",
          scope: "project",
        },
      ],
    },
  });

  const socket = await connectAndAuth(0);
  await waitFor(
    () => socket.sent.some((item) => item.type === "memory.manage"),
    "memory apply envelope",
  );
  socket.close({ code: 1000, wasClean: true });

  await assert.rejects(
    applyPromise,
    /Gateway WebSocket disconnected \(code=1000 clean=true\)/,
  );
  assert.equal(FakeWebSocket.instances.length, 1);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends skill manage payloads", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const skillPromise = client.manageSkill({
    action: "list",
  });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "skill manage envelope");
  assert.equal(socket.sent[1].type, "skills.manage");
  assert.deepEqual(socket.sent[1].payload, {
    action: "list",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { action: "list", rootDir: "/Users/me/.liveagent/skills", skills: [] },
  });

  assert.deepEqual(await skillPromise, {
    action: "list",
    rootDir: "/Users/me/.liveagent/skills",
    skills: [],
  });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends history share requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const getPromise = client.getHistoryShare("conversation-1");
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "history share get envelope");
  assert.equal(socket.sent[1].type, "history.share.get");
  assert.deepEqual(socket.sent[1].payload, {
    conversation_id: "conversation-1",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: {
      conversation_id: "conversation-1",
      enabled: false,
      token: "",
      created_at: 0,
      updated_at: 0,
    },
  });
  assert.deepEqual(await getPromise, {
    conversation_id: "conversation-1",
    enabled: false,
    token: "",
    created_at: 0,
    updated_at: 0,
  });

  const setPromise = client.setHistoryShare("conversation-1", true, {
    redactToolContent: true,
  });
  await waitFor(() => socket.sent.length >= 3, "history share set envelope");
  assert.equal(socket.sent[2].type, "history.share.set");
  assert.deepEqual(socket.sent[2].payload, {
    conversation_id: "conversation-1",
    enabled: true,
    redact_tool_content: true,
  });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: {
      conversation_id: "conversation-1",
      enabled: true,
      token: "share-token",
      created_at: 10,
      updated_at: 20,
      redact_tool_content: true,
    },
  });
  assert.deepEqual(await setPromise, {
    conversation_id: "conversation-1",
    enabled: true,
    token: "share-token",
    created_at: 10,
    updated_at: 20,
    redact_tool_content: true,
  });

  resetGatewayWebSocketClient();
});

test("Gateway SharedWorker forwards history share requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    statusListeners = [];
    historyListeners = [];
    conversationListeners = [];
    settingsListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus(listener) {
      this.statusListeners.push(listener);
      return () => {};
    }

    subscribeHistory(listener) {
      this.historyListeners.push(listener);
      return () => {};
    }

    subscribeConversation(listener) {
      this.conversationListeners.push(listener);
      return () => {};
    }

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    getHistoryShare(conversationID) {
      this.calls.push(["getHistoryShare", conversationID]);
      return {
        conversation_id: conversationID,
        enabled: false,
        token: "",
        created_at: 0,
        updated_at: 0,
      };
    }

    setHistoryShare(conversationID, enabled, options) {
      this.calls.push(["setHistoryShare", conversationID, enabled, options]);
      return {
        conversation_id: conversationID,
        enabled,
        token: enabled ? "share-token" : "",
        created_at: 10,
        updated_at: 20,
        redact_tool_content: options?.redactToolContent === true,
      };
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: " token " });
  assert.equal(clientInstances.length, 1);

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "share-get",
    method: "history.share.get",
    payload: { conversation_id: "conversation-1" },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "share-get"),
    "shared worker history share get response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["getHistoryShare", "conversation-1"]);
  assert.deepEqual(port.messages.at(-1), {
    type: "response",
    connection_id: "connection-1",
    request_id: "share-get",
    payload: {
      conversation_id: "conversation-1",
      enabled: false,
      token: "",
      created_at: 0,
      updated_at: 0,
    },
    error: undefined,
  });

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "share-set",
    method: "history.share.set",
    payload: {
      conversation_id: "conversation-1",
      enabled: true,
      redact_tool_content: true,
    },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "share-set"),
    "shared worker history share set response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "setHistoryShare",
    "conversation-1",
    true,
    { redactToolContent: true },
  ]);
  assert.deepEqual(port.messages.at(-1), {
    type: "response",
    connection_id: "connection-1",
    request_id: "share-set",
    payload: {
      conversation_id: "conversation-1",
      enabled: true,
      token: "share-token",
      created_at: 10,
      updated_at: 20,
      redact_tool_content: true,
    },
    error: undefined,
  });

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards chat.attach streams to the requesting port", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    statusListeners = [];
    historyListeners = [];
    conversationListeners = [];
    settingsListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus(listener) {
      this.statusListeners.push(listener);
      return () => {};
    }

    subscribeHistory(listener) {
      this.historyListeners.push(listener);
      return () => {};
    }

    subscribeConversation(listener) {
      this.conversationListeners.push(listener);
      return () => {};
    }

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    async *attachChat(conversationID, options) {
      this.calls.push(["attachChat", conversationID, options.afterSeq]);
      yield {
        type: "token",
        text: "replayed",
        conversation_id: conversationID,
        seq: 8,
      };
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: " token " });
  assert.equal(clientInstances.length, 1);

  port.emit({
    type: "chat.attach",
    connection_id: "connection-1",
    request_id: "attach-req",
    stream_id: "attach-stream",
    conversation_id: "conversation-1",
    after_seq: 7,
  });

  await waitFor(
    () => port.messages.some((message) => message.request_id === "attach-req"),
    "shared worker chat attach response",
  );
  assert.deepEqual(port.messages.find((message) => message.request_id === "attach-req"), {
    type: "response",
    connection_id: "connection-1",
    request_id: "attach-req",
    payload: { ok: true },
    error: undefined,
  });
  await waitFor(
    () => port.messages.some((message) => message.type === "chat-event"),
    "shared worker chat attach event",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["attachChat", "conversation-1", 7]);
  assert.deepEqual(port.messages.find((message) => message.type === "chat-event"), {
    type: "chat-event",
    connection_id: "connection-1",
    stream_id: "attach-stream",
    payload: {
      type: "token",
      text: "replayed",
      conversation_id: "conversation-1",
      seq: 8,
    },
  });

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards conversation cancel without a stream id", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const cancelCalls = [];

  class MockGatewayWebSocketClient {
    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeConversation() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    async cancelChat(conversationID) {
      cancelCalls.push(conversationID);
    }

    dispose() {}
  }

  const workerLoader = createWebModuleLoader({
    mocks: {
      [gatewaySocketPath]: {
        GatewayWebSocketClient: MockGatewayWebSocketClient,
      },
    },
  });

  const previousOnConnect = globalThis.onconnect;
  workerLoader.loadModule("src/lib/gatewaySocket.worker.ts");

  const port = new FakeMessagePort();
  globalThis.onconnect({ ports: [port] });
  port.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  port.emit({
    type: "chat.cancel",
    connection_id: "connection-1",
    stream_id: "",
    conversation_id: " conversation-1 ",
  });

  await waitFor(() => cancelCalls.length === 1, "shared worker cancel call");
  assert.deepEqual(cancelCalls, ["conversation-1"]);

  globalThis.onconnect = previousOnConnect;
});

test("GatewayWebSocketClient resumes an active chat stream after reconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const stream = client.chat("hello", "conversation-1");
  const firstEventPromise = stream.next();
  const firstSocket = await connectAndAuth(0);
  await waitFor(() => firstSocket.sent.length >= 2, "chat.start envelope");
  const chatStart = firstSocket.sent[1];
  assert.equal(chatStart.type, "chat.start");

  firstSocket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 1,
    },
  });
  assert.deepEqual(await firstEventPromise, {
    value: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 1,
    },
    done: false,
  });

  const replayPromise = stream.next();
  firstSocket.close();
  await waitFor(() => FakeWebSocket.instances.length === 2, "reconnect websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "reconnect auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "chat.resume"),
    "chat.resume envelope",
  );
  const resume = reconnectSocket.sent.find((item) => item.type === "chat.resume");
  assert.deepEqual(resume.payload, {
    request_id: chatStart.id,
    conversation_id: "conversation-1",
    after_seq: 1,
  });

  reconnectSocket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 2,
    },
  });
  assert.deepEqual(await replayPromise, {
    value: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 2,
    },
    done: false,
  });

  const donePromise = stream.next();
  reconnectSocket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: { type: "done", conversation_id: "conversation-1", seq: 3 },
  });
  assert.deepEqual(await donePromise, {
    value: { type: "done", conversation_id: "conversation-1", seq: 3 },
    done: false,
  });
  assert.deepEqual(await stream.next(), { value: undefined, done: true });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient attachChat replays by conversation id and reattaches after reconnect", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const stream = client.attachChat(" conversation-1 ", { afterSeq: 1 });
  const firstEventPromise = stream.next();
  const firstSocket = await connectAndAuth(0);
  await waitFor(() => firstSocket.sent.length >= 2, "chat.attach envelope");
  const firstAttach = firstSocket.sent[1];
  assert.equal(firstAttach.type, "chat.attach");
  assert.deepEqual(firstAttach.payload, {
    conversation_id: "conversation-1",
    after_seq: 1,
  });

  firstSocket.receive({
    id: firstAttach.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 2,
    },
  });
  assert.deepEqual(await firstEventPromise, {
    value: {
      type: "token",
      text: "first",
      conversation_id: "conversation-1",
      seq: 2,
    },
    done: false,
  });

  const replayPromise = stream.next();
  firstSocket.close();
  await waitFor(() => FakeWebSocket.instances.length === 2, "attach reconnect websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "attach reconnect auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "chat.attach"),
    "reattach envelope",
  );
  const reattach = reconnectSocket.sent.find((item) => item.type === "chat.attach");
  assert.deepEqual(reattach.payload, {
    conversation_id: "conversation-1",
    after_seq: 2,
  });

  reconnectSocket.receive({
    id: firstAttach.id,
    type: "chat.event",
    payload: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 3,
    },
  });
  assert.deepEqual(await replayPromise, {
    value: {
      type: "token",
      text: "second",
      conversation_id: "conversation-1",
      seq: 3,
    },
    done: false,
  });

  const closePromise = stream.return();
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "chat.detach"),
    "chat.detach envelope",
  );
  const detach = reconnectSocket.sent.find((item) => item.type === "chat.detach");
  assert.deepEqual(detach.payload, { request_id: firstAttach.id });
  assert.deepEqual(await closePromise, { value: undefined, done: true });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient reconnects before read requests when an authenticated socket goes stale", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const realDateNow = Date.now;
  try {
    const client = getGatewayWebSocketClient("token");
    const statusPromise = client.getStatus();
    const firstSocket = await connectAndAuth();
    await waitFor(() => firstSocket.sent.some((item) => item.type === "status.get"), "initial status.get");
    const statusRequest = firstSocket.sent.find((item) => item.type === "status.get");
    firstSocket.receive({
      id: statusRequest.id,
      type: "response",
      payload: { online: true, agent_id: "desktop-agent" },
    });
    await statusPromise;

    let mockNow = realDateNow();
    Date.now = () => mockNow;
    mockNow += 30_000;

    const historyPromise = client.getHistory("conversation-1");
    assert.equal(FakeWebSocket.instances.length, 2);

    Date.now = realDateNow;

    const reconnectSocket = FakeWebSocket.instances[1];
    reconnectSocket.open();
    await waitFor(() => reconnectSocket.sent.length >= 1, "stale reconnect auth envelope");
    reconnectSocket.receive({
      id: reconnectSocket.sent[0].id,
      type: "response",
      payload: { ok: true },
    });
    await waitFor(
      () => reconnectSocket.sent.some((item) => item.type === "history.get"),
      "history request after stale reconnect",
    );

    const historyRequest = reconnectSocket.sent.find((item) => item.type === "history.get");
    assert.deepEqual(historyRequest.payload, {
      conversation_id: "conversation-1",
    });

    const payload = {
      conversation_id: "conversation-1",
      messages_json: "[]",
      total_message_count: 0,
      returned_message_count: 0,
      has_more: false,
    };
    reconnectSocket.receive({
      id: historyRequest.id,
      type: "response",
      payload,
    });

    assert.deepEqual(await historyPromise, payload);
  } finally {
    Date.now = realDateNow;
    resetGatewayWebSocketClient();
  }
});

test("GatewayWebSocketClient retries history.get after a recoverable transport stall timeout", async () => {
  const realSetTimeout = setTimeout;
  installBrowser({
    setTimeout: (fn, delay, ...args) =>
      realSetTimeout(fn, delay >= 30_000 ? 0 : delay, ...args),
  });
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const historyPromise = client.getHistory("conversation-1");
  const firstSocket = await connectAndAuth();
  await waitFor(
    () => firstSocket.sent.some((item) => item.type === "history.get"),
    "initial history.get envelope",
  );

  await waitFor(() => FakeWebSocket.instances.length === 2, "timeout recovery websocket");
  const reconnectSocket = FakeWebSocket.instances[1];
  reconnectSocket.open();
  await waitFor(() => reconnectSocket.sent.length >= 1, "timeout recovery auth envelope");
  reconnectSocket.receive({
    id: reconnectSocket.sent[0].id,
    type: "response",
    payload: { ok: true },
  });
  await waitFor(
    () => reconnectSocket.sent.some((item) => item.type === "history.get"),
    "retried history.get envelope",
  );

  const historyRequest = reconnectSocket.sent.find((item) => item.type === "history.get");
  const payload = {
    conversation_id: "conversation-1",
    messages_json: "[]",
    total_message_count: 0,
    returned_message_count: 0,
    has_more: false,
  };
  reconnectSocket.receive({
    id: historyRequest.id,
    type: "response",
    payload,
  });

  assert.deepEqual(await historyPromise, payload);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not open chat streams for pre-aborted signals", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const chatController = new AbortController();
  chatController.abort();
  const chatStream = client.chat("hello", "conversation-1", undefined, undefined, chatController.signal);
  assert.deepEqual(await chatStream.next(), { value: undefined, done: true });

  const attachController = new AbortController();
  attachController.abort();
  const attachStream = client.attachChat("conversation-1", { signal: attachController.signal });
  assert.deepEqual(await attachStream.next(), { value: undefined, done: true });

  assert.equal(FakeWebSocket.instances.length, 0);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient suppresses transient recoverable disconnect status errors", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusEvents = [];
  const unsubscribe = client.subscribeStatus((status, error) => {
    statusEvents.push({ status, error });
  });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.some((item) => item.type === "status.get"), "status envelope");
  const statusRequest = socket.sent.find((item) => item.type === "status.get");
  socket.receive({
    id: statusRequest.id,
    type: "response",
    payload: { online: true, agent_id: "desktop-agent" },
  });
  await waitFor(
    () => statusEvents.some((event) => event.status?.online === true),
    "online status event",
  );

  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    statusEvents.some((event) =>
      String(event.error ?? "").includes("Gateway WebSocket disconnected"),
    ),
    false,
  );

  unsubscribe();
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient replies to gateway websocket pings", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusPromise = client.getStatus();
  const socket = await connectAndAuth();
  socket.receive({
    type: "ping",
    payload: { timestamp: 123 },
  });
  await waitFor(() => socket.sent.some((item) => item.type === "pong"), "pong envelope");
  const pong = socket.sent.find((item) => item.type === "pong");
  assert.deepEqual(pong.payload, { timestamp: 123 });

  await waitFor(() => socket.sent.some((item) => item.type === "status.get"), "status envelope");
  const statusRequest = socket.sent.find((item) => item.type === "status.get");
  socket.receive({
    id: statusRequest.id,
    type: "response",
    payload: { online: true, agent_id: "desktop-agent" },
  });
  await statusPromise;
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient chat generator yields scoped stream events until done", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const stream = client.chat(
    "hello",
    "",
    { customProviderId: "claude-provider", model: "claude-test", providerType: "claude_code" },
    { executionMode: "agent-dev", workdir: "/workspace", selectedSystemTools: ["http_get_test"] },
    undefined,
    [
      {
        relativePath: "uploads/notes.txt",
        absolutePath: "/workspace/uploads/notes.txt",
        fileName: "notes.txt",
        kind: "text",
        sizeBytes: 12,
      },
      {
        relativePath: "uploads/screenshot.webp",
        absolutePath: "/workspace/uploads/screenshot.webp",
        fileName: "screenshot.webp",
        kind: "image",
        sizeBytes: 34,
      },
      {
        relativePath: "uploads/report.pdf",
        absolutePath: "/workspace/uploads/report.pdf",
        fileName: "report.pdf",
        kind: "pdf",
        sizeBytes: 56,
      },
    ],
    "client-submit-1",
    {
      thinkingEnabled: false,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
    },
  );
  const firstEventPromise = stream.next();
  await waitFor(() => FakeWebSocket.instances.length === 1, "websocket construction");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "auth envelope");
  socket.receive({ id: socket.sent[0].id, type: "response", payload: { ok: true } });
  await waitFor(() => socket.sent.length >= 2, "chat.start envelope");

  const chatStart = socket.sent[1];
  assert.equal(chatStart.type, "chat.start");
  assert.equal(chatStart.payload.message, "hello");
  assert.equal(chatStart.payload.client_request_id, "client-submit-1");
  assert.equal(chatStart.payload.execution_mode, "agent-dev");
  assert.equal(chatStart.payload.workdir, "/workspace");
  assert.deepEqual(chatStart.payload.selected_system_tools, ["http_get_test"]);
  assert.deepEqual(chatStart.payload.selected_model, {
    custom_provider_id: "claude-provider",
    model: "claude-test",
    provider_type: "claude_code",
  });
  assert.deepEqual(chatStart.payload.runtime_controls, {
    thinking_enabled: false,
    native_web_search_enabled: true,
    reasoning: "xhigh",
  });
  assert.deepEqual(chatStart.payload.uploaded_files, [
    {
      relative_path: "uploads/notes.txt",
      absolute_path: "/workspace/uploads/notes.txt",
      file_name: "notes.txt",
      kind: "text",
      size_bytes: 12,
    },
    {
      relative_path: "uploads/screenshot.webp",
      absolute_path: "/workspace/uploads/screenshot.webp",
      file_name: "screenshot.webp",
      kind: "image",
      size_bytes: 34,
    },
    {
      relative_path: "uploads/report.pdf",
      absolute_path: "/workspace/uploads/report.pdf",
      file_name: "report.pdf",
      kind: "pdf",
      size_bytes: 56,
    },
  ]);

  socket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: { type: "token", text: "hi", conversation_id: "conversation-1" },
  });
  assert.deepEqual(await firstEventPromise, {
    value: { type: "token", text: "hi", conversation_id: "conversation-1" },
    done: false,
  });

  const donePromise = stream.next();
  socket.receive({
    id: chatStart.id,
    type: "chat.event",
    payload: { type: "done", conversation_id: "conversation-1" },
  });
  assert.deepEqual(await donePromise, {
    value: { type: "done", conversation_id: "conversation-1" },
    done: false,
  });
  assert.deepEqual(await stream.next(), { value: undefined, done: true });

  resetGatewayWebSocketClient();
});
