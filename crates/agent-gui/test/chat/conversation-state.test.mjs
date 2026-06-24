import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");

function user(content, timestamp) {
  return { role: "user", content, timestamp };
}

function assistant(text, timestamp, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
    ...extra,
  };
}

test("conversation state builds request context from the active segment", () => {
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "Base prompt",
    tools: [{ name: "Read" }],
    messages: [
      user("hello", 1),
      assistant("world", 2),
    ],
  });

  assert.equal(state.meta.schemaVersion, 3);
  assert.equal(state.meta.totalMessageCount, 2);
  assert.equal(state.historyRenderItems.length, 2);

  const requestContext = conversationState.buildRequestContext(state);
  assert.equal(requestContext.systemPrompt, "Base prompt");
  assert.deepEqual(requestContext.tools, [{ name: "Read" }]);
  assert.deepEqual(
    requestContext.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("request context omits legacy silent memory extraction artifacts but keeps render items", () => {
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-1",
    name: "MemoryManager",
    arguments: {
      action: "update",
      slug: "daily-2026-05-14",
      mode: "append",
    },
  };
  const memoryToolAssistant = assistant("", 3, {
    content: [memoryToolCall],
    stopReason: "toolUse",
  });
  const memoryToolResult = {
    role: "toolResult",
    toolCallId: memoryToolCall.id,
    toolName: "MemoryManager",
    content: [{ type: "text", text: "Updated memory global/daily-2026-05-14" }],
    details: { updated: true, slug: "daily-2026-05-14" },
    isError: false,
    timestamp: 4,
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [
      user("以后请用陕西腔。", 1),
      assistant("没问题。", 2),
      memoryToolAssistant,
      memoryToolResult,
      assistant("记忆整理完成。", 5),
    ],
  });

  assert.equal(state.segments[0].messages.length, 5);
  assert.match(JSON.stringify(state.historyRenderItems), /MemoryManager/);
  assert.match(JSON.stringify(state.historyRenderItems), /记忆整理完成。/);

  const requestContext = conversationState.buildRequestContext(state);
  assert.deepEqual(
    requestContext.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /MemoryManager/);
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /记忆整理完成。/);
});

test("request context keeps direct MemoryManager conversations without a prior visible answer", () => {
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-direct",
    name: "MemoryManager",
    arguments: {
      action: "write",
      slug: "user-preference",
      scope: "global",
    },
  };
  const memoryToolAssistant = assistant("", 2, {
    content: [memoryToolCall],
    stopReason: "toolUse",
  });
  const memoryToolResult = {
    role: "toolResult",
    toolCallId: memoryToolCall.id,
    toolName: "MemoryManager",
    content: [{ type: "text", text: "Created memory global/user-preference" }],
    details: { created: true, slug: "user-preference" },
    isError: false,
    timestamp: 3,
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [
      user("请直接整理这条记忆。", 1),
      memoryToolAssistant,
      memoryToolResult,
      assistant("记忆整理完成。", 4),
    ],
  });

  const requestContext = conversationState.buildRequestContext(state);
  assert.equal(requestContext.messages.length, 4);
  assert.match(JSON.stringify(requestContext.messages), /MemoryManager/);
  assert.match(JSON.stringify(requestContext.messages), /记忆整理完成。/);
});

test("compaction checkpoint creates a summarized segment and carries summary into future requests", () => {
  const base = conversationState.createConversationStateFromContext({
    systemPrompt: "Base prompt",
    messages: [
      user("first question", 1),
      assistant("first answer", 2),
    ],
  });

  const checkpoint = assistant("Compressed facts", 3, {
    api: "liveagent-compaction",
    provider: "liveagent",
    model: "summary",
    responseId: "summary-1",
    promptVersion: "summary-v2",
  });

  const compacted = conversationState.applyCompactionCheckpoint(base, checkpoint);
  assert.equal(compacted.activeSegmentIndex, 1);
  assert.equal(compacted.segments.length, 2);
  assert.equal(compacted.segments[1].summary.id, "summary-1");
  assert.equal(compacted.segments[1].summary.content, "Compressed facts");
  assert.equal(compacted.segments[1].summary.summaryMeta.coveredMessageCount, 2);
  assert.equal(compacted.historyRenderItems[0].kind, "user");
  assert.equal(compacted.historyRenderItems[0].isFromCompactedSegment, true);
  assert.equal(compacted.historyRenderItems[2].kind, "summary");

  const withNextTurn = conversationState.appendMessagesToConversation(compacted, [
    user("next question", 4),
  ]);
  assert.equal(withNextTurn.activeSegmentIndex, 1);
  assert.equal(withNextTurn.segments[1].messages.length, 1);

  const requestContext = conversationState.buildRequestContext(withNextTurn);
  assert.match(requestContext.systemPrompt, /Previous Conversation Summary/);
  assert.match(requestContext.systemPrompt, /Compressed facts/);
  assert.deepEqual(
    requestContext.messages.map((message) => [message.role, message.content]),
    [["user", "next question"]],
  );
});

