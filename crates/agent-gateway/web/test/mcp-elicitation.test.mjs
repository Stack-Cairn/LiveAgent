import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// MCP form elicitations in the WebUI (Stack-Cairn/K-brain#174): the form opens from the
// synced tool-call arguments, answers go through chat_queue.mcp_elicitation, a refused
// answer brings K-brain's field errors back, and resolved records (live, replayed or
// reloaded from history) render as summaries without sensitive values.
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const shared = loader.loadModule("@liveagent/ui/lib/chat/mcpElicitation.ts");
const bridge = loader.loadModule("src/lib/chat/mcpElicitationBridge.ts");
const adapter = loader.loadModule("src/agent-ui-adapters/assistantBubble.ts");
const adapters = loader.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const pb = loader.loadModule("@bufbuild/protobuf");
const v2 = loader.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");

const request = {
  elicitation_id: "el-1", tool_call_id: "call-1", run_id: "run-1", deadline_at: Date.now() + 60_000,
  server: "deploy", tool: "ship", message: "Confirm the release",
  fields: [
    { name: "name", type: "string", required: true, min_length: 2 },
    { name: "token", type: "string", sensitive: true },
  ],
};
const pendingArgs = { env: "prod", [shared.MCP_ELICITATION_PENDING_ARG]: [request] };

test("a synced pending form is answerable only with the gateway answer path", () => {
  bridge.registerMcpElicitationAnswerHandler(null);
  assert.equal(adapter.useMcpElicitationAnswerable("call-1", "el-1", pendingArgs), false);
  bridge.registerMcpElicitationAnswerHandler(async () => ({ ok: true }));
  try {
    assert.equal(adapter.useMcpElicitationAnswerable("call-1", "el-1", pendingArgs), true);
    assert.equal(adapter.useMcpElicitationAnswerable("call-1", "el-2", pendingArgs), false);
    // Once the synced call no longer lists it (resolved, or the run ended), it is closed.
    assert.equal(adapter.useMcpElicitationAnswerable("call-1", "el-1", { env: "prod" }), false);
  } finally {
    bridge.registerMcpElicitationAnswerHandler(null);
  }
});

test("answers go through chat_queue.mcp_elicitation; a 400 returns field errors", async () => {
  assert.equal(bridge.buildMcpElicitationRequestJson("el-1", "accept", { name: "Ada" }), '{"elicitationId":"el-1","action":"accept","content":{"name":"Ada"}}');
  // Content only goes with accept.
  assert.equal(bridge.buildMcpElicitationRequestJson("el-1", "decline", { name: "Ada" }), '{"elicitationId":"el-1","action":"decline"}');
  assert.equal(bridge.buildMcpElicitationRequestJson("el-1", "cancel"), '{"elicitationId":"el-1","action":"cancel"}');

  assert.deepEqual(bridge.readMcpElicitationFieldErrors('{"field_errors":{"name":"must be at least 2 characters","":"x","n":3}}'), { name: "must be at least 2 characters" });
  assert.equal(bridge.readMcpElicitationFieldErrors(""), undefined);
  assert.equal(bridge.readMcpElicitationFieldErrors("not json"), undefined);
  assert.equal(bridge.readMcpElicitationFieldErrors('{"field_errors":[]}'), undefined);

  const frame = pb.fromBinary(v2.WebClientFrameSchema, adapters.encodeRequestFrame("req-1", "chat_queue.mcp_elicitation", {
    conversation_id: "conv-1", item_id: "call-1", request_json: bridge.buildMcpElicitationRequestJson("el-1", "accept", { name: "Ada" }),
  }, "agent-a"));
  const queue = frame.payload.value.payload;
  assert.equal(queue.case, "chatQueue");
  assert.equal(queue.value.action, "mcp_elicitation");
  assert.equal(queue.value.conversationId, "conv-1");
  assert.equal(queue.value.itemId, "call-1");
  assert.deepEqual(JSON.parse(queue.value.requestJson), { elicitationId: "el-1", action: "accept", content: { name: "Ada" } });

  const seen = [];
  bridge.registerMcpElicitationAnswerHandler(async (...args) => {
    seen.push(args);
    return { ok: false, message: "invalid content", fieldErrors: { name: "too short" } };
  });
  try {
    const outcome = await adapter.submitMcpElicitation("call-1", "el-1", "accept", { name: "x" });
    assert.deepEqual(outcome, { ok: false, message: "invalid content", fieldErrors: { name: "too short" } });
    assert.deepEqual(seen, [["call-1", "el-1", "accept", { name: "x" }]]);
  } finally {
    bridge.registerMcpElicitationAnswerHandler(null);
  }
  assert.equal((await adapter.submitMcpElicitation("call-1", "el-1", "decline")).ok, false);
});

