import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const chatHistoryParserPath = fileURLToPath(
  new URL("../../src/lib/chat/history/chatHistoryParser.ts", import.meta.url),
);

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createInvokeRecorder() {
  const calls = [];
  return {
    calls,
    invoke(cmd, args) {
      const deferred = createDeferred();
      calls.push({ cmd, args, deferred });
      return deferred.promise;
    },
  };
}

function loadChatHistory(invoke) {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke },
      [chatHistoryParserPath]: {
        async parseHistorySegments(segments) {
          return segments.map(({ payload }) => ({ payload, messages: [] }));
        },
      },
    },
  });
  return loader.loadModule("src/lib/chat/history/chatHistory.ts");
}

function segment(index, overrides = {}) {
  return {
    segmentIndex: index,
    segmentId: `seg-${index}`,
    messages: [],
    messageCount: 0,
    createdAt: 100 + index,
    updatedAt: 100 + index,
    ...overrides,
  };
}

function buildState(segments, activeSegmentIndex) {
  return {
    meta: {
      schemaVersion: 3,
      systemPrompt: "prompt",
      activeSegmentIndex: segments[activeSegmentIndex].segmentIndex,
      totalSegmentCount: segments.length,
      totalMessageCount: segments.reduce((sum, item) => sum + item.messageCount, 0),
    },
    segments,
    transcript: {
      items: [],
      segments: [],
      segmentWindows: [],
      oldestMessageOffset: 0,
      hasMoreBefore: false,
      revision: null,
    },
    activeSegmentIndex,
  };
}

function persistenceCursor(item) {
  return {
    activeSegmentIndex: item.segmentIndex,
    activeSegmentId: item.segmentId,
  };
}

function summaryFor(conversationId, updatedAt) {
  return {
    id: conversationId,
    title: "对话",
    providerId: "anthropic",
    model: "claude",
    createdAt: 1,
    updatedAt,
  };
}

function persistParams({
  conversationId = "conv-1",
  cursorRef,
  cursorReads,
  cursorCommits,
  state,
}) {
  return {
    conversationId,
    providerId: "anthropic",
    model: "claude",
    title: "对话",
    updatedAt: state.segments[state.activeSegmentIndex].updatedAt,
    state,
    getPersistenceCursor: () => {
      const current = cursorRef.current ? { ...cursorRef.current } : null;
      cursorReads?.push(current);
      return current;
    },
    commitPersistenceCursor: (cursor) => {
      const committed = { ...cursor };
      cursorCommits?.push(committed);
      cursorRef.current = committed;
    },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function resolveCall(call, conversationId, updatedAt) {
  call.deferred.resolve(summaryFor(conversationId, updatedAt));
  await flush();
}

const seg0 = segment(0, { messageCount: 2, endMessageId: "m-2" });
const seg1Initial = segment(1, { messageCount: 1, endMessageId: "m-3" });
const seg1Grown = segment(1, {
  messageCount: 3,
  endMessageId: "m-5",
  updatedAt: 205,
});
const stateWithAppendedSegment = buildState([seg0, seg1Initial], 1);
const stateWithGrownActiveSegment = buildState([seg0, seg1Grown], 1);

test("queued persists read the latest persistence cursor inside the conversation lock", async () => {
  const recorder = createInvokeRecorder();
  const chatHistory = loadChatHistory(recorder.invoke);
  const cursorRef = { current: persistenceCursor(seg0) };
  const cursorReads = [];
  const cursorCommits = [];

  const first = chatHistory.persistConversationRuntime(
    persistParams({
      cursorRef,
      cursorReads,
      cursorCommits,
      state: stateWithAppendedSegment,
    }),
  );
  const second = chatHistory.persistConversationRuntime(
    persistParams({
      cursorRef,
      cursorReads,
      cursorCommits,
      state: stateWithGrownActiveSegment,
    }),
  );
  await flush();

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].cmd, "chat_history_append_segment");
  assert.deepEqual(cursorReads, [persistenceCursor(seg0)]);

  await resolveCall(recorder.calls[0], "conv-1", 10);

  assert.equal(recorder.calls.length, 2);
  assert.equal(recorder.calls[1].cmd, "chat_history_upsert_active_segment");
  assert.equal(recorder.calls[1].args.input.segment.messageCount, 3);
  assert.deepEqual(cursorReads, [persistenceCursor(seg0), persistenceCursor(seg1Initial)]);

  await resolveCall(recorder.calls[1], "conv-1", 11);
  await first;
  await second;
  assert.deepEqual(cursorRef.current, persistenceCursor(seg1Initial));
  assert.deepEqual(cursorCommits, [
    persistenceCursor(seg1Initial),
    persistenceCursor(seg1Initial),
  ]);
});

test("failed persist does not advance the cursor and the next persist retries the transition", async () => {
  const recorder = createInvokeRecorder();
  const chatHistory = loadChatHistory(recorder.invoke);
  const cursorRef = { current: persistenceCursor(seg0) };
  const cursorCommits = [];

  const first = chatHistory.persistConversationRuntime(
    persistParams({
      cursorRef,
      cursorCommits,
      state: stateWithAppendedSegment,
    }),
  );
  await flush();
  assert.equal(recorder.calls[0].cmd, "chat_history_append_segment");
  recorder.calls[0].deferred.reject(new Error("db busy"));
  await assert.rejects(first, /db busy/);
  assert.deepEqual(cursorRef.current, persistenceCursor(seg0));
  assert.deepEqual(cursorCommits, []);

  const second = chatHistory.persistConversationRuntime(
    persistParams({
      cursorRef,
      cursorCommits,
      state: stateWithGrownActiveSegment,
    }),
  );
  await flush();

  assert.equal(recorder.calls.length, 2);
  assert.equal(recorder.calls[1].cmd, "chat_history_append_segment");
  await resolveCall(recorder.calls[1], "conv-1", 12);
  await second;
  assert.deepEqual(cursorRef.current, persistenceCursor(seg1Grown));
  assert.deepEqual(cursorCommits, [persistenceCursor(seg1Grown)]);
});

