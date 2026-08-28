// Web 端 Session Workbench 合同测试：
// 1) 网关中转的会话隔离——ConversationStreamClient 按 conversation_id 路由，
//    多 Pane 并存时事件绝不串流；聚焦切换瞬间同会话「后订阅替换先订阅」，
//    被替换方的清理不会误删新订阅（GatewayConversationPaneHost 依赖此语义）。
// 2) 草稿转正的 Pane 原位重绑——renameWorkbenchConversation 保持拓扑/焦点/
//    paneId 不变，只换会话 id；违反「一个会话最多一个 Pane」时拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { ConversationStreamClient } = loader.loadModule(
  "src/lib/chat/stream/conversationStreamClient.ts",
);
const { renameWorkbenchConversation } = loader.loadModule(
  "@liveagent/ui/lib/workbench/useWindowWorkbench.ts",
);
const { findPaneIdByConversationId, isWorkbenchLayoutValid } = loader.loadModule(
  "@liveagent/ui/lib/workbench/index.ts",
);
const { WORKBENCH_LAYOUT_SCHEMA_VERSION } = loader.loadModule(
  "@liveagent/ui/lib/workbench/types.ts",
);

// --- 流客户端测试支架（与 conversation-stream-client.test.mjs 同构）---------

function createTransport() {
  const calls = [];
  let responder = () => ({});
  return {
    calls,
    setResponder(fn) {
      responder = fn;
    },
    request(type, payload, options) {
      calls.push({ type, payload, options });
      return Promise.resolve(responder(type, payload));
    },
  };
}

function subscribeResponse(conversationId, overrides = {}) {
  return {
    conversation_id: conversationId,
    stream_epoch: `epoch-${conversationId}`,
    latest_seq: 0,
    reset: false,
    activity: null,
    snapshot: null,
    events: [],
    ...overrides,
  };
}

function collectHandlers() {
  const seen = { syncs: [], events: [] };
  return {
    seen,
    handlers: {
      onSync(result) {
        seen.syncs.push(result);
      },
      onEvent(event) {
        seen.events.push(event);
      },
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

// --- 布局测试支架 -----------------------------------------------------------

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: {
        projectId: `project-${paneId}`,
        projectPathKey: `/workspace/${paneId}`,
      },
    },
    view: {},
  };
}

function twoPaneLayout(firstConversationId, secondConversationId) {
  const first = conversationPane("pane-a", firstConversationId);
  const second = conversationPane("pane-b", secondConversationId);
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 7,
    root: {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: first.paneId },
      second: { type: "leaf", paneId: second.paneId },
    },
    panes: {
      [first.paneId]: first,
      [second.paneId]: second,
    },
    focusedPaneId: first.paneId,
  };
}

// --- 会话隔离 ----------------------------------------------------------------

test("multi-pane gateway streams stay isolated per conversation", async () => {
  const transport = createTransport();
  const client = new ConversationStreamClient(transport);
  const paneA = collectHandlers();
  const paneB = collectHandlers();

  transport.setResponder((_type, payload) => subscribeResponse(payload.conversation_id));
  client.subscribe("conv-a", paneA.handlers);
  client.subscribe("conv-b", paneB.handlers);
  client.handleConnected();
  await flushMicrotasks();
  assert.equal(paneA.seen.syncs.length, 1);
  assert.equal(paneB.seen.syncs.length, 1);

  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 1, text: "a1" });
  client.handleChatEvent({ type: "token", conversation_id: "conv-b", seq: 1, text: "b1" });
  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 2, text: "a2" });
  // 未订阅会话的事件被丢弃，不落进任何 handler。
  client.handleChatEvent({ type: "token", conversation_id: "conv-c", seq: 1, text: "c1" });

  assert.deepEqual(
    paneA.seen.events.map((event) => event.text),
    ["a1", "a2"],
  );
  assert.deepEqual(
    paneB.seen.events.map((event) => event.text),
    ["b1"],
  );
});

test("focus handoff: re-subscribing replaces the old registration; stale cleanup is inert", async () => {
  const transport = createTransport();
  const client = new ConversationStreamClient(transport);
  const preview = collectHandlers();
  const mainView = collectHandlers();

  transport.setResponder((_type, payload) => subscribeResponse(payload.conversation_id));
  const unsubscribePreview = client.subscribe("conv-a", preview.handlers);
  client.handleConnected();
  await flushMicrotasks();

  // 聚焦切换：主视图对同一会话再次订阅，替换预览的注册。
  client.subscribe("conv-a", mainView.handlers);
  await flushMicrotasks();

  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 1, text: "x" });
  assert.equal(preview.seen.events.length, 0);
  assert.deepEqual(
    mainView.seen.events.map((event) => event.text),
    ["x"],
  );

  // 预览组件随后卸载：被替换的清理不得删除新注册、不得向网关发 unsubscribe。
  const callsBefore = transport.calls.length;
  unsubscribePreview();
  await flushMicrotasks();
  assert.equal(transport.calls.length, callsBefore);
  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 2, text: "y" });
  assert.deepEqual(
    mainView.seen.events.map((event) => event.text),
    ["x", "y"],
  );
});

// --- 草稿转正的原位重绑 --------------------------------------------------------

test("draft promotion rebinds the hosting pane in place", () => {
  const layout = twoPaneLayout("draft-local-1", "conversation-b");
  const next = renameWorkbenchConversation(layout, "draft-local-1", "conversation-real");

  assert.ok(next);
  assert.ok(isWorkbenchLayoutValid(next));
  assert.equal(next.revision, layout.revision + 1);
  // 拓扑与焦点保持引用不变：Pane 不重挂载，分栏比例不动。
  assert.equal(next.root, layout.root);
  assert.equal(next.focusedPaneId, layout.focusedPaneId);
  assert.equal(next.panes["pane-b"], layout.panes["pane-b"]);
  // 同一个 Pane 原位换绑到真实会话 id，草稿 id 不再被任何 Pane 承载。
  assert.equal(findPaneIdByConversationId(next, "conversation-real"), "pane-a");
  assert.equal(findPaneIdByConversationId(next, "draft-local-1"), null);
  assert.equal(next.panes["pane-a"].surface.project, layout.panes["pane-a"].surface.project);
});

test("rename refuses no-op and invariant-breaking inputs", () => {
  const layout = twoPaneLayout("conversation-a", "conversation-b");

  // 源会话没有 Pane / 空 id / 同 id：无事发生。
  assert.equal(renameWorkbenchConversation(layout, "conversation-x", "conversation-y"), null);
  assert.equal(renameWorkbenchConversation(layout, "", "conversation-y"), null);
  assert.equal(
    renameWorkbenchConversation(layout, "conversation-a", "conversation-a"),
    null,
  );
  // 目标会话已有 Pane：拒绝，维持「一个会话最多一个 Pane」。
  assert.equal(
    renameWorkbenchConversation(layout, "conversation-a", "conversation-b"),
    null,
  );
});
