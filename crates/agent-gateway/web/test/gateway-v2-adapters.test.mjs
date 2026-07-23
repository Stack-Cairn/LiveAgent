import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const adapters = loader.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const pb = loader.loadModule("@bufbuild/protobuf");
const v2 = loader.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");

const { decodeServerFrame, decodeServerFrameBinary, encodeRequestFrame } = adapters;

function serverFrame(init) {
  return pb.fromJson(v2.WebServerFrameSchema, init);
}

function roundtrip(frame) {
  return decodeServerFrameBinary(pb.toBinary(v2.WebServerFrameSchema, frame));
}

function decodeClientFrame(bytes) {
  return pb.fromBinary(v2.WebClientFrameSchema, bytes);
}

test("adapters convert int64/uint64 fields to Number at realistic maxima", () => {
  // 毫秒时间戳（2100 年）与 MAX_SAFE_INTEGER 边界都必须无损转换。
  const year2100Ms = 4102444800000;
  const maxSafe = Number.MAX_SAFE_INTEGER;

  const statusDecoded = decodeServerFrame(
    roundtrip(
      serverFrame({
        status: {
          online: true,
          connected_since: year2100Ms,
          last_heartbeat: maxSafe,
          runtime_last_heartbeat: year2100Ms,
          runtime_state: "ready",
        },
      }),
    ),
    { agentOnline: true },
  );
  assert.equal(statusDecoded.kind, "event");
  assert.equal(statusDecoded.payload.connected_since, year2100Ms);
  assert.equal(statusDecoded.payload.last_heartbeat, maxSafe);
  assert.equal(statusDecoded.payload.runtime_last_heartbeat, year2100Ms);
  assert.equal(typeof statusDecoded.payload.connected_since, "number");

  const activityDecoded = decodeServerFrame(
    roundtrip(
      serverFrame({
        chat_activity: {
          conversation_id: "conversation-1",
          running: true,
          updated_at_ms: year2100Ms,
        },
      }),
    ),
    { agentOnline: true },
  );
  assert.equal(activityDecoded.payload.updated_at, year2100Ms);

  // uint64 revision（tunnel_state）同样落在 Number 域。
  const tunnelDecoded = decodeServerFrame(
    roundtrip(
      serverFrame({
        tunnel_state: { revision: maxSafe, agent_online: true },
      }),
    ),
    { agentOnline: true },
  );
  assert.equal(tunnelDecoded.payload.revision, maxSafe);
  assert.equal(typeof tunnelDecoded.payload.revision, "number");
});

test("decodeServerFrame dispatches on the oneof arm", () => {
  const ping = decodeServerFrame(roundtrip(serverFrame({ ping: { timestamp: 123 } })), {
    agentOnline: false,
  });
  assert.deepEqual(ping, { kind: "ping", timestamp: 123 });

  const localError = decodeServerFrame(
    roundtrip(serverFrame({ request_id: "req-1", local_error: { message: "agent offline" } })),
    { agentOnline: false },
  );
  assert.deepEqual(localError, {
    kind: "error",
    requestId: "req-1",
    agentId: "",
    message: "agent offline",
  });

  // status 臂：带 request_id 是响应，空 request_id 是广播。
  const statusResponse = decodeServerFrame(
    roundtrip(serverFrame({ request_id: "req-2", status: { online: true } })),
    { agentOnline: false },
  );
  assert.equal(statusResponse.kind, "response");
  const statusEvent = decodeServerFrame(roundtrip(serverFrame({ status: { online: true } })), {
    agentOnline: false,
  });
  assert.equal(statusEvent.kind, "event");
  assert.equal(statusEvent.type, "status.event");

  const ack = decodeServerFrame(
    roundtrip(serverFrame({ request_id: "req-3", ack: { ok: true } })),
    { agentOnline: false },
  );
  assert.deepEqual(ack, { kind: "response", requestId: "req-3", agentId: "", payload: { ok: true } });

  // agent_response 的 error 臂映射为统一请求错误。
  const agentError = decodeServerFrame(
    roundtrip(
      serverFrame({
        request_id: "req-4",
        agent_response: { error: { code: 99, message: "boom" } },
      }),
    ),
    { agentOnline: false },
  );
  assert.deepEqual(agentError, { kind: "error", requestId: "req-4", agentId: "", message: "boom" });

  // 空载荷帧被忽略。
  const empty = decodeServerFrame(pb.create(v2.WebServerFrameSchema, {}), { agentOnline: false });
  assert.equal(empty, null);
});

test("agent_list status entries preserve optional client names", () => {
  const decoded = decodeServerFrame(
    roundtrip(
      serverFrame({
        request_id: "agents-with-names",
        agent_list: {
          agents: [
            { agent_id: "agent-a", online: true, name: "Office desktop" },
            { agent_id: "agent-b", online: false },
          ],
        },
      }),
    ),
    { agentOnline: true },
  );

  assert.equal(decoded.kind, "response");
  assert.equal(decoded.payload.agents[0].name, "Office desktop");
  assert.equal(decoded.payload.agents[1].name, undefined);
});