test("persistence cursor selects explicit initial active and append transitions", async () => {
  const recorder = createInvokeRecorder();
  const chatHistory = loadChatHistory(recorder.invoke);
  const conversationId = "conv-transitions";
  const cursorRef = { current: null };
  const initialSegment = segment(0, { messageCount: 1, endMessageId: "m-1" });
  const grownSegment = segment(0, {
    messageCount: 2,
    endMessageId: "m-2",
    updatedAt: 150,
  });
  const appendedSegment = segment(1, { messageCount: 1, endMessageId: "m-3" });

  const initial = chatHistory.persistConversationRuntime(
    persistParams({
      conversationId,
      cursorRef,
      state: buildState([initialSegment], 0),
    }),
  );
  await flush();
  assert.equal(recorder.calls[0].cmd, "chat_history_upsert");
  assert.equal(recorder.calls[0].args.input.segments.length, 1);
  await resolveCall(recorder.calls[0], conversationId, 20);
  await initial;
  assert.deepEqual(cursorRef.current, persistenceCursor(initialSegment));

  const active = chatHistory.persistConversationRuntime(
    persistParams({
      conversationId,
      cursorRef,
      state: buildState([grownSegment], 0),
    }),
  );
  await flush();
  assert.equal(recorder.calls[1].cmd, "chat_history_upsert_active_segment");
  assert.equal(recorder.calls[1].args.input.segment.messageCount, 2);
  await resolveCall(recorder.calls[1], conversationId, 21);
  await active;
  assert.deepEqual(cursorRef.current, persistenceCursor(grownSegment));

  const append = chatHistory.persistConversationRuntime(
    persistParams({
      conversationId,
      cursorRef,
      state: buildState([grownSegment, appendedSegment], 1),
    }),
  );
  await flush();
  assert.equal(recorder.calls[2].cmd, "chat_history_append_segment");
  assert.equal(recorder.calls[2].args.input.segment.segmentId, "seg-1");
  await resolveCall(recorder.calls[2], conversationId, 22);
  await append;
  assert.deepEqual(cursorRef.current, persistenceCursor(appendedSegment));
});

test("history mutations share the per-conversation lock with runtime persistence", async () => {
  const recorder = createInvokeRecorder();
  const chatHistory = loadChatHistory(recorder.invoke);
  const cursorRef = { current: persistenceCursor(seg0) };

  const persist = chatHistory.persistConversationRuntime(
    persistParams({ cursorRef, state: stateWithAppendedSegment }),
  );
  const rename = chatHistory.renameChatHistory("conv-1", "新标题");
  await flush();

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].cmd, "chat_history_append_segment");

  await resolveCall(recorder.calls[0], "conv-1", 30);
  assert.deepEqual(cursorRef.current, persistenceCursor(seg1Initial));
  assert.equal(recorder.calls.length, 2);
  assert.equal(recorder.calls[1].cmd, "chat_history_rename");
  assert.deepEqual(recorder.calls[1].args, { id: "conv-1", title: "新标题" });

  await resolveCall(recorder.calls[1], "conv-1", 31);
  await persist;
  await rename;
});

test("edit-resend uses one atomic replace command that returns the refreshed tail window", async () => {
  const recorder = createInvokeRecorder();
  const chatHistory = loadChatHistory(recorder.invoke);
  const replacementMessage = {
    role: "user",
    id: "user-replacement",
    content: "edited prompt",
    timestamp: 500,
  };
  const task = chatHistory.replaceChatHistoryFromMessage({
    id: "conv-1",
    baseMessageRef: {
      segmentIndex: 0,
      messageIndex: 2,
      segmentId: "seg-0",
      messageId: "user-old",
      role: "user",
      contentHash: "fnv1a32:12345678",
    },
    replacementMessage,
    maxMessages: 360,
    expectedRevision: "conv-1:before",
  });
  await flush();

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].cmd, "chat_history_replace_from_message");
  assert.deepEqual(recorder.calls[0].args, {
    id: "conv-1",
    baseMessageRef: {
      segmentIndex: 0,
      messageIndex: 2,
      segmentId: "seg-0",
      messageId: "user-old",
      role: "user",
      contentHash: "fnv1a32:12345678",
    },
    replacementMessage,
    maxMessages: 360,
    expectedRevision: "conv-1:before",
  });

  recorder.calls[0].deferred.resolve({
    conversation: summaryFor("conv-1", 501),
    contextMetaJson: JSON.stringify({ systemPrompt: "prompt" }),
    activeSegmentIndex: 0,
    totalSegmentCount: 1,
    totalMessageCount: 3,
    returnedMessageCount: 3,
    oldestOffset: 0,
    hasMoreBefore: false,
    revision: "conv-1:after",
    updatedAt: 501,
    activeSegment: {
      segmentIndex: 0,
      segmentId: "seg-0",
      messagesJson: JSON.stringify([replacementMessage]),
      messageCount: 3,
      createdAt: 100,
      updatedAt: 500,
    },
    segments: [
      {
        segmentIndex: 0,
        segmentId: "seg-0",
        messagesJson: JSON.stringify([replacementMessage]),
        startMessageIndex: 0,
        messageCount: 3,
        createdAt: 100,
        updatedAt: 500,
      },
    ],
  });

  const result = await task;
  assert.equal(result.revision, "conv-1:after");
  assert.equal(result.activeSegment.segmentId, "seg-0");
  assert.equal(result.meta.totalMessageCount, 3);
});
