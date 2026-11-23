// The gateway forwards why a model discovery failed (errorCode, upstreamStatus,
// upstreamMessage on the local error); the WebUI keeps them on the rejected
// Error so the shared provider editor can say "API key was rejected (401)".
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const base = createWebModuleLoader();
const adapters = base.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const v2 = base.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");
const pb = base.loadModule("@bufbuild/protobuf");
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

const REJECTED = {
  message: "kbrain settings request: 502 Bad Gateway: model discovery failed",
  error_code: "invalid_api_key",
  upstream_status: 401,
  upstream_message: "Incorrect API key provided: sk-bad***.",
};

function localErrorBytes(localError) {
  return pb.toBinary(
    v2.WebServerFrameSchema,
    pb.fromJson(v2.WebServerFrameSchema, { request_id: "models-1", local_error: localError }),
  );
}

test("a local error decodes with the failed discovery's reason", () => {
  const decode = (localError) =>
    adapters.decodeServerFrame(adapters.decodeServerFrameBinary(localErrorBytes(localError)), {
      agentOnline: true,
    });
  assert.deepEqual(decode(REJECTED), {
    kind: "error",
    requestId: "models-1",
    agentId: "",
    message: REJECTED.message,
    detail: {
      errorCode: "invalid_api_key",
      upstreamStatus: 401,
      upstreamMessage: "Incorrect API key provided: sk-bad***.",
    },
  });
  assert.deepEqual(decode({ error_code: "unreachable", message: "model discovery failed" }).detail, {
    errorCode: "unreachable",
  });
  // An older gateway sends only the message.
  assert.deepEqual(decode({ message: "model discovery failed" }), {
    kind: "error",
    requestId: "models-1",
    agentId: "",
    message: "model discovery failed",
  });
});

test("the rejected request error carries the reason", async () => {
  const client = Object.create(GatewayWebSocketTransport.prototype);
  client.markInboundActivity = () => {};
  client.pending = new Map();
  const result = new Promise((resolve, reject) =>
    client.pending.set("models-1", { resolve, reject, timeoutId: undefined }),
  );
  client.handleMessage(localErrorBytes(REJECTED));
  const error = await result.then(
    () => assert.fail("the request must fail"),
    (failure) => failure,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message, REJECTED.message);
  assert.equal(error.errorCode, "invalid_api_key");
  assert.equal(error.upstreamStatus, 401);
  assert.equal(error.upstreamMessage, "Incorrect API key provided: sk-bad***.");
  assert.equal(client.pending.size, 0);
});
