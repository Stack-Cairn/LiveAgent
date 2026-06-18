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
  const windowListeners = new Map();
  const documentListeners = new Map();
  const addListener = (listeners, type, listener) => {
    const items = listeners.get(type) ?? new Set();
    items.add(listener);
    listeners.set(type, items);
  };
  const removeListener = (listeners, type, listener) => {
    listeners.get(type)?.delete(listener);
  };
  const dispatch = (listeners, event) => {
    const type = event?.type;
    if (typeof type !== "string") return;
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  globalThis.window = {
    location: { origin: "https://gateway.example" },
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    setInterval: options.setInterval ?? setInterval,
    clearInterval: options.clearInterval ?? clearInterval,
    addEventListener: (type, listener) => addListener(windowListeners, type, listener),
    removeEventListener: (type, listener) => removeListener(windowListeners, type, listener),
    dispatchEvent: (event) => {
      dispatch(windowListeners, event);
      return true;
    },
  };
  globalThis.document = {
    visibilityState: options.visibilityState ?? "visible",
    addEventListener: (type, listener) => addListener(documentListeners, type, listener),
    removeEventListener: (type, listener) => removeListener(documentListeners, type, listener),
    dispatchEvent: (event) => {
      dispatch(documentListeners, event);
      return true;
    },
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

test("GatewayWebSocketClient sends git requests with workdir and args", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const gitPromise = client.gitRequest("diff", "/workspace/project", { mode: "branch" });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.some((message) => message.type === "git.diff"), "git.diff envelope");
  const request = socket.sent.find((message) => message.type === "git.diff");
  assert.deepEqual(request.payload, {
    workdir: "/workspace/project",
    args: { mode: "branch" },
  });
  socket.receive({
    id: request.id,
    type: "response",
    payload: { patch: "diff --git a/file b/file" },
  });

  assert.deepEqual(await gitPromise, { patch: "diff --git a/file b/file" });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not recover mutating git requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const stagePromise = client.gitRequest("stage", "/workspace/project", { path: "src/main.rs" });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.some((message) => message.type === "git.stage"), "git.stage envelope");
  socket.close({ code: 1006, wasClean: false });

  await assert.rejects(stagePromise, /Gateway WebSocket disconnected/);
  assert.equal(FakeWebSocket.instances.length, 1);
  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client sends conversation cancel directly over HTTP", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (rawUrl, init = {}) => {
    fetchCalls.push({ url: new URL(String(rawUrl)), init });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  try {
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
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url.toString(), "https://gateway.example/api/chat/commands");
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer token");
    assert.equal(fetchCalls[0].init.headers["X-LiveAgent-CSRF"], "1");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      type: "chat.cancel",
      payload: {
        conversation_id: "conversation-1",
      },
    });
    assert.equal(
      port.messages.some((message) => message.type === "request" && message.method === "chat.cancel"),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
    resetGatewayWebSocketClient();
  }
});

test("GatewayWebSocketClient streamChatEvents sends replay cursor", async () => {
  installBrowser();
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    fetchCalls.push({ url, init });
    if (url.pathname !== "/api/chat/events") {
      return new Response(JSON.stringify({ error: `unexpected ${url.pathname}` }), { status: 404 });
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'id: 42\nevent: chat.event\ndata: {"seq":42,"payload":{"type":"done","conversation_id":"conversation-1"}}\n\n',
          ),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  try {
    const client = getGatewayWebSocketClient(" token ");
    const events = [];
    for await (const event of client.streamChatEvents(" conversation-1 ", { afterSeq: 41 })) {
      events.push(event);
    }

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url.pathname, "/api/chat/events");
    assert.equal(fetchCalls[0].url.searchParams.get("conversation_id"), "conversation-1");
    assert.equal(fetchCalls[0].url.searchParams.get("after_seq"), "41");
    assert.equal(fetchCalls[0].init.method, "GET");
    assert.equal(fetchCalls[0].init.headers.Accept, "text/event-stream");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer token");
    assert.equal(fetchCalls[0].init.headers["Last-Event-ID"], "41");
    assert.deepEqual(events, [{ type: "done", conversation_id: "conversation-1", seq: 42 }]);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    resetGatewayWebSocketClient();
  }
});

