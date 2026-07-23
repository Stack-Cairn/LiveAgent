import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayV2Codec } from "../helpers/gateway-v2.mjs";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

// FakeWebSocket 以 v2 服务端身份说话：收发全部为二进制 protobuf 帧。
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  readyState = FakeWebSocket.CONNECTING;
  sent = [];
  binaryType = "blob";
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(raw) {
    this.sent.push(raw);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receiveBinary(data) {
    this.onmessage?.({ data });
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

function loadGatewaySocket() {
  const loader = createWebModuleLoader();
  const codec = createGatewayV2Codec(loader);
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loader.loadModule(
    "src/lib/gatewaySocket.ts",
  );
  return { loader, codec, getGatewayWebSocketClient, resetGatewayWebSocketClient };
}

function frames(codec, socket) {
  return socket.sent.map((raw) => codec.decodeClientFrame(raw));
}

// 查找第一条命中指定直通臂的 agent_request 帧。
function findAgentRequest(codec, socket, arm) {
  return frames(codec, socket).find(
    (frame) => frame.case === "agentRequest" && frame.json.agent_request?.[arm] !== undefined,
  );
}

function findFrame(codec, socket, frameCase) {
  return frames(codec, socket).find((frame) => frame.case === frameCase);
}

async function connectAndAuth(codec, index = 0) {
  await waitFor(() => FakeWebSocket.instances.length > index, "websocket construction");
  const socket = FakeWebSocket.instances[index];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "hello frame");
  assert.equal(socket.url, "wss://gateway.example/ws/v2");
  assert.equal(socket.protocols, "liveagent.v2.pb");
  assert.equal(socket.binaryType, "arraybuffer");
  const hello = codec.decodeClientFrame(socket.sent[0]);
  assert.equal(hello.case, "hello");
  assert.equal(hello.json.hello.protocol_version, 2);
  assert.equal(hello.json.hello.token, "token");
  assert.equal(hello.json.hello.client_name, "webui");
  socket.receiveBinary(codec.encodeServerFrame({ request_id: hello.requestId, hello: { ok: true } }));
  if (index === 0) {
    await waitFor(() => findFrame(codec, socket, "agentList"), "agent_list frame");
    const listRequest = findFrame(codec, socket, "agentList");
    socket.receiveBinary(
      codec.encodeServerFrame({
        request_id: listRequest.requestId,
        agent_list: { agents: [{ agent_id: "desktop-agent", online: true }] },
      }),
    );
  }
  return socket;
}

// history.list 现在并行发出 chat_activities 帧；用网关状态应答它。
function answerChatActivities(codec, socket, running = [], answered = new Set()) {
  for (const frame of frames(codec, socket)) {
    if (frame.case !== "chatActivities" || answered.has(frame.requestId)) continue;
    answered.add(frame.requestId);
    socket.receiveBinary(
      codec.encodeServerFrame({
        request_id: frame.requestId,
        chat_activities: { running_conversations: running },
      }),
    );
  }
}

test("GatewayWebSocketClient authenticates via hello and sends status_get over /ws/v2", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const statusPromise = client.getStatus();
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "statusGet"), "status_get frame");
  const statusRequest = findFrame(codec, socket, "statusGet");
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: statusRequest.requestId,
      status: { online: true, agent_id: "desktop-agent" },
    }),
  );

  const status = await statusPromise;
  assert.equal(status.online, true);
  assert.equal(status.agent_id, "desktop-agent");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient surfaces hello rejection as an auth error without reconnect loops", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusPromise = assert.rejects(client.getStatus(), /unauthorized/);
  await waitFor(() => FakeWebSocket.instances.length === 1, "websocket construction");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "hello frame");
  const hello = codec.decodeClientFrame(socket.sent[0]);
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: hello.requestId,
      hello: { ok: false, message: "unauthorized" },
    }),
  );
  await statusPromise;
  socket.close({ code: 4401, reason: "unauthorized" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeWebSocket.instances.length, 1, "bad token must not trigger a reconnect loop");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient bounds the complete WebSocket connection attempt", async () => {
  const timers = createManualTimers();
  installBrowser({ ...timers });
  const { getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusResult = assert.rejects(client.getStatus(), /Gateway WebSocket connection timed out/);
  await waitFor(() => FakeWebSocket.instances.length === 1, "connecting websocket");
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.readyState, FakeWebSocket.CONNECTING);

  timers.fire((timer) => timer.ms === 10_000);
  await statusResult;
  assert.equal(socket.readyState, FakeWebSocket.CLOSED, "timed-out attempt was abandoned");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends chat_prepare with the caller reason", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const preparePromise = client.prepareChatRuntime("composer-focus");
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "chatPrepare"), "chat_prepare frame");
  const prepareRequest = findFrame(codec, socket, "chatPrepare");
  assert.deepEqual(prepareRequest.json.chat_prepare, { reason: "composer-focus" });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: prepareRequest.requestId,
      status: { online: true, chat_runtime_ready: true, runtime_state: "ready" },
    }),
  );

  const prepared = await preparePromise;
  assert.equal(prepared.online, true);
  assert.equal(prepared.chat_runtime_ready, true);
  assert.equal(prepared.runtime_state, "ready");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient falls back to status_get when chat_prepare is unsupported", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const preparePromise = client.prepareChatRuntime("foreground");
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "chatPrepare"), "chat_prepare frame");
  const prepareRequest = findFrame(codec, socket, "chatPrepare");
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: prepareRequest.requestId,
      local_error: { message: "unsupported request type" },
    }),
  );
  await waitFor(() => findFrame(codec, socket, "statusGet"), "fallback status_get frame");
  const statusRequest = findFrame(codec, socket, "statusGet");
  socket.receiveBinary(
    codec.encodeServerFrame({ request_id: statusRequest.requestId, status: { online: true } }),
  );

  assert.equal((await preparePromise).online, true);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient clears a timed-out prepare so the next wake can retry", async () => {
  const timers = createManualTimers();
  installBrowser({ ...timers });
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const firstResult = assert.rejects(client.prepareChatRuntime("foreground"), /Gateway/);
  const firstSocket = await connectAndAuth(codec, 0);
  await waitFor(() => findFrame(codec, firstSocket, "chatPrepare"), "first chat_prepare frame");
  timers.fire((timer) => timer.ms === 2_500);
  await firstResult;

  const secondPrepare = client.prepareChatRuntime("send");
  const secondSocket = await connectAndAuth(codec, 1);
  await waitFor(() => findFrame(codec, secondSocket, "chatPrepare"), "second chat_prepare frame");
  const secondRequest = findFrame(codec, secondSocket, "chatPrepare");
  assert.deepEqual(secondRequest.json.chat_prepare, { reason: "send" });
  secondSocket.receiveBinary(
    codec.encodeServerFrame({
      request_id: secondRequest.requestId,
      status: { online: true, chat_runtime_ready: true },
    }),
  );
  assert.equal((await secondPrepare).chat_runtime_ready, true);
  resetGatewayWebSocketClient();
});