test("live, replayed and reloaded records render once, without sensitive values", () => {
  const record = { elicitation_id: "el-1", tool_call_id: "call-1", server: "deploy", message: "Confirm the release", fields: request.fields, action: "accept", reason: "user", content: { name: "Ada", token: "leak" }, redacted: ["token"] };
  // The relay replays the same record (reconnect) and the tool result carries it too.
  const entries = shared.collectMcpElicitationEntries({
    args: { [shared.MCP_ELICITATION_RECORDS_ARG]: [record, record] },
    details: { [shared.MCP_ELICITATION_DETAILS_KEY]: [record] },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "record");
  assert.deepEqual(entries[0].record.content, { name: "Ada" });
  assert.equal(JSON.stringify(entries).includes("leak"), false);
  assert.equal(shared.hasPendingMcpElicitation({ [shared.MCP_ELICITATION_RECORDS_ARG]: [record] }), false);
  assert.equal(shared.hasPendingMcpElicitation(pendingArgs), true);

  // History reload: only the tool result details, including an auto-decline.
  const reloaded = shared.collectMcpElicitationEntries({
    args: { env: "prod" },
    details: { [shared.MCP_ELICITATION_DETAILS_KEY]: [record, { server: "deploy", message: "m", action: "decline", reason: "limit" }] },
  });
  assert.deepEqual(reloaded.map((entry) => shared.mcpElicitationOutcome(entry.record)), ["accepted", "limit"]);
});

test("the synthetic arguments stay out of the displayed tool arguments", () => {
  const { toolCallArgsForDisplay } = loader.loadModule("@liveagent/ui/lib/chat/uiMessages.ts");
  const display = toolCallArgsForDisplay({ type: "toolCall", id: "call-1", name: "mcp__deploy__ship", arguments: { ...pendingArgs, [shared.MCP_ELICITATION_RECORDS_ARG]: [] } });
  assert.deepEqual(display, { env: "prod" });
});

test("a pending form stands alone and is pinned; once answered the call rejoins the activity group", () => {
  const { groupRoundBlocks, hasActiveUserInteraction, isPendingUserInteractionBlock } = loader.loadModule("@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts");
  const call = (id, args) => ({ kind: "tool", item: { toolCall: { type: "toolCall", id, name: "mcp__deploy__ship", arguments: args } } });
  const read = (id) => ({ kind: "tool", item: { toolCall: { type: "toolCall", id, name: "Read", arguments: {} } } });

  const pending = groupRoundBlocks([read("read-1"), call("call-1", pendingArgs), read("read-2")]);
  assert.deepEqual(pending.map((block) => block.kind), ["toolGroup", "tool", "toolGroup"]);
  assert.equal(pending[1].item.toolCall.id, "call-1");
  assert.deepEqual(pending.map(isPendingUserInteractionBlock), [false, true, false]);
  // It also counts as an interaction that needs the user, so a batch holding it stays open
  // (even when the call is not listed as running) and does not fold itself on settle.
  assert.equal(hasActiveUserInteraction([read("read-1").item, call("call-1", pendingArgs).item], []), true);

  const record = { elicitation_id: "el-1", server: "deploy", message: "m", action: "accept", reason: "user" };
  const answered = groupRoundBlocks([read("read-1"), call("call-1", { env: "prod", [shared.MCP_ELICITATION_RECORDS_ARG]: [record] }), read("read-2")]);
  assert.deepEqual(answered.map((block) => block.kind), ["toolGroup"]);
  assert.equal(answered.some(isPendingUserInteractionBlock), false);
  assert.equal(hasActiveUserInteraction(answered[0].items, ["call-1"]), false);

  // A result ends the wait even if a stale pending copy is still in the arguments.
  const settled = { ...call("call-1", pendingArgs) };
  settled.item = { ...settled.item, toolResult: { role: "toolResult", toolCallId: "call-1", content: [], isError: false } };
  assert.equal(isPendingUserInteractionBlock(settled), false);
});