test("GatewayWebSocketClient streamChatEvents resumes from the last delivered event id", async () => {
  installBrowser({
    setTimeout: (fn, _delay, ...args) => setTimeout(fn, 0, ...args),
  });
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    fetchCalls.push({ url, init });
    if (url.pathname !== "/api/chat/events") {
      return new Response(JSON.stringify({ error: `unexpected ${url.pathname}` }), { status: 404 });
    }
    const attempt = fetchCalls.length;
    const body = new ReadableStream({
      start(controller) {
        if (attempt === 1) {
          controller.enqueue(
            encoder.encode(
              'id: 42\nevent: chat.event\ndata: {"seq":42,"payload":{"type":"token","text":"hello","conversation_id":"conversation-1"}}\n\n',
            ),
          );
        } else {
          controller.enqueue(
            encoder.encode(
              'id: 42\nevent: chat.event\ndata: {"seq":42,"payload":{"type":"token","text":"duplicate","conversation_id":"conversation-1"}}\n\n' +
                'id: 43\nevent: chat.event\ndata: {"seq":43,"payload":{"type":"done","conversation_id":"conversation-1"}}\n\n',
            ),
          );
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  try {
    const client = getGatewayWebSocketClient(" token ");
    const events = [];
    for await (const event of client.streamChatEvents(" conversation-1 ", { afterSeq: 41 })) {
      events.push(event);
    }

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].url.searchParams.get("after_seq"), "41");
    assert.equal(fetchCalls[0].init.headers["Last-Event-ID"], "41");
    assert.equal(fetchCalls[1].url.searchParams.get("after_seq"), "42");
    assert.equal(fetchCalls[1].init.headers["Last-Event-ID"], "42");
    assert.deepEqual(events, [
      { type: "token", text: "hello", conversation_id: "conversation-1", seq: 42 },
      { type: "done", conversation_id: "conversation-1", seq: 43 },
    ]);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    resetGatewayWebSocketClient();
  }
});

test("GatewayWebSocketClient streamChatEvents ignores stale terminal events from older runs", async () => {
  installBrowser();
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    fetchCalls.push({ url, init });
    if (url.pathname !== "/api/chat/events") {
      return new Response(JSON.stringify({ error: `unexpected ${url.pathname}` }), { status: 404 });
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'id: 3\nevent: chat.event\ndata: {"run_id":"old-run","snapshot_run_id":"live-run","seq":3,"payload":{"type":"done","conversation_id":"conversation-1"}}\n\n' +
              'id: 4\nevent: chat.event\ndata: {"run_id":"live-run","snapshot_run_id":"live-run","seq":4,"payload":{"type":"token","text":"second","conversation_id":"conversation-1"}}\n\n' +
              'id: 5\nevent: chat.event\ndata: {"run_id":"live-run","snapshot_run_id":"live-run","seq":5,"payload":{"type":"done","conversation_id":"conversation-1"}}\n\n',
          ),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  try {
    const client = getGatewayWebSocketClient(" token ");
    const events = [];
    for await (const event of client.streamChatEvents(" conversation-1 ", { afterSeq: 0 })) {
      events.push(event);
    }

    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(events, [
      { type: "token", text: "second", conversation_id: "conversation-1", seq: 4 },
      { type: "done", conversation_id: "conversation-1", seq: 5 },
    ]);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    resetGatewayWebSocketClient();
  }
});

test("SharedWorker gateway client forwards foreground wakeups to the worker", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  getGatewayWebSocketClient(" token ");
  assert.equal(FakeSharedWorker.instances.length, 1);
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  assert.ok(connect);
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  window.dispatchEvent({ type: "pageshow" });

  assert.deepEqual(port.messages.at(-1), {
    type: "wakeup",
    connection_id: connect.connection_id,
  });

  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client accepts terminal list sessions from worker payload", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  assert.ok(connect);
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  const sessionsPromise = client.listTerminals("/workspace/project");
  await waitFor(
    () => port.messages.some((message) => message.method === "terminal.list"),
    "shared worker terminal.list request",
  );
  const request = port.messages.find((message) => message.method === "terminal.list");
  assert.deepEqual(request.payload, { project_path_key: "/workspace/project" });

  port.emit({
    type: "response",
    connection_id: connect.connection_id,
    request_id: request.request_id,
    payload: {
      sessions: [
        {
          id: "terminal-1",
          project_path_key: "/workspace/project",
          cwd: "/workspace/project",
          title: "Terminal 1",
          created_at: 1,
          updated_at: 2,
          running: true,
        },
      ],
    },
  });

  const sessions = await sessionsPromise;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "terminal-1");
  assert.equal(sessions[0].projectPathKey, "/workspace/project");
  assert.equal(sessions[0].title, "Terminal 1");

  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client keeps SSH create snapshots from worker payload", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const port = FakeSharedWorker.instances[0].port;
  const connect = port.messages.find((message) => message.type === "connect");
  port.emit({
    type: "ready",
    connection_id: connect.connection_id,
    payload: { status: { online: true }, error: null },
  });

  const createPromise = client.createSshTerminal({
    cwd: "/workspace/project",
    projectPathKey: "project-key",
    hostId: "host-1",
  });
  await waitFor(
    () => port.messages.some((message) => message.type === "request" && message.method === "terminal.create_ssh"),
    "terminal.create_ssh worker request",
  );
  const request = port.messages.find((message) => message.type === "request" && message.method === "terminal.create_ssh");
  assert.ok(request);
  assert.deepEqual(request.payload, {
    cwd: "/workspace/project",
    project_path_key: "project-key",
    ssh_host_id: "host-1",
    title: undefined,
    cols: undefined,
    rows: undefined,
    sftp_enabled: false,
  });
  port.emit({
    type: "response",
    connection_id: connect.connection_id,
    request_id: request.request_id,
    payload: {
      snapshot: {
        session: {
          id: "ssh-1",
          projectPathKey: "project-key",
          cwd: "/workspace/project",
          shell: "ssh",
          title: "Claw-SG",
          kind: "ssh",
          ssh: {
            hostId: "host-1",
            hostName: "Claw-SG",
            username: "root",
            host: "8.219.204.112",
            port: 22,
            authType: "privateKey",
            status: "connected",
            reconnectAttempt: 0,
            reconnectMaxAttempts: 3,
          },
          pid: null,
          cols: 80,
          rows: 24,
          createdAt: 10,
          updatedAt: 10,
          running: true,
        },
        output: "root@s878169:~# ",
        truncated: false,
        outputStartOffset: 0,
        outputEndOffset: 18,
      },
    },
  });

  const result = await createPromise;
  assert.equal(result.snapshot?.session.id, "ssh-1");
  assert.equal(result.snapshot?.session.ssh?.hostId, "host-1");
  assert.equal(result.snapshot?.output, "root@s878169:~# ");
  resetGatewayWebSocketClient();
});