const terminalTestSession = {
  id: "terminal-1",
  projectPathKey: "/workspace/project",
  cwd: "/workspace/project",
  shell: "zsh",
  title: "Terminal 1",
  kind: "local",
  cols: 80,
  rows: 24,
  createdAt: 1,
  updatedAt: 2,
  running: true,
};

const terminalProtoSession = {
  id: "terminal-1",
  project_path_key: "/workspace/project",
  cwd: "/workspace/project",
  shell: "zsh",
  title: "Terminal 1",
  kind: "local",
  cols: 80,
  rows: 24,
  created_at: 1,
  updated_at: 2,
  running: true,
};

async function connectTerminalStream(codec, index = 0) {
  await waitFor(() => FakeWebSocket.instances.length > index, "terminal stream socket");
  const socket = FakeWebSocket.instances[index];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "terminal stream hello");
  assert.equal(socket.url, "wss://gateway.example/ws/v2/terminal");
  assert.equal(socket.protocols, "liveagent.v2.pb");
  const hello = codec.decodeTerminalClientFrame(socket.sent[0]);
  assert.equal(hello.case, "hello");
  assert.equal(hello.json.hello.token, "token");
  assert.equal(hello.json.hello.role, "CLIENT_ROLE_BROWSER");
  assert.equal(hello.json.hello.agent_id, "desktop-agent");
  socket.receiveBinary(codec.encodeTerminalServerFrame({ hello: { ok: true } }));
  return socket;
}

test("BrowserGatewayTerminalStreamClient connects to /ws/v2/terminal and attaches with protobuf frames", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const codec = createGatewayV2Codec(loader);
  const { BrowserGatewayTerminalStreamClient } = loader.loadModule(
    "src/lib/terminal/gatewayTerminalStreamClient.ts",
  );

  const client = new BrowserGatewayTerminalStreamClient("token", () => "desktop-agent");
  const attachPromise = client.attach(terminalTestSession, { maxBytes: 8192 });
  const socket = await connectTerminalStream(codec);
  await waitFor(() => socket.sent.length >= 2, "terminal stream attach frame");
  const attach = codec.decodeTerminalClientFrame(socket.sent[1]);
  assert.equal(attach.case, "frame");
  assert.equal(attach.json.frame.kind, "attach");
  assert.equal(attach.json.frame.session_id, "terminal-1");
  assert.equal(attach.json.frame.project_path_key, "/workspace/project");
  assert.equal(attach.json.frame.max_bytes, 8192);

  socket.receiveBinary(
    codec.encodeTerminalServerFrame({
      frame: {
        kind: "snapshot",
        stream_id: attach.json.frame.stream_id,
        session_id: "terminal-1",
        project_path_key: "/workspace/project",
        session: terminalProtoSession,
        start_offset: 10,
        end_offset: 13,
        data: codec.base64(new Uint8Array([112, 119, 100])),
      },
    }),
  );
  const handle = await attachPromise;
  assert.equal(handle.snapshot.session.id, "terminal-1");
  assert.deepEqual([...handle.snapshot.bytes], [112, 119, 100]);
  assert.equal(handle.snapshot.outputStartOffset, 10);
  handle.dispose();
  client.dispose();
});

test("BrowserGatewayTerminalStreamClient retries attach while desktop stream is offline", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const codec = createGatewayV2Codec(loader);
  const { BrowserGatewayTerminalStreamClient } = loader.loadModule(
    "src/lib/terminal/gatewayTerminalStreamClient.ts",
  );

  const client = new BrowserGatewayTerminalStreamClient("token", () => "desktop-agent");
  const attachPromise = client.attach(terminalTestSession);
  const socket = await connectTerminalStream(codec);
  await waitFor(() => socket.sent.length >= 2, "terminal stream attach frame");
  const firstAttach = codec.decodeTerminalClientFrame(socket.sent[1]);

  socket.receiveBinary(
    codec.encodeTerminalServerFrame({
      frame: {
        kind: "error",
        stream_id: firstAttach.json.frame.stream_id,
        session_id: "terminal-1",
        error: "desktop agent is offline",
      },
    }),
  );

  await waitFor(() => socket.sent.length >= 3, "retry terminal stream attach frame");
  const retryAttach = codec.decodeTerminalClientFrame(socket.sent[2]);
  assert.equal(retryAttach.json.frame.kind, "attach");
  assert.equal(retryAttach.json.frame.stream_id, firstAttach.json.frame.stream_id);
  assert.equal(retryAttach.json.frame.session_id, "terminal-1");

  socket.receiveBinary(
    codec.encodeTerminalServerFrame({
      frame: {
        kind: "snapshot",
        stream_id: retryAttach.json.frame.stream_id,
        session_id: "terminal-1",
        session: terminalProtoSession,
        end_offset: 2,
        data: codec.base64(new Uint8Array([111, 107])),
      },
    }),
  );
  const handle = await attachPromise;
  assert.deepEqual([...handle.snapshot.bytes], [111, 107]);
  handle.dispose();
  client.dispose();
});

test("BrowserGatewayTerminalStreamClient rejects the attach when the hello is refused", async () => {
  installBrowser();
  const loader = createWebModuleLoader();
  const codec = createGatewayV2Codec(loader);
  const { BrowserGatewayTerminalStreamClient } = loader.loadModule(
    "src/lib/terminal/gatewayTerminalStreamClient.ts",
  );

  const client = new BrowserGatewayTerminalStreamClient("token", () => "desktop-agent");
  const attachPromise = assert.rejects(client.attach(terminalTestSession), /unauthorized/);
  await waitFor(() => FakeWebSocket.instances.length >= 1, "terminal stream socket");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await waitFor(() => socket.sent.length >= 1, "terminal stream hello");
  socket.receiveBinary(
    codec.encodeTerminalServerFrame({ hello: { ok: false, message: "unauthorized" } }),
  );
  await attachPromise;
  client.dispose();
});

