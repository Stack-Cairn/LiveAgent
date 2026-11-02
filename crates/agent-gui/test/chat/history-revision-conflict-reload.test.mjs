import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// A stale CAS token surfaces as a backend 409 "history revision conflict" or the
// client's local-guard text. Both must trigger a re-request of the authoritative
// window instead of a dead-end error for the user.
const root = createTsModuleLoader();
const chatHistoryPath = root.resolveLocal("src/lib/chat/history/chatHistory.ts");
const conversationState = root.loadModule("src/lib/chat/conversation/conversationState.ts");

function conflictError() {
  return Object.assign(new Error("K-brain history revision conflict; reload the conversation"), {
    status: 409,
  });
}

function userMessage(text, timestamp = 1, id = "u1") {
  return { id, role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text, timestamp = 2) {
  return {
    id: "a1",
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    provider: "mock",
    model: "fixture-model",
    api: "kbrain.agent.v1",
    stopReason: "end_turn",
    usage: undefined,
  };
}

function segmentWindow(messages, segmentId = "kbrain:remote-1") {
  return {
    segmentIndex: 0,
    segmentId,
    messages,
    startMessageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
  };
}

function windowRecord(messages, revision) {
  const slice = segmentWindow(messages);
  return {
    conversation: {
      id: "conversation-1",
      sessionId: "remote-1",
      title: "Repro",
      cwd: "/repo",
      createdAt: 1,
      updatedAt: 2,
      providerId: "mock",
      model: "fixture-model",
      selectedModelJson: "",
    },
    meta: {
      schemaVersion: 3,
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: messages.length,
    },
    segments: [slice],
    activeSegment: { ...slice, messageCount: messages.length },
    returnedMessageCount: messages.length,
    oldestOffset: 0,
    hasMoreBefore: false,
    revision,
    updatedAt: 2,
  };
}

function buildState(messages, revision) {
  const slice = segmentWindow(messages);
  return conversationState.normalizeConversationState({
    meta: { systemPrompt: undefined, tools: [] },
    segments: [slice],
    transcript: conversationState.createTranscriptProjection({
      segments: [slice],
      activeSegmentIndex: 0,
      oldestMessageOffset: 0,
      hasMoreBefore: false,
      revision,
    }),
  });
}

const CONFLICT = "K-brain history revision conflict";

function loadHistoryActions({ getWindow, replace, branch }) {
  const loader = createTsModuleLoader({
    mocks: {
      react: {
        useRef: (current) => ({ current }),
        useCallback: (fn) => fn,
        useState: (initial) => [initial, () => {}],
      },
      [chatHistoryPath]: {
        branchChatHistory: branch,
        CHAT_HISTORY_WINDOW_MESSAGES: 360,
        buildChatHistoryRevision: () => "stamped",
        buildConversationStateFromWindow: (record) =>
          buildState(record.activeSegment.messages, record.revision),
        getChatHistoryWindow: getWindow,
        persistConversationRuntime: async () => null,
        renameChatHistory: async () => {},
        replaceChatHistoryFromMessage: replace,
      },
    },
  });
  return loader.loadModule("src/pages/chat/history/useConversationHistoryActions.ts");
}

function harness(params) {
  const cache = new Map();
  const cursors = new Map();
  const upserted = [];
  const synced = [];
  const errors = [];
  const currentId = { current: "conversation-1" };
  const visible = { state: buildState([userMessage("hello"), assistantMessage("world")], "rev-1") };
  const noop = () => {};
  const actions = params({
    conversationState: visible.state,
    currentConversationIdRef: currentId,
    conversationRuntimeCacheRef: { current: cache },
    conversationPersistenceCursorRef: { current: cursors },
    conversationLoadSequenceRef: { current: 0 },
    markLocalHistorySnapshotSynced: noop,
    isConversationRunning: () => false,
    sidebarStore: {
      peek: () => undefined,
      upsertLocal: (item) => upserted.push(item),
    },
    titleJobRef: { current: null },
    t: (key) => key,
    buildRuntimeEntryFromVisibleState: () => entry(visible.state),
    syncVisibleConversationRuntime: (id, next) => {
      synced.push(id);
      visible.state = next.state;
    },
    updateConversationRuntimeEntry: (id, updater) => {
      const next = updater(cache.get(id));
      cache.set(id, next);
      return next;
    },
    cancelConversationLoad: noop,
    resetVisibleTransientState: noop,
    deleteConversationArtifacts: noop,
    resolveConversationSelectedModel: () => undefined,
    setCurrentConversationId: noop,
    setErrorMessage: (message) => errors.push(message),
    hydration: { markHydrating: noop, clearHydrating: noop, markFailed: noop },
  });
  function entry(state) {
    return {
      state,
      compactionStatus: { phase: "idle" },
      isSending: false,
      errorMessage: null,
      hookWarning: null,
      sessionId: "remote-1",
      createdAt: 1,
      workdir: "/repo",
    };
  }
  return { actions, cache, cursors, upserted, synced, errors, currentId, entry, visible };
}

test("revision conflict matcher accepts backend 409 and client guard text", () => {
  const { isKBrainRevisionConflict } = loadHistoryActions({});
  assert.equal(isKBrainRevisionConflict(conflictError()), true);
  assert.equal(isKBrainRevisionConflict(new Error("history revision conflict")), true);
  assert.equal(isKBrainRevisionConflict(new Error("K-brain history revision conflict")), true);
  assert.equal(isKBrainRevisionConflict(new Error("upstream unavailable")), false);
  assert.equal(isKBrainRevisionConflict("history revision conflict"), false);
});

test("retry preparation reloads a stale branch anchor once before creating the child", async () => {
  const old = buildState([userMessage("hello")], "rev-1");
  const fresh = buildState([userMessage("hello")], "rev-2");
  const ref = old.transcript.items.find(item => item.kind === "user").messageRef;
  const calls = [];
  let reloads = 0;
  const { branchConversationWithReload } = loadHistoryActions({
    branch: async (id, anchor) => {
      calls.push({ id, anchor });
      if (calls.length === 1) throw conflictError();
      return { id: "child" };
    },
  });
  const result = await branchConversationWithReload("conversation-1", ref, async id => {
    assert.equal(id, "conversation-1");
    reloads++;
    return { state: fresh, revision: "rev-2" };
  });
  assert.equal(result.id, "child");
  assert.equal(reloads, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].anchor, fresh.transcript.items.find(item => item.kind === "user").messageRef);
});