test("SharedWorker gateway client posts chat commands directly over HTTP", async () => {
  installBrowser();
  FakeSharedWorker.instances = [];
  globalThis.SharedWorker = FakeSharedWorker;
  const realFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const fetchCalls = [];
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    fetchCalls.push({ url, init });
    if (url.pathname === "/api/chat/commands") {
      return new Response(
        JSON.stringify({
          run_id: "run-1",
          conversation_id: "conversation-1",
          accepted_seq: 1,
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.pathname === "/api/chat/events") {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'id: 1\nevent: chat.event\ndata: {"seq":1,"payload":{"type":"done","conversation_id":"conversation-1"}}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ error: `unexpected ${url.pathname}` }), { status: 404 });
  };
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  try {
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

    const events = [];
    for await (const event of client.commandChat({
      type: "chat.submit",
      message: "hello",
      conversationId: "conversation-1",
      selectedModel: {
        customProviderId: "claude-provider",
        model: "claude-test",
        providerType: "claude_code",
      },
      systemSettings: {
        executionMode: "agent-dev",
        workdir: "/workspace",
        selectedSystemTools: ["http_get_test"],
      },
      uploadedFiles: [
        {
          relativePath: "uploads/notes.txt",
          absolutePath: "/workspace/uploads/notes.txt",
          fileName: "notes.txt",
          kind: "text",
          sizeBytes: 12,
        },
      ],
      clientRequestId: "client-submit-1",
      runtimeControls: {
        thinkingEnabled: false,
        nativeWebSearchEnabled: true,
        reasoning: "xhigh",
      },
    })) {
      events.push(event);
    }

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].url.toString(), "https://gateway.example/api/chat/commands");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      type: "chat.submit",
      payload: {
        message: "hello",
        conversation_id: "conversation-1",
        client_request_id: "client-submit-1",
        execution_mode: "agent-dev",
        workdir: "/workspace",
        selected_system_tools: ["http_get_test"],
        uploaded_files: [
          {
            relative_path: "uploads/notes.txt",
            absolute_path: "/workspace/uploads/notes.txt",
            file_name: "notes.txt",
            kind: "text",
            size_bytes: 12,
          },
        ],
        selected_model: {
          custom_provider_id: "claude-provider",
          model: "claude-test",
          provider_type: "claude_code",
        },
        runtime_controls: {
          thinking_enabled: false,
          native_web_search_enabled: true,
          reasoning: "xhigh",
        },
      },
    });
    assert.equal(fetchCalls[1].url.pathname, "/api/chat/events");
    assert.equal(fetchCalls[1].url.searchParams.get("run_id"), "run-1");
    assert.deepEqual(events, [{ type: "done", conversation_id: "conversation-1", seq: 1 }]);
    const legacyWorkerChatCommand = "chat" + ".command";
    assert.equal(
      port.messages.some(
        (message) => message.type === "request" && message.method === legacyWorkerChatCommand,
      ),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
    resetGatewayWebSocketClient();
  }
});