test("truncateConversationFromMessage removes later segments and rebuilds render timeline", () => {
  const state = conversationState.createConversationStateFromContext({
    messages: [
      { ...user("one", 1), id: "message-1" },
      { ...assistant("two", 2), id: "message-2" },
      { ...user("three", 3), id: "message-3" },
      { ...assistant("four", 4), id: "message-4" },
    ],
  });

  const target = state.historyRenderItems.find(
    (item) => item.kind === "user" && item.text === "three",
  );
  assert.ok(target?.messageRef);
  const truncated = conversationState.truncateConversationFromMessage(state, target.messageRef);

  assert.equal(truncated.activeSegmentIndex, 0);
  assert.deepEqual(
    truncated.segments[0].messages.map((message) => message.content?.[0]?.text ?? message.content),
    ["one", [{ type: "text", text: "two" }][0].text],
  );
  assert.equal(truncated.meta.totalMessageCount, 2);
  assert.equal(truncated.historyRenderItems.length, 2);
});

test("uploaded file metadata is stripped from request context but preserved for render items", () => {
  const uploadedMessage = {
    role: "user",
    content: "Please inspect file.txt\n\nSelected files are available...",
    timestamp: 1,
    liveAgentDisplayContent: "Please inspect file.txt",
    liveAgentAttachments: [
      {
        relativePath: "file.txt",
        fileName: "file.txt",
        kind: "text",
        sizeBytes: 12,
      },
    ],
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [uploadedMessage],
  });

  assert.equal(state.historyRenderItems[0].text, "Please inspect file.txt");
  assert.equal(state.historyRenderItems[0].attachments[0].relativePath, "file.txt");

  const requestContext = conversationState.buildRequestContext(state);
  assert.equal(requestContext.messages[0].liveAgentDisplayContent, undefined);
  assert.equal(requestContext.messages[0].liveAgentAttachments, undefined);
  assert.equal(requestContext.messages[0].content, uploadedMessage.content);
});

test("display-only Image tool results keep UI images but omit inline image bytes from request context", () => {
  const imageToolResult = {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "Image",
    content: [
      { type: "text", text: "Display images: 2" },
      { type: "image", mimeType: "image/png", data: "png-base64" },
      { type: "image", mimeType: "image/jpeg", data: "jpg-base64" },
    ],
    details: {
      kind: "display_image",
      loadMode: "inline",
      images: [
        {
          path: "uploads/001.png",
          mimeType: "image/png",
          sizeBytes: 1234,
          mtimeMs: 1,
          contentHash: "hash-png",
        },
        {
          path: "skill://demo/assets/logo.jpg",
          scope: "skill",
          relativePath: "demo/assets/logo.jpg",
          displayPath: "skill://demo/assets/logo.jpg",
          pathRef: "skill:demo/assets/logo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 5678,
          mtimeMs: 2,
          contentHash: "hash-jpg",
        },
      ],
    },
    isError: false,
    timestamp: 1,
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [imageToolResult],
  });

  assert.equal(
    state.segments[0].messages[0].content.filter((block) => block.type === "image").length,
    2,
  );

  const requestContext = conversationState.buildRequestContext(state);
  assert.equal(requestContext.messages.length, 1);
  assert.deepEqual(
    requestContext.messages[0].content.map((block) => block.type),
    ["text"],
  );
  assert.match(requestContext.messages[0].content[0].text, /Displayed 2 images/);
  assert.match(requestContext.messages[0].content[0].text, /uploads\/001\.png/);
  assert.match(requestContext.messages[0].content[0].text, /skill:\/\/demo\/assets\/logo\.jpg/);
  assert.match(requestContext.messages[0].content[0].text, /mime=image\/png/);
  assert.match(requestContext.messages[0].content[0].text, /display-only UI tool/);
});

test("model context sanitizer preserves user image content", () => {
  const userImageMessage = {
    role: "user",
    content: [
      { type: "text", text: "Please inspect this image" },
      { type: "image", mimeType: "image/png", data: "user-png-base64" },
    ],
    timestamp: 1,
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [userImageMessage],
  });

  const requestContext = conversationState.buildRequestContext(state);
  assert.deepEqual(requestContext.messages[0].content, userImageMessage.content);
});
