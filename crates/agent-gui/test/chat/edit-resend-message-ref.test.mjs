import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const conversationState = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const backendBridgeEvents = loader.loadModule(
  "src/lib/chat/conversation/run/bridgeEvents.ts",
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

function collectEvents() {
  const events = [];
  const controller = backendBridgeEvents.createBackendBridgeEventController({
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