test("Gateway SharedWorker broadcasts events with each port connection id", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    statusListeners = [];
    historyListeners = [];
    settingsListeners = [];
    sftpTransferListeners = [];

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

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    subscribeSftpTransfers(listener) {
      this.sftpTransferListeners.push(listener);
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

  const sftpEvent = {
    kind: "progress",
    transfer: {
      id: "transfer-1",
      sessionId: "ssh-1",
      status: "running",
      bytesTransferred: 12,
      totalBytes: 24,
    },
  };
  clientInstances[0].sftpTransferListeners[0](sftpEvent);

  assert.deepEqual(firstPort.messages.at(-1), {
    type: "event",
    event_type: "sftp",
    connection_id: "connection-1",
    payload: sftpEvent,
  });
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "event",
    event_type: "sftp",
    connection_id: "connection-2",
    payload: sftpEvent,
  });

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker applies foreground wakeups to the managed socket client", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    wakeups = 0;

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    subscribeSftpTransfers() {
      return () => {};
    }

    noteForegroundWakeup() {
      this.wakeups += 1;
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
  port.emit({ type: "wakeup", connection_id: "connection-1" });

  assert.equal(clientInstances.length, 1);
  assert.equal(clientInstances[0].wakeups, 1);

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker terminal metadata reaches every page while output stays scoped", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    terminalListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal(listener) {
      this.terminalListeners.push(listener);
      return () => {};
    }

    subscribeSftpTransfers() {
      return () => {};
    }

    async listTerminals(projectPathKey) {
      this.calls.push(["listTerminals", projectPathKey ?? ""]);
      return [
        {
          id: "terminal-1",
          projectPathKey: "/workspace/project-a",
          cwd: "/workspace/project-a",
          shell: "zsh",
          title: "Terminal 1",
          cols: 80,
          rows: 24,
          createdAt: 1,
          updatedAt: 1,
          running: true,
        },
      ];
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

  const firstPort = new FakeMessagePort();
  const secondPort = new FakeMessagePort();
  globalThis.onconnect({ ports: [firstPort] });
  globalThis.onconnect({ ports: [secondPort] });
  firstPort.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  secondPort.emit({ type: "connect", connection_id: "connection-2", token: "token" });

  firstPort.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "terminal-list-all",
    method: "terminal.list",
    payload: {},
  });
  await waitFor(
    () => firstPort.messages.some((message) => message.request_id === "terminal-list-all"),
    "terminal list all response",
  );
  assert.deepEqual(clientInstances[0].calls, [["listTerminals", ""]]);
  const listResponse = firstPort.messages.find(
    (message) => message.request_id === "terminal-list-all",
  );
  assert.equal(listResponse.payload.sessions[0].id, "terminal-1");

  const event = {
    kind: "created",
    sessionId: "terminal-2",
    projectPathKey: "/workspace/project-b",
    session: {
      id: "terminal-2",
      projectPathKey: "/workspace/project-b",
      cwd: "/workspace/project-b",
      shell: "zsh",
      title: "Terminal 2",
      cols: 80,
      rows: 24,
      createdAt: 2,
      updatedAt: 2,
      running: true,
    },
  };
  clientInstances[0].terminalListeners[0](event);

  assert.deepEqual(firstPort.messages.at(-1), {
    type: "event",
    event_type: "terminal",
    payload: event,
    connection_id: "connection-1",
  });
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "event",
    event_type: "terminal",
    payload: event,
    connection_id: "connection-2",
  });

  const outputEvent = {
    ...event,
    kind: "output",
    data: "secret\n",
  };
  clientInstances[0].terminalListeners[0](outputEvent);

  assert.equal(
    firstPort.messages.some((message) => message.payload === outputEvent),
    false,
  );
  assert.equal(
    secondPort.messages.some((message) => message.payload === outputEvent),
    false,
  );

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker forwards terminal output while attach request is pending", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];
  let resolveSnapshot = null;

  class MockGatewayWebSocketClient {
    terminalListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal(listener) {
      this.terminalListeners.push(listener);
      return () => {};
    }

    subscribeSftpTransfers() {
      return () => {};
    }

    snapshotTerminal(sessionId, maxBytes, projectPathKey) {
      this.calls.push(["snapshotTerminal", sessionId, maxBytes, projectPathKey]);
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
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
    type: "request",
    connection_id: "connection-1",
    request_id: "terminal-attach",
    method: "terminal.attach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () => clientInstances[0]?.calls.some((call) => call[0] === "snapshotTerminal"),
    "terminal attach request",
  );

  const event = {
    kind: "output",
    sessionId: "terminal-1",
    projectPathKey: "/workspace/project",
    session: {
      id: "terminal-1",
      projectPathKey: "/workspace/project",
      cwd: "/workspace/project",
      shell: "zsh",
      title: "Terminal 1",
      cols: 80,
      rows: 24,
      createdAt: 1,
      updatedAt: 2,
      running: true,
    },
    data: "pwd\r\n",
    outputStartOffset: 10,
    outputEndOffset: 15,
  };
  clientInstances[0].terminalListeners[0](event);
  await waitFor(
    () =>
      port.messages.some(
        (message) => message.event_type === "terminal" && message.payload === event,
      ),
    "attach-pending terminal output",
  );

  resolveSnapshot({
    session: event.session,
    output: "",
    truncated: false,
    outputStartOffset: 15,
    outputEndOffset: 15,
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "terminal-attach"),
    "terminal attach response",
  );

  globalThis.onconnect = previousOnConnect;
});

