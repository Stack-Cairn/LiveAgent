import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

// The chat turn queue itself lives in the desktop GUI (the gateway relays
// snapshots); the web module keeps only the composer-side content check.
const loader = createWebModuleLoader();
const { queuedChatTurnHasContent } = loader.loadModule(
  "@liveagent/ui/lib/chat/queuedChatTurn.ts",
);

function draft(overrides = {}) {
  return {
    isEmpty: false,
    text: "hello",
    textWithoutLargePastes: "hello",
    largePastes: [],
    segments: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

test("queuedChatTurnHasContent accepts drafts with text", () => {
  assert.equal(queuedChatTurnHasContent(draft(), []), true);
});

test("queuedChatTurnHasContent accepts empty drafts with uploads", () => {
  const uploads = [
    {
      relativePath: "notes.md",
      absolutePath: "/workspace/notes.md",
      fileName: "notes.md",
      kind: "text",
      sizeBytes: 12,
    },
  ];
  assert.equal(queuedChatTurnHasContent(draft({ isEmpty: true, text: "" }), uploads), true);
});

test("queuedChatTurnHasContent rejects missing or empty drafts", () => {
  assert.equal(queuedChatTurnHasContent(null, []), false);
  assert.equal(queuedChatTurnHasContent(undefined, []), false);
  assert.equal(queuedChatTurnHasContent(draft({ isEmpty: true, text: "   " }), []), false);
});

test("queuedChatTurnHasContent treats structured-only drafts as content", () => {
  assert.equal(
    queuedChatTurnHasContent(draft({ isEmpty: false, text: "" }), []),
    true,
    "non-empty draft flag wins even without plain text",
  );
});

const actionLoader = createWebModuleLoader({
  mocks: {
    "@/lib/chatUi": { buildOptimisticConversationTitle: (text) => text },
    "@/lib/settings": {
      applyConversationThinking: (_controls, runtimeControls) => runtimeControls,
      normalizeChatRuntimeControlsForProvider: (controls) => controls,
    },
    "./chatDraft": {
      buildTextFromComposerDraft: (value) => value.text,
      importPastedTextsAsFiles: async () => ({ fileByPasteId: new Map(), files: [] }),
    },
    "./chatEventUtils": {
      asErrorMessage: (error, fallback) => error?.message || String(error || fallback),
      buildGatewaySelectedModel: () => undefined,
      buildGatewaySystemSettings: () => undefined,
      isAbortError: () => false,
    },
  },
});
const { createGatewayChatCommandActions } = actionLoader.loadModule(
  "src/app/gatewayChatCommandActions.ts",
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function queueBindingHarness() {
  let conversationId = "__local_draft__:one";
  let content = draft();
  const calls = [];
  const binding = deferred();
  const uploads = new Map();
  const api = {
    chatCommand: async (input) => { calls.push(["chat", input]); return { runId: "run-two", conversationId, acceptedSeq: 2 }; },
  };
  const options = {
    api,
    apiRef: { current: api },
    activeProviders: [],
    activeWorkspaceProjectPath: "/workspace",
    activityStore: { get: () => null },
    applyChatQueueSnapshot: () => {},
    chatCommandPipeline: {
      resolveConversationId: () => "__local_draft__:one",
      hasPending: () => true,
      waitForConversationBinding: async () => {
        const next = await binding.promise;
        conversationId = next;
        return next;
      },
      submit: async () => ({ kind: "accepted", accepted: { runId: "run-one" } }),
    },
    chatQueueRevisionRef: { current: 0 },
    chatRuntimeControlsForCurrentProvider: {},
    clearCachedComposerDraft: (id) => calls.push(["clear-cache", id]),
    composerRef: { current: {
      getDraft: () => content,
      hasContent: () => Boolean(content?.text),
      clear: () => { content = draft({ isEmpty: true, text: "" }); calls.push(["clear", conversationId]); },
      setDraft: (value) => { content = value; },
    } },
    conversationIdRef: { current: conversationId },
    conversationWorkdirsRef: { current: new Map() },
    displayedConversationWorkdirRef: { current: "/workspace" },
    draftClientRequestsRef: { current: new Map() },
    getDisplayedConversationId: () => conversationId,
    getPendingUploadsForConversation: (id) => uploads.get(id) || [],
    isAgentMode: false,
    isDisplayedConversation: (id) => id === conversationId,
    isImportingPastedTextRef: { current: false },
    isLocalDraftConversationId: (id) => id.startsWith("__local_draft__:"),
    pendingUploadedFiles: [],
    prepareChatRuntime: async () => {},
    protectedConversationRef: { current: conversationId },
    queuedChatEditSessionRef: { current: null },
    queuedChatEditPendingRef: { current: false },
    visibleConversationRevisionRef: { current: 0 },
    refreshChatQueueSnapshot: () => {},
    resolveActiveAgentID: async () => "agent",
    selectedHistoryIdRef: { current: conversationId },
    selectionForConversation: () => undefined,
    sendChatRef: { current: null },
    setChatError: () => {},
    setConversationId: (id) => { conversationId = id; },
    setPendingUploadsForConversation: (id, files) => uploads.set(id, files),
    setSelectedHistoryId: () => {},
    setUploadingFiles: () => {},
    settings: { chatRuntimeControls: {}, system: { workdir: "/workspace" } },
    sidebarStore: { peek: () => undefined, upsertLocal: () => {} },
    token: "token",
    transcriptFollow: { stickToBottom: () => {} },
    transcriptStoreRegistry: { peek: () => null, get: () => null },
  };
  globalThis.window = { requestAnimationFrame: (fn) => fn() };
  return {
    options,
    calls,
    actions: createGatewayChatCommandActions(options),
    resolveBinding: (id) => binding.resolve(id),
    content: () => content,
  };
}

test("follow-up queue submission waits for draft binding and targets canonical conversation", async () => {
  const h = queueBindingHarness();
  const sending = h.actions.submitCurrentComposerToGuiQueue("append");
  await Promise.resolve();
  assert.equal(h.calls.some(([kind]) => kind === "chat"), false);
  h.resolveBinding("conversation-one");
  assert.equal(await sending, true);
  const request = h.calls.find(([kind]) => kind === "chat")[1];
  assert.equal(request.conversationId, "conversation-one");
  assert.equal(h.content().text, "");
});

function editHarness() {
  let conversationId = "conversation-a";
  let content = draft({ isEmpty: true, text: "" });
  const calls = [];
  const uploads = new Map();
  const snapshot = { conversationId, revision: 2, items: [] };
  const response = {
    accepted: true,
    snapshot,
    item: { id: "item-a", draftJson: JSON.stringify(draft()), uploadedFilesJson: "[]" },
  };
  const api = {
    chatQueueEditBegin: async (...args) => { calls.push(["begin", ...args]); return response; },
    chatQueueEditCommit: async (input) => { calls.push(["commit", input]); return { accepted: true, snapshot }; },
    chatQueueEditCancel: async (...args) => { calls.push(["cancel", ...args]); return { accepted: true, snapshot }; },
  };
  const options = {
    api, apiRef: { current: api },
    queuedChatEditSessionRef: { current: null },
    queuedChatEditPendingRef: { current: false },
    visibleConversationRevisionRef: { current: 0 },
    chatQueueRevisionRef: { current: 2 },
    composerRef: { current: {
      getDraft: () => content,
      setDraft: (value) => { content = value; },
      clear: () => { content = null; calls.push(["clear", conversationId]); },
      focus: () => calls.push(["focus", conversationId]),
    } },
    getDisplayedConversationId: () => conversationId,
    isDisplayedConversation: (id) => id === conversationId,
    getPendingUploadsForConversation: (id) => uploads.get(id) || [],
    setPendingUploadsForConversation: (id, files) => uploads.set(id, files),
    clearCachedComposerDraft: (id) => calls.push(["clear-cache", id]),
    applyChatQueueSnapshot: (value) => calls.push(["snapshot", value]),
    setChatError: (value) => calls.push(["error", value]),
    sendChatRef: { current: null },
  };
  globalThis.window = { requestAnimationFrame: (fn) => fn() };
  return {
    options, api, calls, response, uploads,
    actions: createGatewayChatCommandActions(options),
    content: () => content,
    setContent: (value) => { content = value; },
    switchTo: (id) => { conversationId = id; options.visibleConversationRevisionRef.current++; },
  };
}

test("queue edit cancel restores the removed item using its original conversation", async () => {
  const h = editHarness();
  await h.actions.editQueuedTurn("item-a");
  h.switchTo("__local_draft__:b");
  h.setContent(draft({ text: "new local draft" }));
  assert.equal(await h.actions.cancelQueuedChatEdit(), true);
  assert.deepEqual(h.calls.find(([kind]) => kind === "cancel"), ["cancel", "conversation-a", "item-a"]);
  assert.equal(h.content().text, "new local draft");
  assert.equal(h.options.queuedChatEditSessionRef.current, null);
});

test("queue edit never commits another conversation's composer", async () => {
  const h = editHarness();
  await h.actions.editQueuedTurn("item-a");
  h.switchTo("__local_draft__:b");
  assert.equal(await h.actions.commitQueuedChatEdit(), false);
  assert.equal(h.calls.some(([kind]) => kind === "commit"), false);
});

test("queue edit commit captures uploads and does not clear a switched composer", async () => {
  const h = editHarness();
  await h.actions.editQueuedTurn("item-a");
  const pending = deferred();
  h.uploads.set("conversation-a", [{ fileName: "a.txt" }]);
  h.api.chatQueueEditCommit = async (input) => { h.calls.push(["commit", input]); return pending.promise; };
  const committed = h.actions.commitQueuedChatEdit();
  assert.equal(await h.actions.cancelQueuedChatEdit(), false);
  assert.equal(await h.actions.commitQueuedChatEdit(), false);
  h.switchTo("conversation-b");
  h.setContent(draft({ text: "other draft" }));
  pending.resolve({ accepted: true });
  assert.equal(await committed, true);
  assert.equal(h.content().text, "other draft");
  const input = h.calls.find(([kind]) => kind === "commit")[1];
  assert.equal(input.conversationId, "conversation-a");
  assert.equal(input.itemId, "item-a");
  assert.equal(input.revision, 2);
  assert.deepEqual(JSON.parse(input.uploadedFilesJson), [{ fileName: "a.txt" }]);
});

test("late edit_begin restores its slot instead of replacing the new local draft", async () => {
  const h = editHarness();
  const pending = deferred();
  h.api.chatQueueEditBegin = () => pending.promise;
  const opening = h.actions.editQueuedTurn("item-a");
  h.switchTo("__local_draft__:b");
  h.setContent(draft({ text: "new draft" }));
  pending.resolve(h.response);
  await opening;
  assert.deepEqual(h.calls.find(([kind]) => kind === "cancel"), ["cancel", "conversation-a", "item-a"]);
  assert.equal(h.content().text, "new draft");
  assert.equal(h.options.queuedChatEditSessionRef.current, null);
  assert.equal(h.calls.some(([kind]) => kind === "focus"), false);
});

test("late edit_begin detects switch-away-and-back and suppresses duplicate begins", async () => {
  const h = editHarness();
  const pending = deferred();
  let begins = 0;
  h.api.chatQueueEditBegin = () => { begins++; return pending.promise; };
  const opening = h.actions.editQueuedTurn("item-a");
  await h.actions.editQueuedTurn("item-b");
  h.switchTo("conversation-b");
  h.switchTo("conversation-a");
  pending.resolve(h.response);
  await opening;
  assert.equal(begins, 1);
  assert.equal(h.calls.filter(([kind]) => kind === "cancel").length, 1);
});

for (const operation of ["Commit", "Cancel"]) {
  test(`rejected queue edit ${operation.toLowerCase()} retains draft and session for retry`, async () => {
    const h = editHarness();
    await h.actions.editQueuedTurn("item-a");
    h.api[`chatQueueEdit${operation}`] = async () => ({ accepted: false, message: "retry me" });
    assert.equal(await h.actions[`${operation.toLowerCase()}QueuedChatEdit`](), false);
    assert.equal(h.content().text, "hello");
    assert.equal(h.options.queuedChatEditSessionRef.current.itemId, "item-a");
    assert.equal(h.options.queuedChatEditSessionRef.current.operation, undefined);
  });
}

test("malformed edit_begin payload cancels the server edit", async () => {
  const h = editHarness();
  h.response.item.draftJson = "{";
  await h.actions.editQueuedTurn("item-a");
  assert.equal(h.calls.filter(([kind]) => kind === "cancel").length, 1);
  assert.equal(h.options.queuedChatEditSessionRef.current, null);
});

test("stale edit_begin cancellation does not clear a draft after switching away and back", async () => {
  const h = editHarness();
  const pending = deferred();
  h.api.chatQueueEditBegin = () => pending.promise;
  const opening = h.actions.editQueuedTurn("item-a");
  h.switchTo("conversation-b");
  h.switchTo("conversation-a");
  h.setContent(draft({ text: "replacement draft" }));
  pending.resolve(h.response);
  await opening;
  assert.equal(h.content().text, "replacement draft");
});

test("a failed in-flight save after navigation cancels the original edit", async () => {
  const h = editHarness();
  await h.actions.editQueuedTurn("item-a");
  const pending = deferred();
  h.api.chatQueueEditCommit = () => pending.promise;
  const saving = h.actions.commitQueuedChatEdit();
  h.switchTo("conversation-b");
  h.setContent(draft({ text: "replacement draft" }));
  pending.resolve({ accepted: false });
  assert.equal(await saving, false);
  assert.deepEqual(h.calls.find(([kind]) => kind === "cancel"), ["cancel", "conversation-a", "item-a"]);
  assert.equal(h.content().text, "replacement draft");
});
