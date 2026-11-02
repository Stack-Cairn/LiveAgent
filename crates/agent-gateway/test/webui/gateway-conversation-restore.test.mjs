import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const restore = loader.loadModule("src/app/gatewayConversationRestore.ts");
const { createOpenConversationInitial } = loader.loadModule(
  "src/app/gatewayHistoryWindowActions.ts",
);

function installSessionStorage() {
  const values = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        values.set(key, String(value));
      },
    },
  };
  return values;
}

test("conversation restore selections are isolated by agent", () => {
  installSessionStorage();

  restore.saveGatewayConversationSelection("agent-a", "conversation-a");
  restore.saveGatewayConversationSelection("agent-b", "conversation-b");

  assert.equal(restore.loadGatewayConversationSelection("agent-a"), "conversation-a");
  assert.equal(restore.loadGatewayConversationSelection("agent-b"), "conversation-b");
  assert.equal(restore.loadGatewayConversationSelection("agent-c"), "");
});

test("restore targets prefer backend identity and retain durable active aliases", () => {
  assert.equal(
    restore.resolveGatewayConversationRestoreTarget({
      conversationId: "relay-alias",
      historyConversationId: "relay-alias",
      historySessionId: " backend-session-1 ",
    }),
    "backend-session-1",
  );
  assert.equal(
    restore.resolveGatewayConversationRestoreTarget({
      conversationId: "relay-alias",
      historyConversationId: "other-alias",
      historySessionId: "backend-session-1",
      sidebarSessionId: "backend-session-2",
    }),
    "backend-session-2",
  );
  assert.equal(
    restore.resolveGatewayConversationRestoreTarget({ conversationId: "relay-alias" }),
    "relay-alias",
  );
});

test("invalid stored values and storage failures fall back safely", () => {
  const values = installSessionStorage();
  values.set("liveagent.gateway.selectedConversation.v2", "not-json");
  assert.equal(restore.loadGatewayConversationSelection("agent-a"), "");

  globalThis.window.sessionStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(restore.loadGatewayConversationSelection("agent-a"), "");
  assert.doesNotThrow(() => restore.saveGatewayConversationSelection("agent-a", "conversation-a"));
});

test("clearing one agent does not affect another selection", () => {
  installSessionStorage();
  restore.saveGatewayConversationSelection("agent-a", "conversation-a");
  restore.saveGatewayConversationSelection("agent-b", "conversation-b");

  restore.clearGatewayConversationSelection("agent-a");

  assert.equal(restore.loadGatewayConversationSelection("agent-a"), "");
  assert.equal(restore.loadGatewayConversationSelection("agent-b"), "conversation-b");
});

test("restoration uses the normal history open initial loader", async () => {
  const calls = [];
  const applied = [];
  const state = {
    conversationId: "",
    selectedHistoryId: "",
    selectedHistory: null,
    revision: 0,
  };
  const historyLoadSequenceRef = { current: 0 };
  const visibleConversationRevisionRef = { current: 0 };
  const openInitial = createOpenConversationInitial({
    api: {
      async getHistory(conversationId) {
        calls.push(conversationId);
        return { conversation_id: conversationId, messages_json: "[]" };
      },
    },
    conversationIdRef: { current: "" },
    conversationWorkdirsRef: { current: new Map() },
    getDisplayedConversationId: () => state.conversationId,
    historyLoadSequenceRef,
    historyWindowStatesRef: { current: new Map() },
    invalidateHistoryLoad: () => {
      historyLoadSequenceRef.current += 1;
      return historyLoadSequenceRef.current;
    },
    localeErrorMessage: "open failed",
    markVisibleConversationRevision: () => {
      state.revision += 1;
      visibleConversationRevisionRef.current = state.revision;
      return state.revision;
    },
    pendingDisplayedConversationAutoBottomRef: { current: null },
    protectedConversationRef: { current: "" },
    selectedHistoryIdRef: { current: "" },
    setChatError() {},
    setConversationId(value) {
      state.conversationId = value;
    },
    setSelectedHistory(value) {
      state.selectedHistory = value;
    },
    setSelectedHistoryId(value) {
      state.selectedHistoryId = value;
    },
    transcriptStoreRegistry: {
      get() {
        return {
          applyHistorySnapshot(entries, options) {
            applied.push({ entries, options });
          },
        };
      },
      peek() {
        return undefined;
      },
    },
    visibleConversationRevisionRef,
  });

  await openInitial("conversation-a");

  assert.deepEqual(calls, ["conversation-a"]);
  assert.equal(state.conversationId, "conversation-a");
  assert.equal(state.selectedHistoryId, "conversation-a");
  assert.deepEqual(applied, [{ entries: [], options: { mode: "replace" } }]);
});

test("history response for a different id is rejected for restore fallback", async () => {
  const openInitial = createOpenConversationInitial({
    api: {
      async getHistory() {
        return { conversation_id: "deleted-or-other", messages_json: "[]" };
      },
    },
    conversationIdRef: { current: "" },
    conversationWorkdirsRef: { current: new Map() },
    getDisplayedConversationId: () => "",
    historyLoadSequenceRef: { current: 0 },
    historyWindowStatesRef: { current: new Map() },
    invalidateHistoryLoad: () => 1,
    localeErrorMessage: "open failed",
    markVisibleConversationRevision: () => 1,
    pendingDisplayedConversationAutoBottomRef: { current: null },
    protectedConversationRef: { current: "" },
    selectedHistoryIdRef: { current: "" },
    setChatError() {},
    setConversationId() {},
    setSelectedHistory() {},
    setSelectedHistoryId() {},
    transcriptStoreRegistry: { get() { return { applyHistorySnapshot() {} }; } },
    visibleConversationRevisionRef: { current: 0 },
  });

  await assert.rejects(() => openInitial("conversation-a"), /missing the requested conversation/);
});