test("Gateway SharedWorker keeps upstream terminal attached until every port detaches", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    terminalListeners = [];
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal(listener) {
      this.terminalListeners.push(listener);
      return () => {};
    }

    subscribeSftpTransfers() {
      return () => {};
    }

    async snapshotTerminal(sessionId, maxBytes, projectPathKey) {
      this.calls.push(["snapshotTerminal", sessionId, maxBytes, projectPathKey]);
      return {
        session: {
          id: sessionId,
          projectPathKey,
          cwd: projectPathKey,
          shell: "zsh",
          title: "Terminal 1",
          cols: 80,
          rows: 24,
          createdAt: 1,
          updatedAt: 1,
          running: true,
        },
        output: "",
        truncated: false,
        outputStartOffset: 0,
        outputEndOffset: 0,
      };
    }

    async detachTerminal(sessionId, projectPathKey) {
      this.calls.push(["detachTerminal", sessionId, projectPathKey]);
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

  const firstPort = new FakeMessagePort();
  const secondPort = new FakeMessagePort();
  globalThis.onconnect({ ports: [firstPort] });
  globalThis.onconnect({ ports: [secondPort] });
  firstPort.emit({ type: "connect", connection_id: "connection-1", token: "token" });
  secondPort.emit({ type: "connect", connection_id: "connection-2", token: "token" });

  firstPort.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "first-attach",
    method: "terminal.attach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  secondPort.emit({
    type: "request",
    connection_id: "connection-2",
    request_id: "second-attach",
    method: "terminal.attach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () =>
      firstPort.messages.some((message) => message.request_id === "first-attach") &&
      secondPort.messages.some((message) => message.request_id === "second-attach"),
    "terminal attach responses",
  );

  firstPort.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "first-detach",
    method: "terminal.detach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () => firstPort.messages.some((message) => message.request_id === "first-detach"),
    "first terminal detach response",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    clientInstances[0].calls.some((call) => call[0] === "detachTerminal"),
    false,
  );

  const firstPortMessageCount = firstPort.messages.length;
  const event = {
    kind: "output",
    sessionId: "terminal-1",
    projectPathKey: "/workspace/project",
    session: {
      id: "terminal-1",
      projectPathKey: "/workspace/project",
      cwd: "/workspace/project",
      shell: "zsh",
      title: "Terminal 1",
      cols: 80,
      rows: 24,
      createdAt: 1,
      updatedAt: 2,
      running: true,
    },
    data: "pwd\r\n",
  };
  clientInstances[0].terminalListeners[0](event);
  assert.equal(firstPort.messages.length, firstPortMessageCount);
  assert.deepEqual(secondPort.messages.at(-1), {
    type: "event",
    event_type: "terminal",
    payload: event,
    connection_id: "connection-2",
  });

  secondPort.emit({
    type: "request",
    connection_id: "connection-2",
    request_id: "second-detach",
    method: "terminal.detach",
    payload: {
      session_id: "terminal-1",
      project_path_key: "/workspace/project",
    },
  });
  await waitFor(
    () => clientInstances[0].calls.some((call) => call[0] === "detachTerminal"),
    "upstream terminal detach",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "detachTerminal",
    "terminal-1",
    "/workspace/project",
  ]);

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