test("GatewayWebSocketClient sends git requests with workdir and args", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const gitPromise = client.gitRequest("diff", "/workspace/project", { mode: "branch" });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "git_request"), "git_request frame");
  const request = findAgentRequest(codec, socket, "git_request");
  assert.equal(request.json.agent_request.git_request.action, "diff");
  assert.equal(request.json.agent_request.git_request.workdir, "/workspace/project");
  assert.deepEqual(JSON.parse(request.json.agent_request.git_request.args_json), {
    mode: "branch",
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: request.requestId,
      agent_response: {
        git_response: { result_json: JSON.stringify({ patch: "diff --git a/file b/file" }) },
      },
    }),
  );

  assert.deepEqual(await gitPromise, { patch: "diff --git a/file b/file" });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not recover mutating git requests", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient(" token ");
  const stagePromise = client.gitRequest("stage", "/workspace/project", { path: "src/main.rs" });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "git_request"), "git_request frame");
  assert.equal(findAgentRequest(codec, socket, "git_request").json.agent_request.git_request.action, "stage");
  socket.close({ code: 1006, wasClean: false });

  await assert.rejects(stagePromise, /Gateway WebSocket disconnected/);
  assert.equal(FakeWebSocket.instances.length, 1);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends mention query payloads", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const mentionPromise = client.listMentionFiles("/workspace", 200, "src");
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "file_mention_list"), "mentions frame");
  const request = findAgentRequest(codec, socket, "file_mention_list");
  assert.deepEqual(request.json.agent_request.file_mention_list, {
    workdir: "/workspace",
    max_results: 200,
    query: "src",
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: request.requestId,
      agent_response: {
        file_mention_list_resp: {
          entries: [{ path: "src/main.ts", kind: "file" }],
          truncated: false,
        },
      },
    }),
  );

  assert.deepEqual(await mentionPromise, {
    entries: [{ path: "src/main.ts", kind: "file", hidden: false }],
    truncated: false,
  });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends memory manage payloads", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const memoryPromise = client.memoryManage({
    command: "memory_search",
    args: { query: "Kevin", limit: 3 },
  });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "memory_manage"), "memory frame");
  const request = findAgentRequest(codec, socket, "memory_manage");
  assert.equal(request.json.agent_request.memory_manage.command, "memory_search");
  assert.deepEqual(JSON.parse(request.json.agent_request.memory_manage.args_json), {
    query: "Kevin",
    limit: 3,
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: request.requestId,
      agent_response: {
        memory_manage_resp: {
          result_json: JSON.stringify({ matches: [], usedFallback: false }),
        },
      },
    }),
  );

  assert.deepEqual(await memoryPromise, { matches: [], usedFallback: false });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient retries recoverable memory manage commands after a clean disconnect", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
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

  const firstSocket = await connectAndAuth(codec, 0);
  await waitFor(
    () => findAgentRequest(codec, firstSocket, "memory_manage"),
    "initial memory update frame",
  );
  const firstRequest = findAgentRequest(codec, firstSocket, "memory_manage");
  assert.equal(firstRequest.json.agent_request.memory_manage.command, "memory_organize_run_update");

  firstSocket.close({ code: 1000, wasClean: true });
  await waitFor(() => FakeWebSocket.instances.length === 2, "memory update recovery websocket");
  const reconnectSocket = await connectAndAuth(codec, 1);
  await waitFor(
    () => findAgentRequest(codec, reconnectSocket, "memory_manage"),
    "retried memory update frame",
  );

  const retriedRequest = findAgentRequest(codec, reconnectSocket, "memory_manage");
  assert.deepEqual(
    retriedRequest.json.agent_request.memory_manage,
    firstRequest.json.agent_request.memory_manage,
  );
  const payload = {
    runId: "run-1",
    status: "succeeded",
    trimmedProtocol: {
      manualApplyState: { status: "applied" },
    },
  };
  reconnectSocket.receiveBinary(
    codec.encodeServerFrame({
      request_id: retriedRequest.requestId,
      agent_response: { memory_manage_resp: { result_json: JSON.stringify(payload) } },
    }),
  );

  assert.deepEqual(await updatePromise, payload);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient does not replay memory apply batch after a disconnect", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
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

  const socket = await connectAndAuth(codec, 0);
  await waitFor(() => findAgentRequest(codec, socket, "memory_manage"), "memory apply frame");
  socket.close({ code: 1000, wasClean: true });

  await assert.rejects(applyPromise, /Gateway WebSocket disconnected \(code=1000 clean=true\)/);
  assert.equal(FakeWebSocket.instances.length, 1);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends skill manage payloads", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const skillPromise = client.manageSkill({ action: "list" });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "skill_manage"), "skill manage frame");
  const request = findAgentRequest(codec, socket, "skill_manage");
  assert.deepEqual(JSON.parse(request.json.agent_request.skill_manage.payload_json), {
    action: "list",
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: request.requestId,
      agent_response: {
        skill_manage_resp: {
          result_json: JSON.stringify({
            action: "list",
            rootDir: "/Users/me/.liveagent/skills",
            skills: [],
          }),
        },
      },
    }),
  );

  assert.deepEqual(await skillPromise, {
    action: "list",
    rootDir: "/Users/me/.liveagent/skills",
    skills: [],
  });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends history list requests and merges running conversations", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const listPromise = client.listHistory(2, 50);
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "history_list"), "history list frame");
  const listRequest = findAgentRequest(codec, socket, "history_list");
  assert.deepEqual(listRequest.json.agent_request.history_list, { page: 2, page_size: 50 });
  await waitFor(() => findFrame(codec, socket, "chatActivities"), "chat_activities frame");
  answerChatActivities(codec, socket, [
    {
      conversation_id: "conversation-running",
      run_id: "run-running",
      state: "running",
      workdir: "/tmp/project-a",
      updated_at_ms: 123,
    },
  ]);
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: listRequest.requestId,
      agent_response: { history_list_resp: { conversations: [], total_count: 0 } },
    }),
  );
  assert.deepEqual(await listPromise, {
    conversations: [],
    total_count: 0,
    running_conversations: [
      {
        conversation_id: "conversation-running",
        run_id: "run-running",
        state: "running",
        cwd: "/tmp/project-a",
        updated_at: 123,
      },
    ],
  });

  const sharedListPromise = client.listSharedHistory(1, 25);
  await waitFor(() => findAgentRequest(codec, socket, "memory_manage"), "shared history frame");
  const sharedRequest = findAgentRequest(codec, socket, "memory_manage");
  assert.equal(sharedRequest.json.agent_request.memory_manage.command, "history_shared_list");
  assert.deepEqual(JSON.parse(sharedRequest.json.agent_request.memory_manage.args_json), {
    page: 1,
    page_size: 25,
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: sharedRequest.requestId,
      agent_response: {
        memory_manage_resp: {
          result_json: JSON.stringify({ conversations: [], total_count: 0 }),
        },
      },
    }),
  );
  assert.deepEqual(await sharedListPromise, { conversations: [], total_count: 0 });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends project-aware history and fs requests", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const answeredActivities = new Set();
  const client = getGatewayWebSocketClient("token");
  const filteredListPromise = client.listHistory(3, 25, { cwd: "/tmp/project-a" });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "history_list"), "filtered history frame");
  const filteredRequest = findAgentRequest(codec, socket, "history_list");
  assert.deepEqual(filteredRequest.json.agent_request.history_list, {
    page: 3,
    page_size: 25,
    cwd: "/tmp/project-a",
  });
  answerChatActivities(codec, socket, [], answeredActivities);
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: filteredRequest.requestId,
      agent_response: { history_list_resp: { conversations: [], total_count: 0 } },
    }),
  );
  assert.deepEqual(await filteredListPromise, {
    conversations: [],
    total_count: 0,
    running_conversations: [],
  });

  const chatModeListPromise = client.listHistory(1, 80, { cwdEmpty: true });
  await waitFor(
    () =>
      frames(codec, socket).filter(
        (frame) => frame.case === "agentRequest" && frame.json.agent_request?.history_list,
      ).length >= 2,
    "cwd empty history frame",
  );
  const chatModeRequest = frames(codec, socket)
    .filter((frame) => frame.case === "agentRequest" && frame.json.agent_request?.history_list)
    .at(-1);
  assert.deepEqual(chatModeRequest.json.agent_request.history_list, {
    page: 1,
    page_size: 80,
    cwd_empty: true,
  });
  answerChatActivities(codec, socket, [], answeredActivities);
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: chatModeRequest.requestId,
      agent_response: { history_list_resp: { conversations: [], total_count: 0 } },
    }),
  );
  assert.deepEqual(await chatModeListPromise, {
    conversations: [],
    total_count: 0,
    running_conversations: [],
  });

  const workdirsPromise = client.listHistoryWorkdirs();
  await waitFor(() => findAgentRequest(codec, socket, "history_workdirs"), "history workdirs frame");
  const workdirsRequest = findAgentRequest(codec, socket, "history_workdirs");
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: workdirsRequest.requestId,
      agent_response: {
        history_workdirs_resp: {
          workdirs: [
            { path: "/tmp/project-a", conversation_count: 2, updated_at: 1700000000300 },
          ],
        },
      },
    }),
  );
  assert.deepEqual(await workdirsPromise, {
    workdirs: [{ path: "/tmp/project-a", conversationCount: 2, updatedAt: 1700000000300 }],
  });

  const createPromise = client.createProjectFolder("/tmp", "Project A");
  await waitFor(
    () => findAgentRequest(codec, socket, "fs_create_project_folder"),
    "create project folder frame",
  );
  const createRequest = findAgentRequest(codec, socket, "fs_create_project_folder");
  assert.deepEqual(createRequest.json.agent_request.fs_create_project_folder, {
    parent: "/tmp",
    name: "Project A",
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: createRequest.requestId,
      agent_response: { fs_create_project_folder_resp: { path: "/tmp/Project A" } },
    }),
  );
  assert.deepEqual(await createPromise, { path: "/tmp/Project A" });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient defaults invalid history pagination", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const listPromise = client.listHistory(0, 0);
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "history_list"), "history list frame");
  const listRequest = findAgentRequest(codec, socket, "history_list");
  assert.deepEqual(listRequest.json.agent_request.history_list, { page: 1, page_size: 80 });
  answerChatActivities(codec, socket);
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: listRequest.requestId,
      agent_response: { history_list_resp: { conversations: [], total_count: 0 } },
    }),
  );
  assert.deepEqual(await listPromise, {
    conversations: [],
    total_count: 0,
    running_conversations: [],
  });

  const sharedListPromise = client.listSharedHistory(Number.NaN, 500);
  await waitFor(() => findAgentRequest(codec, socket, "memory_manage"), "shared list frame");
  const sharedRequest = findAgentRequest(codec, socket, "memory_manage");
  assert.deepEqual(JSON.parse(sharedRequest.json.agent_request.memory_manage.args_json), {
    page: 1,
    page_size: 200,
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: sharedRequest.requestId,
      agent_response: {
        memory_manage_resp: {
          result_json: JSON.stringify({ conversations: [], total_count: 0 }),
        },
      },
    }),
  );
  assert.deepEqual(await sharedListPromise, { conversations: [], total_count: 0 });

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient sends history share requests", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const getPromise = client.getHistoryShare("conversation-1");
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "history_share_get"), "share get frame");
  const getRequest = findAgentRequest(codec, socket, "history_share_get");
  assert.deepEqual(getRequest.json.agent_request.history_share_get, {
    conversation_id: "conversation-1",
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: getRequest.requestId,
      agent_response: {
        history_share_get_resp: {
          share: { conversation_id: "conversation-1", enabled: false },
        },
      },
    }),
  );
  assert.deepEqual(await getPromise, {
    conversation_id: "conversation-1",
    enabled: false,
    token: "",
    created_at: 0,
    updated_at: 0,
    redact_tool_content: false,
  });

  const setPromise = client.setHistoryShare("conversation-1", true, {
    redactToolContent: true,
  });
  await waitFor(() => findAgentRequest(codec, socket, "history_share_set"), "share set frame");
  const setRequest = findAgentRequest(codec, socket, "history_share_set");
  assert.deepEqual(setRequest.json.agent_request.history_share_set, {
    conversation_id: "conversation-1",
    enabled: true,
    redact_tool_content: true,
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: setRequest.requestId,
      agent_response: {
        history_share_set_resp: {
          share: {
            conversation_id: "conversation-1",
            enabled: true,
            token: "share-token",
            created_at: 10,
            updated_at: 20,
            redact_tool_content: true,
          },
        },
      },
    }),
  );
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