test("retry preparation refuses changed or missing message content after reload", async () => {
  const old = buildState([userMessage("hello")], "rev-1");
  const ref = old.transcript.items.find(item => item.kind === "user").messageRef;
  for (const messages of [[userMessage("changed")], [userMessage("other", 1, "u2")]]) {
    let calls = 0;
    const { branchConversationWithReload } = loadHistoryActions({
      branch: async () => { calls++; throw conflictError(); },
    });
    await assert.rejects(() => branchConversationWithReload("conversation-1", ref, async () => ({
      state: buildState(messages, "rev-2"), revision: "rev-2",
    })), /历史消息已发生变化/);
    assert.equal(calls, 1);
  }
});

test("retry preparation bounds conflicts and does not replay unrelated failures", async () => {
  const state = buildState([userMessage("hello")], "rev-1");
  const ref = state.transcript.items.find(item => item.kind === "user").messageRef;
  for (const conflict of [true, false]) {
    let calls = 0;
    let reloads = 0;
    const { branchConversationWithReload } = loadHistoryActions({
      branch: async () => { calls++; throw conflict ? conflictError() : new Error("network failed"); },
    });
    await assert.rejects(() => branchConversationWithReload("conversation-1", ref, async () => {
      reloads++;
      return { state, revision: "rev-1" };
    }), conflict ? /revision conflict/ : /network failed/);
    assert.equal(calls, conflict ? 2 : 1);
    assert.equal(reloads, conflict ? 1 : 0);
  }
});

