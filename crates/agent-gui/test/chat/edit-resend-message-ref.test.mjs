import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const conversationState = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const gatewayBridgeEvents = loader.loadModule(
  "src/lib/chat/conversation/run/gatewayBridgeEvents.ts",
);

// ---------------------------------------------------------------------------
// The new user message's stable identity must enter the chat event stream:
// without it, remote transcripts create ref-less turns and the NEXT
// edit-resend's rebased event cannot find its truncation anchor (every past
// edit version then piles up as its own user bubble on the WebUI).

function buildStateWithUserMessage(messageId, text) {
  const state = conversationState.createConversationStateFromContext({
    messages: [],
  });
  return conversationState.appendMessagesToConversation(state, [
    { role: "user", id: messageId, content: text, timestamp: 1000 },
  ]);
}

test("findHistoryMessageRefByMessageId locates the appended user message", () => {
  const state = buildStateWithUserMessage("user-abc", "hello there");
  const ref = conversationState.findHistoryMessageRefByMessageId(state, "user-abc");
  assert.ok(ref, "ref found for the appended message");
  assert.equal(ref.messageId, "user-abc");
  assert.equal(ref.role, "user");
  assert.equal(ref.segmentId, state.segments[state.activeSegmentIndex].segmentId);
  assert.match(ref.contentHash, /^fnv1a32:[0-9a-f]{8}$/);
  assert.equal(
    ref.contentHash,
    conversationState.getHistoryMessageContentHash(
      state.segments[state.activeSegmentIndex].messages.at(-1),
    ),
    "hash matches the canonical content hash",
  );
});

test("findHistoryMessageRefByMessageId returns undefined for unknown or blank ids", () => {
  const state = buildStateWithUserMessage("user-abc", "hello there");
  assert.equal(conversationState.findHistoryMessageRefByMessageId(state, "user-zzz"), undefined);
  assert.equal(conversationState.findHistoryMessageRefByMessageId(state, "   "), undefined);
});

// 与 Rust history_message_content_hash 的跨语言对齐校验：fixture 与期望哈希和
// src-tauri/src/commands/history/chat_history/tests.rs 中的
// history_message_content_hash_matches_frontend_fixture 逐字面值一致。
// 任何一侧改动哈希算法都必须同步更新两处。
test("content hash stays byte-aligned with the Rust implementation", () => {
  const plain = { role: "user", id: "user-plain", content: "hello there", timestamp: 1000 };
  const emptyRefs = { ...plain, liveAgentReferencedConversations: [] };
  const withRefs = {
    role: "user",
    id: "user-refs",
    content: "hello there\n\nThe user attached the files below to this message.",
    timestamp: 1000,
    liveAgentDisplayContent: "hello there",
    liveAgentAttachments: [
      { relativePath: "notes/spec.md", fileName: "spec.md", kind: "text", sizeBytes: 2048 },
    ],
    liveAgentReferencedConversations: [
      {
        id: " conv-alpha ",
        title: "  Fix   login\tflow ",
        cwd: " /tmp/work ",
        updatedAt: 1735689600123,
      },
      { id: "conv-beta", title: "训练 β 运行" },
      { id: "conv-alpha", title: "duplicate entry" },
      { id: "conv-gamma", title: "third reference" },
      { id: "conv-delta", title: "over the cap" },
    ],
  };

  assert.equal(conversationState.getHistoryMessageContentHash(plain), "fnv1a32:73027b85");
  // 空引用数组不追加哈希段：与无引用消息哈希一致，保证旧历史向后兼容。
  assert.equal(conversationState.getHistoryMessageContentHash(emptyRefs), "fnv1a32:73027b85");
  // 归一化（id 修剪、标题折叠空白、去重、上限 3）后的引用参与哈希。
  assert.equal(conversationState.getHistoryMessageContentHash(withRefs), "fnv1a32:87daff4d");
});

function collectEvents() {
  const events = [];
  const controller = gatewayBridgeEvents.createGatewayBridgeEventController({
    conversationId: "conv-1",
    requestId: "run-1",
    enabled: true,
    sendEvent: (_requestId, event) => {
      events.push(event);
    },
  });
  return { events, controller };
}

const sampleRef = {
  segmentIndex: 0,
  messageIndex: 3,
  segmentId: "segment-a",
  messageId: "user-new",
  role: "user",
  contentHash: "fnv1a32:0badf00d",
};

test("queueUserMessage carries the new message's own message_ref on every send", () => {
  const { events, controller } = collectEvents();
  controller.queueUserMessage("plain prompt", [], { messageRef: sampleRef });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].message_ref, {
    segment_index: 0,
    message_index: 3,
    segment_id: "segment-a",
    message_id: "user-new",
    role: "user",
    content_hash: "fnv1a32:0badf00d",
  });
  assert.equal(events[0].base_message_ref, undefined, "plain send has no truncation base");
  assert.equal(events[0].reason, undefined);
});

test("queueUserMessage carries normalized conversation references for remote viewers", () => {
  const { events, controller } = collectEvents();
  controller.queueUserMessage("compare prior work", [], {
    referencedConversations: [
      { id: "conv-1", title: "Self" },
      {
        id: " conversation-source ",
        title: " Earlier\u0085investigation ",
        cwd: " /workspace/source ",
        updatedAt: 1772000000000,
      },
      { id: "conversation-source", title: "Duplicate" },
    ],
  });

  assert.deepEqual(events[0].referenced_conversations, [
    {
      id: "conversation-source",
      title: "Earlier investigation",
      cwd: "/workspace/source",
      updated_at: 1772000000000,
    },
  ]);
});

test("queueUserMessage keeps base_message_ref and message_ref separate for edit-resend", () => {
  const { events, controller } = collectEvents();
  const baseRef = { ...sampleRef, messageId: "user-old", contentHash: "fnv1a32:deadbeef" };
  controller.queueUserMessage("edited prompt", [], {
    baseMessageRef: baseRef,
    messageRef: sampleRef,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "edit_resend");
  assert.equal(events[0].base_message_ref.message_id, "user-old");
  assert.equal(events[0].message_ref.message_id, "user-new");
});