test("GatewayWebSocketClient sends history branch requests with the base message ref", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const branchPromise = client.branchHistory("conversation-1", {
    segmentIndex: 2,
    messageIndex: 5,
    segmentId: "segment-2",
    messageId: "message-5",
    role: "user",
    contentHash: "hash-abc",
  });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "history_branch"), "history branch frame");
  const request = findAgentRequest(codec, socket, "history_branch");
  assert.deepEqual(request.json.agent_request.history_branch, {
    conversation_id: "conversation-1",
    base_message_ref: {
      segment_index: 2,
      message_index: 5,
      segment_id: "segment-2",
      message_id: "message-5",
      role: "user",
      content_hash: "hash-abc",
    },
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: request.requestId,
      agent_response: {
        history_branch_resp: {
          conversation: {
            id: "conversation-branch",
            title: "新分支",
            message_count: 6,
            created_at: 1700000000100,
            updated_at: 1700000000200,
          },
        },
      },
    }),
  );
  const branched = await branchPromise;
  assert.equal(branched.id, "conversation-branch");
  assert.equal(branched.title, "新分支");
  assert.equal(branched.message_count, 6);
  assert.equal(branched.created_at, 1700000000100);
  assert.equal(branched.updated_at, 1700000000200);

  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient reconnects before read requests when an authenticated socket goes stale", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const realDateNow = Date.now;
  try {
    const client = getGatewayWebSocketClient("token");
    const statusPromise = client.getStatus();
    const firstSocket = await connectAndAuth(codec);
    await waitFor(() => findFrame(codec, firstSocket, "statusGet"), "initial status_get");
    const statusRequest = findFrame(codec, firstSocket, "statusGet");
    firstSocket.receiveBinary(
      codec.encodeServerFrame({
        request_id: statusRequest.requestId,
        status: { online: true, agent_id: "desktop-agent" },
      }),
    );
    await statusPromise;

    let mockNow = realDateNow();
    Date.now = () => mockNow;
    mockNow += 46_000;

    const historyPromise = client.getHistory("conversation-1");
    assert.equal(FakeWebSocket.instances.length, 2);

    Date.now = realDateNow;

    const reconnectSocket = await connectAndAuth(codec, 1);
    await waitFor(
      () => findAgentRequest(codec, reconnectSocket, "history_get"),
      "history request after stale reconnect",
    );

    const historyRequest = findAgentRequest(codec, reconnectSocket, "history_get");
    assert.deepEqual(historyRequest.json.agent_request.history_get, {
      conversation_id: "conversation-1",
    });

    reconnectSocket.receiveBinary(
      codec.encodeServerFrame({
        request_id: historyRequest.requestId,
        agent_response: {
          history_get_resp: { conversation_id: "conversation-1", messages_json: "[]" },
        },
      }),
    );

    assert.deepEqual(await historyPromise, {
      conversation_id: "conversation-1",
      messages_json: "[]",
      total_message_count: 0,
      returned_message_count: 0,
      has_more: false,
      conversation: null,
    });
  } finally {
    Date.now = realDateNow;
    resetGatewayWebSocketClient();
  }
});