test("reloaded message ref keeps content identity and drops a replaced message", () => {
  const { findReloadedMessageRef } = loadHistoryActions({});
  const stored = buildState([userMessage("hello"), assistantMessage("world")], "rev-1");
  const messageRef = stored.transcript.items.find((item) => item.kind === "user").messageRef;
  assert.ok(messageRef);

  const same = buildState([userMessage("hello"), assistantMessage("world")], "rev-2");
  const reloaded = findReloadedMessageRef(same, messageRef);
  assert.equal(reloaded.contentHash, messageRef.contentHash);

  // Same id but rewritten content: the caller's contentHash guard rejects it.
  const edited = buildState([userMessage("changed"), assistantMessage("world")], "rev-3");
  assert.notEqual(findReloadedMessageRef(edited, messageRef).contentHash, messageRef.contentHash);
  // Message no longer in the window at all.
  const dropped = buildState([userMessage("elsewhere", 1, "u9"), assistantMessage("world")], "rev-4");
  assert.equal(findReloadedMessageRef(dropped, messageRef), undefined);
});

test("edit-resend re-requests history and retries once on a revision conflict", async () => {
  const reads = [];
  const writes = [];
  const stored = [userMessage("hello"), assistantMessage("world")];
  const { useConversationHistoryActions } = loadHistoryActions({
    getWindow: async (params) => {
      reads.push(params);
      return windowRecord(stored, "rev-2");
    },
    replace: async (params) => {
      writes.push(params);
      if (params.expectedRevision === "rev-1") throw conflictError();
      return windowRecord([userMessage("edited"), assistantMessage("world")], "rev-3");
    },
  });
  const h = harness((params) => useConversationHistoryActions(params));
  const state = buildState(stored, "rev-1");
  h.cache.set("conversation-1", h.entry(state));
  const messageRef = state.transcript.items.find((item) => item.kind === "user").messageRef;

  // setErrorMessage(null) is a legitimate clear; only real messages count here.
  const errors = () => h.errors.filter(Boolean);
  const replaced = await h.actions.replaceConversationAtMessage(
    "conversation-1",
    messageRef,
    userMessage("edited"),
  );

  assert.equal(writes.length, 2);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].includeActiveSegment, true);
  assert.equal(reads[0].expectedRevision, undefined);
  assert.equal(writes[0].expectedRevision, "rev-1");
  assert.equal(writes[1].expectedRevision, "rev-2");
  assert.equal(writes[1].baseMessageRef.messageId, messageRef.messageId);
  assert.equal(writes[1].baseMessageRef.contentHash, messageRef.contentHash);
  assert.equal(h.cache.get("conversation-1").state.transcript.revision, "rev-3");
  assert.deepEqual(errors(), []);
  assert.equal(h.cursors.get("conversation-1").activeSegmentId, "kbrain:remote-1");
  // Reload commits its own row, then the successful replace commits again.
  assert.deepEqual(
    h.upserted.map((item) => item.conversationId ?? item.id),
    ["conversation-1", "conversation-1"],
  );
  assert.ok(replaced);
});

test("edit-resend surfaces a changed message instead of retrying blindly", async () => {
  const writes = [];
  const stored = [userMessage("hello"), assistantMessage("world")];
  const { useConversationHistoryActions } = loadHistoryActions({
    getWindow: async () => windowRecord([userMessage("rewritten elsewhere"), ...stored.slice(1)], "rev-2"),
    replace: async (params) => {
      writes.push(params);
      if (params.expectedRevision === "rev-1") throw conflictError();
      return windowRecord(stored, "rev-3");
    },
  });
  const h = harness((params) => useConversationHistoryActions(params));
  const state = buildState(stored, "rev-1");
  h.cache.set("conversation-1", h.entry(state));
  const messageRef = state.transcript.items.find((item) => item.kind === "user").messageRef;

  await assert.rejects(
    () => h.actions.replaceConversationAtMessage("conversation-1", messageRef, userMessage("edited")),
    /历史消息已发生变化/,
  );
  assert.equal(writes.length, 1);
});