test("chat_event payload_json roundtrips to the expected event object", () => {
  const payload = {
    type: "token",
    conversation_id: "conversation-1",
    run_id: "run-1",
    seq: 42,
    text: "你好 · emoji 🎯",
    usage: { input: 10, output: 20 },
  };
  const decoded = decodeServerFrame(
    roundtrip(
      serverFrame({
        chat_event: {
          conversation_id: "conversation-1",
          seq: 42,
          payload_json: Buffer.from(JSON.stringify(payload)).toString("base64"),
        },
      }),
    ),
    { agentOnline: false },
  );
  assert.equal(decoded.kind, "event");
  assert.equal(decoded.type, "chat.event");
  assert.deepEqual(decoded.payload, payload);

  // chat_subscribed 的 events_json 逐条解析。
  const subscribed = decodeServerFrame(
    roundtrip(
      serverFrame({
        request_id: "req-1",
        chat_subscribed: {
          conversation_id: "conversation-1",
          stream_epoch: "epoch-1",
          latest_seq: 42,
          events_json: [Buffer.from(JSON.stringify(payload)).toString("base64")],
        },
      }),
    ),
    { agentOnline: false },
  );
  assert.equal(subscribed.kind, "response");
  assert.deepEqual(subscribed.payload.events, [payload]);
  assert.equal(subscribed.payload.latest_seq, 42);
});

test("process_state injects the client-tracked agent_online flag", () => {
  const frame = roundtrip(
    serverFrame({
      process_state: {
        revision: 7,
        processes: [
          {
            id: "proc-1",
            label: "dev server",
            pid: 4321,
            started_at: 1700000000000,
            running: true,
          },
        ],
      },
    }),
  );
  const online = decodeServerFrame(frame, { agentOnline: true });
  assert.equal(online.type, "process.state");
  assert.equal(online.payload.agent_online, true);
  assert.equal(online.payload.revision, 7);
  assert.equal(online.payload.processes[0].started_at, 1700000000000);
  // 未置位的 optional finished_at / exit_code 不出现在结果中。
  assert.equal("finished_at" in online.payload.processes[0], false);
  assert.equal("exit_code" in online.payload.processes[0], false);

  const offline = decodeServerFrame(frame, { agentOnline: false });
  assert.equal(offline.payload.agent_online, false);
});

test("encodeRequestFrame maps request types onto GatewayEnvelope arms", () => {
  const listFrame = decodeClientFrame(
    encodeRequestFrame("req-1", "history.list", { page: 2, page_size: 50, cwd: "/tmp/p" }, "agent-a"),
  );
  assert.equal(listFrame.requestId, "req-1");
  assert.equal(listFrame.payload.case, "agentRequest");
  assert.equal(listFrame.payload.value.payload.case, "historyList");
  assert.deepEqual(
    {
      page: listFrame.payload.value.payload.value.page,
      pageSize: listFrame.payload.value.payload.value.pageSize,
      cwd: listFrame.payload.value.payload.value.cwd,
    },
    { page: 2, pageSize: 50, cwd: "/tmp/p" },
  );

  const terminalFrame = decodeClientFrame(
    encodeRequestFrame("req-2", "terminal.create", {
      cwd: "/workspace",
      project_path_key: "/workspace",
      cols: 120,
      rows: 40,
    }, "agent-a"),
  );
  assert.equal(terminalFrame.payload.value.payload.case, "terminalRequest");
  assert.equal(terminalFrame.payload.value.payload.value.action, "create");
  assert.equal(terminalFrame.payload.value.payload.value.cols, 120);

  // chat.command 的 64 位字段在出站边界收窄为 bigint。
  const commandFrame = decodeClientFrame(
    encodeRequestFrame("req-3", "chat.command", {
      type: "chat.submit",
      payload: {
        message: "hi",
        conversation_id: "conversation-1",
        client_request_id: "client-1",
        uploaded_files: [
          {
            relative_path: "a.png",
            absolute_path: "/tmp/a.png",
            file_name: "a.png",
            kind: "image",
            size_bytes: 4102444800000,
          },
        ],
        queue_policy: "auto",
      },
    }, "agent-a"),
  );
  assert.equal(commandFrame.payload.case, "chatCommand");
  assert.equal(commandFrame.payload.value.request.uploadedFiles[0].sizeBytes, 4102444800000n);

  assert.throws(
    () => encodeRequestFrame("missing-agent", "status.get", {}),
    /agent_id is required/,
  );
  assert.throws(
    () => encodeRequestFrame("req-4", "not.a.request", {}),
    /unsupported gateway request type/,
  );
});