test("GatewayWebSocketClient retries history.get after a recoverable transport stall timeout", async () => {
  const realSetTimeout = setTimeout;
  installBrowser({
    setTimeout: (fn, delay, ...args) => realSetTimeout(fn, delay >= 30_000 ? 0 : delay, ...args),
  });
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const historyPromise = client.getHistory("conversation-1");
  const firstSocket = await connectAndAuth(codec);
  await waitFor(
    () => findAgentRequest(codec, firstSocket, "history_get"),
    "initial history_get frame",
  );

  await waitFor(() => FakeWebSocket.instances.length === 2, "timeout recovery websocket");
  const reconnectSocket = await connectAndAuth(codec, 1);
  await waitFor(
    () => findAgentRequest(codec, reconnectSocket, "history_get"),
    "retried history_get frame",
  );

  const historyRequest = findAgentRequest(codec, reconnectSocket, "history_get");
  reconnectSocket.receiveBinary(
    codec.encodeServerFrame({
      request_id: historyRequest.requestId,
      agent_response: {
        history_get_resp: { conversation_id: "conversation-1", messages_json: "[]" },
      },
    }),
  );

  assert.equal((await historyPromise).conversation_id, "conversation-1");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient suppresses transient recoverable disconnect status errors", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusEvents = [];
  const unsubscribe = client.subscribeStatus((status, error) => {
    statusEvents.push({ status, error });
  });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "statusGet"), "status frame");
  const statusRequest = findFrame(codec, socket, "statusGet");
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: statusRequest.requestId,
      status: { online: true, agent_id: "desktop-agent" },
    }),
  );
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