test("GatewayWebSocketClient sends history list requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const listPromise = client.listHistory(2, 50);
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "history list envelope");
  assert.equal(socket.sent[1].type, "history.list");
  assert.deepEqual(socket.sent[1].payload, { page: 2, page_size: 50 });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: {
      conversations: [],
      total_count: 0,
      running_conversation_ids: ["conversation-running"],
      running_conversations: [
        {
          conversation_id: "conversation-running",
          cwd: "/tmp/project-a",
          updated_at: 123,
        },
      ],
    },
  });
  assert.deepEqual(await listPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: ["conversation-running"],
    running_conversations: [
      {
        conversation_id: "conversation-running",
        cwd: "/tmp/project-a",
        updated_at: 123,
      },
    ],
  });

  const sharedListPromise = client.listSharedHistory(1, 25);
  await waitFor(() => socket.sent.length >= 3, "shared history list envelope");
  assert.equal(socket.sent[2].type, "history.shared_list");
  assert.deepEqual(socket.sent[2].payload, { page: 1, page_size: 25 });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: { conversations: [], total_count: 0 },
  });
  assert.deepEqual(await sharedListPromise, { conversations: [], total_count: 0 });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends project-aware history and fs requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const filteredListPromise = client.listHistory(3, 25, { cwd: "/tmp/project-a" });
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "filtered history list envelope");
  assert.equal(socket.sent[1].type, "history.list");
  assert.deepEqual(socket.sent[1].payload, {
    page: 3,
    page_size: 25,
    cwd: "/tmp/project-a",
  });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { conversations: [], total_count: 0, running_conversation_ids: [] },
  });
  assert.deepEqual(await filteredListPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: [],
  });

  const chatModeListPromise = client.listHistory(1, 80, { cwdEmpty: true });
  await waitFor(() => socket.sent.length >= 3, "cwd empty history list envelope");
  assert.equal(socket.sent[2].type, "history.list");
  assert.deepEqual(socket.sent[2].payload, {
    page: 1,
    page_size: 80,
    cwd_empty: true,
  });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: { conversations: [], total_count: 0, running_conversation_ids: [] },
  });
  assert.deepEqual(await chatModeListPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: [],
  });

  const workdirsPromise = client.listHistoryWorkdirs();
  await waitFor(() => socket.sent.length >= 4, "history workdirs envelope");
  assert.equal(socket.sent[3].type, "history.workdirs");
  assert.deepEqual(socket.sent[3].payload, {});
  socket.receive({
    id: socket.sent[3].id,
    type: "response",
    payload: {
      workdirs: [
        { path: "/tmp/project-a", conversation_count: 2, updated_at: 1700000000300 },
      ],
    },
  });
  assert.deepEqual(await workdirsPromise, {
    workdirs: [
      { path: "/tmp/project-a", conversationCount: 2, updatedAt: 1700000000300 },
    ],
  });

  const createPromise = client.createProjectFolder("/tmp", "Project A");
  await waitFor(() => socket.sent.length >= 5, "create project folder envelope");
  assert.equal(socket.sent[4].type, "fs.create_project_folder");
  assert.deepEqual(socket.sent[4].payload, { parent: "/tmp", name: "Project A" });
  socket.receive({
    id: socket.sent[4].id,
    type: "response",
    payload: { path: "/tmp/Project A" },
  });
  assert.deepEqual(await createPromise, { path: "/tmp/Project A" });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient defaults invalid history pagination", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const listPromise = client.listHistory(0, 0);
  const socket = await connectAndAuth();
  await waitFor(() => socket.sent.length >= 2, "history list envelope");
  assert.equal(socket.sent[1].type, "history.list");
  assert.deepEqual(socket.sent[1].payload, { page: 1, page_size: 80 });
  socket.receive({
    id: socket.sent[1].id,
    type: "response",
    payload: { conversations: [], total_count: 0, running_conversation_ids: [] },
  });
  assert.deepEqual(await listPromise, {
    conversations: [],
    total_count: 0,
    running_conversation_ids: [],
  });

  const sharedListPromise = client.listSharedHistory(Number.NaN, 500);
  await waitFor(() => socket.sent.length >= 3, "shared history list envelope");
  assert.equal(socket.sent[2].type, "history.shared_list");
  assert.deepEqual(socket.sent[2].payload, { page: 1, page_size: 200 });
  socket.receive({
    id: socket.sent[2].id,
    type: "response",
    payload: { conversations: [], total_count: 0 },
  });
  assert.deepEqual(await sharedListPromise, { conversations: [], total_count: 0 });

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

    subscribeSettings(listener) {
      this.settingsListeners.push(listener);
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    subscribeSftpTransfers() {
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

test("Gateway SharedWorker forwards tunnel requests", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const gatewaySocketPath = loader.resolveLocal("src/lib/gatewaySocket.ts");
  const clientInstances = [];

  class MockGatewayWebSocketClient {
    calls = [];

    constructor(token) {
      this.token = token;
      clientInstances.push(this);
    }

    subscribeStatus() {
      return () => {};
    }

    subscribeHistory() {
      return () => {};
    }

    subscribeSettings() {
      return () => {};
    }

    subscribeTerminal() {
      return () => {};
    }

    subscribeSftpTransfers() {
      return () => {};
    }

    listTunnels() {
      this.calls.push(["listTunnels"]);
      return [
        {
          id: "tun-1",
          slug: "slug-1",
          name: "App",
          targetUrl: "http://localhost:3000",
          publicUrl: "https://gateway.example/t/slug-1/",
          createdAt: 10,
          expiresAt: 3700,
          activeConnections: 0,
          status: "active",
        },
      ];
    }

    createTunnel(input) {
      this.calls.push(["createTunnel", input]);
      return {
        id: "tun-2",
        slug: "slug-2",
        name: input.name ?? "",
        targetUrl: input.targetUrl,
        publicUrl: "https://gateway.example/t/slug-2/",
        createdAt: 20,
        expiresAt: 920,
        activeConnections: 0,
        status: "active",
      };
    }

    updateTunnel(input) {
      this.calls.push(["updateTunnel", input]);
      return {
        id: input.id,
        slug: "slug-2",
        name: input.name ?? "",
        targetUrl: input.targetUrl,
        publicUrl: "https://gateway.example/t/slug-2/",
        createdAt: 20,
        expiresAt: input.ttlSeconds === 0 ? 0 : 920,
        activeConnections: 0,
        status: "active",
        projectPathKey: input.projectPathKey ?? "",
      };
    }

    closeTunnel(id) {
      this.calls.push(["closeTunnel", id]);
      return {
        id,
        slug: "slug-2",
        name: "Closed",
        targetUrl: "http://localhost:3000",
        publicUrl: "https://gateway.example/t/slug-2/",
        createdAt: 20,
        expiresAt: 920,
        activeConnections: 0,
        status: "expired",
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
    request_id: "tunnel-list",
    method: "tunnel.list",
    payload: {},
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-list"),
    "shared worker tunnel list response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["listTunnels"]);
  assert.equal(port.messages.at(-1).payload.tunnels[0].id, "tun-1");

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "tunnel-create",
    method: "tunnel.create",
    payload: {
      targetUrl: "http://localhost:3000/app",
      ttlSeconds: 900,
      name: "App",
    },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-create"),
    "shared worker tunnel create response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "createTunnel",
    {
      targetUrl: "http://localhost:3000/app",
      ttlSeconds: 900,
      name: "App",
    },
  ]);
  assert.equal(port.messages.at(-1).payload.tunnel.id, "tun-2");

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "tunnel-update-infinite",
    method: "tunnel.update",
    payload: {
      id: "tun-2",
      targetUrl: "http://localhost:4000/dashboard",
      ttlSeconds: 0,
      name: "Dashboard",
      projectPathKey: "project:/tmp/liveagent",
    },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-update-infinite"),
    "shared worker tunnel update response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), [
    "updateTunnel",
    {
      id: "tun-2",
      targetUrl: "http://localhost:4000/dashboard",
      ttlSeconds: 0,
      name: "Dashboard",
      projectPathKey: "project:/tmp/liveagent",
    },
  ]);
  assert.equal(port.messages.at(-1).payload.tunnel.expiresAt, 0);
  assert.equal(port.messages.at(-1).payload.tunnel.projectPathKey, "project:/tmp/liveagent");

  port.emit({
    type: "request",
    connection_id: "connection-1",
    request_id: "tunnel-close",
    method: "tunnel.close",
    payload: { id: "tun-2" },
  });
  await waitFor(
    () => port.messages.some((message) => message.request_id === "tunnel-close"),
    "shared worker tunnel close response",
  );
  assert.deepEqual(clientInstances[0].calls.at(-1), ["closeTunnel", "tun-2"]);
  assert.equal(port.messages.at(-1).payload.tunnel.status, "expired");

  globalThis.onconnect = previousOnConnect;
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

test("GatewayWebSocketClient commandChat posts commands and streams SSE events until done", async () => {
  installBrowser();
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    fetchCalls.push({ url, init });
    if (url.pathname === "/api/chat/commands") {
      return new Response(
        JSON.stringify({
          run_id: "run-1",
          conversation_id: "conversation-1",
          accepted_seq: 1,
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.pathname === "/api/chat/events") {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'id: 1\nevent: chat.control\ndata: {"seq":1,"payload":{"type":"accepted","conversation_id":"conversation-1","seq":1}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'id: 2\nevent: chat.event\ndata: {"seq":2,"payload":{"type":"token","text":"hi","conversation_id":"conversation-1"}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'id: 3\nevent: chat.event\ndata: {"seq":3,"payload":{"type":"done","conversation_id":"conversation-1"}}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ error: `unexpected ${url.pathname}` }), { status: 404 });
  };

  const loader = createWebModuleLoader();
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  resetGatewayWebSocketClient();

  try {
    const client = getGatewayWebSocketClient(" token ");
    const events = [];
    for await (const event of client.commandChat({
      type: "chat.submit",
      message: "hello",
      conversationId: "",
      selectedModel: {
        customProviderId: "claude-provider",
        model: "claude-test",
        providerType: "claude_code",
      },
      systemSettings: {
        executionMode: "agent-dev",
        workdir: "/workspace",
        selectedSystemTools: ["http_get_test"],
      },
      uploadedFiles: [
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
      clientRequestId: "client-submit-1",
      runtimeControls: {
        thinkingEnabled: false,
        nativeWebSearchEnabled: true,
        reasoning: "xhigh",
      },
    })) {
      events.push(event);
    }

    assert.equal(fetchCalls.length, 2);
    const commandCall = fetchCalls[0];
    assert.equal(commandCall.url.toString(), "https://gateway.example/api/chat/commands");
    assert.equal(commandCall.init.method, "POST");
    assert.equal(commandCall.init.headers.Authorization, "Bearer token");
    assert.equal(commandCall.init.headers["X-LiveAgent-CSRF"], "1");
    assert.deepEqual(JSON.parse(commandCall.init.body), {
      type: "chat.submit",
      payload: {
        message: "hello",
        conversation_id: "",
        client_request_id: "client-submit-1",
        execution_mode: "agent-dev",
        workdir: "/workspace",
        selected_system_tools: ["http_get_test"],
        uploaded_files: [
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
        ],
        selected_model: {
          custom_provider_id: "claude-provider",
          model: "claude-test",
          provider_type: "claude_code",
        },
        runtime_controls: {
          thinking_enabled: false,
          native_web_search_enabled: true,
          reasoning: "xhigh",
        },
      },
    });

    const eventsCall = fetchCalls[1];
    assert.equal(eventsCall.url.pathname, "/api/chat/events");
    assert.equal(eventsCall.url.searchParams.get("run_id"), "run-1");
    assert.equal(eventsCall.url.searchParams.get("conversation_id"), "conversation-1");
    assert.equal(eventsCall.url.searchParams.get("after_seq"), "0");
    assert.equal(eventsCall.init.method, "GET");
    assert.equal(eventsCall.init.headers.Accept, "text/event-stream");
    assert.equal(eventsCall.init.headers.Authorization, "Bearer token");
    assert.deepEqual(events, [
      { type: "accepted", conversation_id: "conversation-1", seq: 1 },
      { type: "token", text: "hi", conversation_id: "conversation-1", seq: 2 },
      { type: "done", conversation_id: "conversation-1", seq: 3 },
    ]);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    resetGatewayWebSocketClient();
  }
});