test("non-conflict history failures still propagate without a reload read", async () => {
  const reads = [];
  const stored = [userMessage("hello"), assistantMessage("world")];
  const { useConversationHistoryActions } = loadHistoryActions({
    getWindow: async (params) => {
      reads.push(params);
      return windowRecord(stored, "rev-2");
    },
    replace: async () => {
      throw Object.assign(new Error("upstream unavailable"), { status: 502 });
    },
  });
  const h = harness((params) => useConversationHistoryActions(params));
  const state = buildState(stored, "rev-1");
  h.cache.set("conversation-1", h.entry(state));
  const messageRef = state.transcript.items.find((item) => item.kind === "user").messageRef;

  await assert.rejects(
    () => h.actions.replaceConversationAtMessage("conversation-1", messageRef, userMessage("edited")),
    /upstream unavailable/,
  );
  assert.deepEqual(reads, []);
});

test("loadEarlier refreshes its cursor revision and pages again on a conflict", async () => {
  const reads = [];
  const older = [userMessage("first", 1, "u0")];
  const { useConversationHistoryActions } = loadHistoryActions({
    getWindow: async (params) => {
      reads.push(params);
      if (params.expectedRevision === "rev-1") throw conflictError();
      if (params.includeActiveSegment) return windowRecord([userMessage("hello")], "rev-2");
      return { ...windowRecord(older, "rev-2"), oldestOffset: 0, hasMoreBefore: false };
    },
    replace: async () => windowRecord([], "rev-2"),
  });
  const h = harness((params) => useConversationHistoryActions(params));
  const state = {
    ...buildState([userMessage("hello")], "rev-1"),
    transcript: {
      ...buildState([userMessage("hello")], "rev-1").transcript,
      hasMoreBefore: true,
      oldestMessageOffset: 4,
    },
  };
  h.cache.set("conversation-1", h.entry(state));

  await h.actions.loadEarlier("conversation-1");

  assert.equal(reads.length, 3);
  assert.equal(reads[0].expectedRevision, "rev-1");
  assert.equal(reads[0].beforeOffset, 4);
  assert.equal(reads[1].expectedRevision, undefined);
  assert.equal(reads[2].expectedRevision, "rev-2");
  const next = h.cache.get("conversation-1").state;
  assert.equal(next.transcript.oldestMessageOffset, 0);
  assert.equal(next.transcript.hasMoreBefore, false);
  assert.equal(next.transcript.revision, "rev-2");
  assert.equal(next.transcript.items.filter((item) => item.kind === "user").length, 2);
});

test("loadEarlier keeps a non-conflict error for the caller", async () => {
  const { useConversationHistoryActions } = loadHistoryActions({
    getWindow: async () => {
      throw Object.assign(new Error("history unavailable"), { status: 500 });
    },
    replace: async () => windowRecord([], "rev-2"),
  });
  const h = harness((params) => useConversationHistoryActions(params));
  const state = {
    ...buildState([userMessage("hello")], "rev-1"),
    transcript: {
      ...buildState([userMessage("hello")], "rev-1").transcript,
      hasMoreBefore: true,
      oldestMessageOffset: 4,
    },
  };
  h.cache.set("conversation-1", h.entry(state));

  await assert.rejects(() => h.actions.loadEarlier("conversation-1"), /history unavailable/);
});

test("reloadConversation commits the fresh window into caches and the visible pane", async () => {
  const stored = [userMessage("hello"), assistantMessage("world")];
  const { useConversationHistoryActions } = loadHistoryActions({
    getWindow: async () => windowRecord(stored, "rev-9"),
    replace: async () => windowRecord(stored, "rev-9"),
  });
  const h = harness((params) => useConversationHistoryActions(params));
  h.cache.set("conversation-1", h.entry(buildState(stored, "rev-1")));

  const refreshed = await h.actions.reloadConversation("conversation-1");

  assert.equal(refreshed.revision, "rev-9");
  assert.equal(h.cache.get("conversation-1").state.transcript.revision, "rev-9");
  assert.deepEqual(h.synced, ["conversation-1"]);
  assert.equal(h.cursors.get("conversation-1").activeSegmentIndex, 0);
  assert.equal(h.upserted.length, 1);
});