test("GatewayWebSocketClient preserves client names across live status updates", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const snapshots = [];
  const unsubscribe = client.subscribeAgents((agents) => snapshots.push(agents));
  const initialList = client.listAgents();
  const socket = await connectAndAuth(codec);
  await initialList;

  const refreshedList = client.listAgents();
  await waitFor(
    () => frames(codec, socket).filter((frame) => frame.case === "agentList").length >= 2,
    "second agent_list frame",
  );
  const listRequests = frames(codec, socket).filter((frame) => frame.case === "agentList");
  const listRequest = listRequests[listRequests.length - 1];
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: listRequest.requestId,
      agent_list: {
        agents: [{ agent_id: "desktop-agent", online: true, name: "Office desktop" }],
      },
    }),
  );
  await refreshedList;

  socket.receiveBinary(
    codec.encodeServerFrame({
      agent_id: "desktop-agent",
      status: { agent_id: "desktop-agent", online: false },
    }),
  );
  await waitFor(
    () =>
      snapshots.some(
        (agents) => agents[0]?.online === false && agents[0]?.name === "Office desktop",
      ),
    "status update with preserved name",
  );

  unsubscribe();
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient replies to app-level pings with pong frames", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statusPromise = client.getStatus();
  const socket = await connectAndAuth(codec);
  socket.receiveBinary(codec.encodeServerFrame({ ping: { timestamp: 123 } }));
  await waitFor(() => findFrame(codec, socket, "pong"), "pong frame");
  const pong = findFrame(codec, socket, "pong");
  assert.equal(Number(pong.json.pong.timestamp), 123);

  await waitFor(() => findFrame(codec, socket, "statusGet"), "status frame");
  const statusRequest = findFrame(codec, socket, "statusGet");
  socket.receiveBinary(
    codec.encodeServerFrame({ request_id: statusRequest.requestId, status: { online: true } }),
  );
  await statusPromise;
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient chatCommand sends the command frame and parses the accept response", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const commandPromise = client.chatCommand({
    type: "chat.submit",
    message: "hello",
    conversationId: "conversation-1",
    clientRequestId: "req-1",
    queuePolicy: "append",
    systemSettings: {
      executionMode: "agent",
      workdir: "/workspace/project",
      selectedSystemTools: ["Bash"],
    },
  });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "chatCommand"), "chat command frame");
  const command = findFrame(codec, socket, "chatCommand");
  assert.equal(command.json.chat_command.type, "chat.submit");
  assert.equal(command.json.chat_command.request.message, "hello");
  assert.equal(command.json.chat_command.request.conversation_id, "conversation-1");
  assert.equal(command.json.chat_command.request.client_request_id, "req-1");
  assert.equal(command.json.chat_command.request.queue_policy, "append");
  assert.equal(command.json.chat_command.request.workdir, "/workspace/project");
  assert.deepEqual(command.json.chat_command.request.selected_system_tools, ["Bash"]);

  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: command.requestId,
      chat_accepted: { run_id: " run-1 ", conversation_id: "conversation-1", accepted_seq: 7 },
    }),
  );
  assert.deepEqual(await commandPromise, {
    runId: "run-1",
    conversationId: "conversation-1",
    acceptedSeq: 7,
  });
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient reconnects once and retries chatCommand with the same payload", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const commandPromise = client.chatCommand({
    type: "chat.submit",
    message: "retry me",
    conversationId: "conversation-1",
    clientRequestId: "client-retry-1",
  });
  const firstSocket = await connectAndAuth(codec, 0);
  await waitFor(() => findFrame(codec, firstSocket, "chatCommand"), "first chat command frame");
  const firstCommand = findFrame(codec, firstSocket, "chatCommand");
  firstSocket.close({ code: 1006, wasClean: false });

  const secondSocket = await connectAndAuth(codec, 1);
  await waitFor(() => findFrame(codec, secondSocket, "chatCommand"), "retried chat command frame");
  const retriedCommand = findFrame(codec, secondSocket, "chatCommand");
  assert.deepEqual(retriedCommand.json.chat_command, firstCommand.json.chat_command);
  assert.equal(
    retriedCommand.json.chat_command.request.client_request_id,
    "client-retry-1",
    "retry preserves the idempotency key",
  );
  secondSocket.receiveBinary(
    codec.encodeServerFrame({
      request_id: retriedCommand.requestId,
      chat_accepted: {
        run_id: "run-canonical",
        conversation_id: "conversation-1",
        accepted_seq: 3,
      },
    }),
  );

  assert.equal((await commandPromise).runId, "run-canonical");
  assert.equal(FakeWebSocket.instances.length, 2, "only one transparent retry is attempted");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient uses a short ACK timeout and preserves a generated client id", async () => {
  const timers = createManualTimers();
  installBrowser({ ...timers });
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const commandPromise = client.chatCommand({
    type: "chat.submit",
    message: "timeout retry",
    conversationId: "conversation-1",
  });
  const firstSocket = await connectAndAuth(codec, 0);
  await waitFor(() => findFrame(codec, firstSocket, "chatCommand"), "first chat command frame");
  const firstCommand = findFrame(codec, firstSocket, "chatCommand");
  const generatedClientRequestId = firstCommand.json.chat_command.request.client_request_id;
  assert.match(generatedClientRequestId, /^webui-chat\.submit-/);

  timers.fire((timer) => timer.ms === 4_000);
  const secondSocket = await connectAndAuth(codec, 1);
  await waitFor(() => findFrame(codec, secondSocket, "chatCommand"), "ACK-timeout retry frame");
  const retriedCommand = findFrame(codec, secondSocket, "chatCommand");
  assert.equal(
    retriedCommand.json.chat_command.request.client_request_id,
    generatedClientRequestId,
  );
  assert.deepEqual(retriedCommand.json.chat_command, firstCommand.json.chat_command);
  secondSocket.receiveBinary(
    codec.encodeServerFrame({
      request_id: retriedCommand.requestId,
      chat_accepted: { run_id: "run-timeout", conversation_id: "conversation-1", accepted_seq: 1 },
    }),
  );

  assert.equal((await commandPromise).runId, "run-timeout");
  resetGatewayWebSocketClient();
});

