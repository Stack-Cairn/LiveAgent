import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const conversationState = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
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