test("a detached socket's late close cannot tear down its replacement", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const firstStatus = client.getStatus();
  const firstSocket = await connectAndAuth(codec, 0);
  await waitFor(() => findFrame(codec, firstSocket, "statusGet"), "first status request");
  const firstStatusRequest = findFrame(codec, firstSocket, "statusGet");
  firstSocket.receiveBinary(
    codec.encodeServerFrame({ request_id: firstStatusRequest.requestId, status: { online: true } }),
  );
  await firstStatus;

  const lateClose = firstSocket.onclose;
  firstSocket.close({ code: 1006, wasClean: false });
  const secondStatus = client.getStatus();
  const secondSocket = await connectAndAuth(codec, 1);
  await waitFor(() => findFrame(codec, secondSocket, "statusGet"), "replacement status request");
  lateClose?.({ code: 1006, reason: "late old close", wasClean: false });
  const secondStatusRequest = findFrame(codec, secondSocket, "statusGet");
  secondSocket.receiveBinary(
    codec.encodeServerFrame({
      request_id: secondStatusRequest.requestId,
      status: { online: true, session_id: "replacement" },
    }),
  );

  assert.equal((await secondStatus).session_id, "replacement");
  assert.equal(FakeWebSocket.instances.length, 2);
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient cancelChat sends a cancel chat command with conversation and run ids", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const cancelPromise = client.cancelChat(" conversation-1 ", " run-9 ");
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "chatCommand"), "chat cancel frame");
  const cancelFrame = findFrame(codec, socket, "chatCommand");
  assert.equal(cancelFrame.json.chat_command.type, "chat.cancel");
  assert.deepEqual(cancelFrame.json.chat_command.cancel, {
    conversation_id: "conversation-1",
    run_id: "run-9",
  });
  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: cancelFrame.requestId,
      chat_cancelled: { ok: true, run_id: "run-9", conversation_id: "conversation-1" },
    }),
  );
  await cancelPromise;
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient conversation subscriptions subscribe after auth, route pushes, and survive reconnects", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const seen = { syncs: [], events: [] };
  const cleanup = client.subscribeConversationStream("conversation-1", {
    onSync: (result) => seen.syncs.push(result),
    onEvent: (event) => seen.events.push(event),
  });

  // 鉴权是唯一的连接通知点；对每条 chat_subscribe 帧按调用方游标 + 暂存的
  // 重放事件应答。
  const answeredSubscribes = new Set();
  let replayEvents = [];
  const subscribeCalls = [];
  const answerSubscribes = (socket) => {
    for (const frame of frames(codec, socket)) {
      if (frame.case !== "chatSubscribe" || answeredSubscribes.has(frame.requestId)) {
        continue;
      }
      answeredSubscribes.add(frame.requestId);
      const payload = {
        conversation_id: frame.json.chat_subscribe.conversation_id ?? "",
        after_seq: Number(frame.json.chat_subscribe.after_seq ?? 0),
        stream_epoch: frame.json.chat_subscribe.stream_epoch ?? "",
      };
      subscribeCalls.push(payload);
      const events = replayEvents;
      replayEvents = [];
      const latestSeq = events.length
        ? events[events.length - 1].seq
        : Math.max(payload.after_seq, 2);
      socket.receiveBinary(
        codec.encodeServerFrame({
          request_id: frame.requestId,
          chat_subscribed: {
            conversation_id: "conversation-1",
            stream_epoch: "epoch-1",
            latest_seq: latestSeq,
            events_json: events.map((event) => codec.base64(event)),
          },
        }),
      );
    }
  };
  const settle = async (socket) => {
    for (let i = 0; i < 20; i += 1) {
      answerSubscribes(socket);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  // 鉴权完成 → 持久订阅发出 chat_subscribe。
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "chatSubscribe"), "chat_subscribe");
  assert.equal(subscribeCalls.length, 0);
  await settle(socket);
  assert.ok(seen.syncs.length >= 1, "subscribe sync delivered");
  assert.equal(subscribeCalls.length, 1, "initial auth issues exactly one subscribe");
  assert.equal(subscribeCalls[0].conversation_id, "conversation-1");
  assert.equal(subscribeCalls[0].after_seq, 0);

  // chat_event 推送按会话 id 路由。
  const pushChatEvent = (target, payload) => {
    target.receiveBinary(
      codec.encodeServerFrame({
        chat_event: {
          conversation_id: payload.conversation_id,
          seq: payload.seq,
          payload_json: codec.base64(payload),
        },
      }),
    );
  };
  pushChatEvent(socket, {
    type: "run_started",
    conversation_id: "conversation-1",
    run_id: "run-1",
    seq: 3,
  });
  pushChatEvent(socket, {
    type: "token",
    conversation_id: "conversation-1",
    run_id: "run-1",
    seq: 4,
    text: "hi",
  });
  pushChatEvent(socket, {
    type: "token",
    conversation_id: "conversation-other",
    run_id: "run-x",
    seq: 9,
    text: "ignored",
  });
  await settle(socket);
  assert.deepEqual(
    seen.events.map((event) => event.type),
    ["run_started", "token"],
  );

  // 断线保留登记；重连按 resume 游标与 epoch 重新订阅。
  const syncsBeforeReconnect = seen.syncs.length;
  replayEvents = [
    { type: "token", conversation_id: "conversation-1", run_id: "run-1", seq: 5, text: "re" },
    {
      type: "run_finished",
      conversation_id: "conversation-1",
      run_id: "run-1",
      seq: 6,
      status: "completed",
    },
  ];
  const subscribesBeforeReconnect = subscribeCalls.length;
  socket.close();
  await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (FakeWebSocket.instances.length >= 2) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 3_000) {
        reject(new Error("timed out waiting for reconnect socket"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
  const reconnectSocket = await connectAndAuth(codec, 1);
  await settle(reconnectSocket);
  assert.ok(seen.syncs.length > syncsBeforeReconnect, "resume sync delivered");
  assert.equal(
    subscribeCalls.length,
    subscribesBeforeReconnect + 1,
    "each reconnect issues exactly one resume subscribe",
  );
  const resumePayload = subscribeCalls[subscribesBeforeReconnect];
  assert.equal(resumePayload.after_seq, 4, "resume cursor from last delivered seq");
  assert.equal(resumePayload.stream_epoch, "epoch-1");
  const resumeSync = seen.syncs[seen.syncs.length - 1];
  assert.deepEqual(
    resumeSync.events.map((event) => event.type),
    ["token", "run_finished"],
    "replayed events delivered with the resume sync",
  );

  // chat_subscription_reset 触发从游标再同步。
  const subscribesBeforeReset = subscribeCalls.length;
  reconnectSocket.receiveBinary(
    codec.encodeServerFrame({
      chat_subscription_reset: { conversation_id: "conversation-1" },
    }),
  );
  await settle(reconnectSocket);
  assert.ok(subscribeCalls.length > subscribesBeforeReset, "reset re-subscribed");
  assert.equal(subscribeCalls[subscribesBeforeReset].after_seq, 6);

  // 清理时在线退订。
  cleanup();
  await waitFor(() => findFrame(codec, reconnectSocket, "chatUnsubscribe"), "chat_unsubscribe");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient fans chat_activity and chat_command_update out to listeners", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const activityEvents = [];
  const commandUpdates = [];
  client.subscribeChatActivity((event) => activityEvents.push(event));
  client.subscribeChatCommandUpdates((update) => commandUpdates.push(update));

  const statusPromise = client.getStatus();
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "statusGet"), "status frame");
  const statusRequest = findFrame(codec, socket, "statusGet");
  socket.receiveBinary(
    codec.encodeServerFrame({ request_id: statusRequest.requestId, status: { online: true } }),
  );
  await statusPromise;

  socket.receiveBinary(
    codec.encodeServerFrame({
      chat_activity: {
        conversation_id: "conversation-1",
        run_id: "run-1",
        running: true,
        state: "running",
        workdir: "/workspace/project",
        client_request_id: "req-42",
        updated_at_ms: 1234,
      },
    }),
  );
  socket.receiveBinary(
    codec.encodeServerFrame({
      chat_activity: { conversation_id: "", running: true },
    }),
  );
  assert.equal(activityEvents.length, 1, "malformed activity payloads are dropped");
  assert.deepEqual(activityEvents[0], {
    conversationId: "conversation-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: "/workspace/project",
    clientRequestId: "req-42",
    updatedAt: 1234,
  });

  socket.receiveBinary(
    codec.encodeServerFrame({
      chat_command_update: {
        run_id: "run-1",
        client_request_id: "req-1",
        conversation_id: "conversation-9",
        phase: "bound",
      },
    }),
  );
  socket.receiveBinary(
    codec.encodeServerFrame({
      chat_command_update: { run_id: "run-1", phase: "unknown-phase" },
    }),
  );
  assert.equal(commandUpdates.length, 1, "unknown phases are dropped");
  assert.deepEqual(commandUpdates[0], {
    runId: "run-1",
    clientRequestId: "req-1",
    conversationId: "conversation-9",
    phase: "bound",
    errorCode: null,
    message: null,
  });
  resetGatewayWebSocketClient();
});

function createManualTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimeout: (fn, ms = 0) => {
      const id = nextId++;
      timers.set(id, { fn, ms, kind: "timeout" });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    setInterval: (fn, ms = 0) => {
      const id = nextId++;
      timers.set(id, { fn, ms, kind: "interval" });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
    fire: (predicate) => {
      for (const [id, timer] of [...timers]) {
        if (!predicate(timer)) continue;
        if (timer.kind === "timeout") timers.delete(id);
        timer.fn();
      }
    },
    delays: () => [...timers.values()].map((timer) => timer.ms),
  };
}

test("GatewayWebSocketClient applies pushed status frames and polls slowly as fallback", async () => {
  const timers = createManualTimers();
  installBrowser({ ...timers });
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statuses = [];
  client.subscribeStatus((status, error) => {
    statuses.push({ status, error });
  });
  assert.ok(
    timers.delays().includes(30_000),
    `status poll interval registered at 30s, got delays ${JSON.stringify(timers.delays())}`,
  );

  const socket = await connectAndAuth(codec);
  // subscribeStatus 触发的首轮轮询搭乘新连接。
  await waitFor(() => findFrame(codec, socket, "statusGet"), "initial status_get");

  socket.receiveBinary(
    codec.encodeServerFrame({ status: { online: true, agent_id: "desktop-agent" } }),
  );
  assert.equal(statuses.at(-1)?.status?.online, true, "pushed status frame reaches listeners");
  assert.equal(statuses.at(-1)?.error, null);

  socket.receiveBinary(codec.encodeServerFrame({ status: { online: false } }));
  assert.equal(statuses.at(-1)?.status?.online, false, "offline push reaches listeners");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient defers offline verdicts while hidden and reconciles on wake", async () => {
  const timers = createManualTimers();
  installBrowser({ ...timers });
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statuses = [];
  client.subscribeStatus((status, error) => {
    statuses.push({ status, error });
  });
  const socket = await connectAndAuth(codec);
  socket.receiveBinary(codec.encodeServerFrame({ status: { online: true } }));
  assert.equal(statuses.at(-1)?.status?.online, true);

  // 标签页转后台后连接断开（如冻结期间代理掐断链路）。
  globalThis.document.visibilityState = "hidden";
  const offlineCountBefore = statuses.filter((s) => s.status?.online === false).length;
  socket.close();

  // 15s 重连提示在后台触发：不得涂画离线态。
  timers.fire((timer) => timer.ms === 15_000);
  assert.equal(
    statuses.filter((s) => s.status?.online === false).length,
    offlineCountBefore,
    "hidden tab must not paint offline from throttled timers",
  );

  // 回前台：唤醒处理器重连；离线判定推迟到重连 + 状态刷新落定。
  globalThis.document.visibilityState = "visible";
  globalThis.document.dispatchEvent({ type: "visibilitychange" });
  timers.fire((timer) => timer.ms === 0); // armed reconnect timer
  const socket2 = await connectAndAuth(codec, 1);
  await waitFor(() => findFrame(codec, socket2, "statusGet"), "post-wake status refresh");
  const statusReq = findFrame(codec, socket2, "statusGet");
  socket2.receiveBinary(
    codec.encodeServerFrame({ request_id: statusReq.requestId, status: { online: true } }),
  );
  await waitFor(() => statuses.at(-1)?.status?.online === true, "post-wake online status");
  assert.equal(
    statuses.filter((s) => s.status?.online === false).length,
    offlineCountBefore,
    "successful wake reconcile never flashed offline",
  );
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient paints offline when the post-wake reconnect notice expires visible", async () => {
  const timers = createManualTimers();
  installBrowser({ ...timers });
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const statuses = [];
  client.subscribeStatus((status, error) => {
    statuses.push({ status, error });
  });
  const socket = await connectAndAuth(codec);
  socket.receiveBinary(codec.encodeServerFrame({ status: { online: true } }));

  globalThis.document.visibilityState = "hidden";
  socket.close();
  timers.fire((timer) => timer.ms === 15_000);
  assert.ok(!statuses.some((s) => s.status?.online === false), "no offline while hidden");

  globalThis.document.visibilityState = "visible";
  globalThis.document.dispatchEvent({ type: "visibilitychange" });
  // 重连始终不成功；重新武装的提示在前台超时。
  timers.fire((timer) => timer.ms === 15_000);
  const last = statuses.at(-1);
  assert.equal(last?.status?.online, false, "failed wake reconcile paints offline");
  assert.equal(last?.error, "Gateway 正在重新连接...");
  resetGatewayWebSocketClient();
});

test("GatewayWebSocketClient refreshes status immediately on wake with a healthy socket", async () => {
  const timers = createManualTimers();
  installBrowser({ ...timers });
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  client.subscribeStatus(() => {});
  const socket = await connectAndAuth(codec);
  await waitFor(() => findFrame(codec, socket, "statusGet"), "initial status_get");
  const initialStatusRequests = frames(codec, socket).filter(
    (frame) => frame.case === "statusGet",
  ).length;
  const statusReq = findFrame(codec, socket, "statusGet");
  socket.receiveBinary(
    codec.encodeServerFrame({ request_id: statusReq.requestId, status: { online: true } }),
  );
  // 等在途 refreshStatus 落定（finally 在微任务里跑），避免唤醒触发的刷新
  // 被 in-flight 守卫吞掉。
  await new Promise((resolve) => setTimeout(resolve, 0));

  globalThis.window.dispatchEvent({ type: "focus" });
  await waitFor(
    () =>
      frames(codec, socket).filter((frame) => frame.case === "statusGet").length >
      initialStatusRequests,
    "wake-triggered status_get",
  );
  resetGatewayWebSocketClient();
});
