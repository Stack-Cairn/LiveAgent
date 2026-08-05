import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const chatAbort = loader.loadModule("src/lib/chat/conversation/chatAbort.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const requestContextSanitizer = loader.loadModule(
  "src/lib/chat/context/requestContextSanitizer.ts",
);

function user(content, timestamp) {
  return { role: "user", content, timestamp };
}

function toolCall(id, name = "Read", args = { path: "foo.txt" }) {
  return {
    type: "toolCall",
    id,
    name,
    arguments: args,
  };
}

function toolResult(id, name = "Read", text = "ok", timestamp = 3) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    details: { ok: true },
    isError: false,
    timestamp,
  };
}

test("persistable cancelled snapshot strips incomplete tool artifacts but keeps visible text", () => {
  const messages = chatAbort.buildPersistableMessagesFromSnapshot({
    executionMode: "agent",
    model: {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    },
    draftAssistantText: "",
    liveRounds: [
      {
        round: 1,
        blocks: [
          { kind: "text", text: "先看看这个文件。" },
          {
            kind: "tool",
            item: {
              toolCall: toolCall("call-1"),
              toolResult: toolResult("call-1"),
            },
          },
        ],
      },
    ],
    timestamp: 10,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].stopReason, "aborted");
  assert.deepEqual(messages[0].content, [{ type: "text", text: "先看看这个文件。" }]);
});

test("persistable cancelled snapshot keeps visible provider hosted search blocks", () => {
  const hostedSearch = {
    type: "hostedSearch",
    id: "search-1",
    provider: "codex",
    status: "searching",
    queries: ["LiveAgent web search"],
    sources: [],
  };
  const messages = chatAbort.buildPersistableMessagesFromSnapshot({
    executionMode: "text",
    model: {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    },
    draftAssistantText: "",
    liveRounds: [
      {
        round: 1,
        blocks: [{ kind: "hostedSearch", item: hostedSearch }],
      },
    ],
    timestamp: 10,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].stopReason, "aborted");
  assert.deepEqual(messages[0].content, [hostedSearch]);
});

test("persistable cancelled snapshot restores suppressed parent Agent trace without card artifacts", () => {
  const parentId = "call-parent|fc_parent";
  const cardId = `${parentId}:agent:1`;

  const parentToolCall = toolCall(parentId, "Agent", { agents: [] });
  const parentToolResult = {
    ...toolResult(parentId, "Agent", "batch done"),
    details: { kind: "subagent_batch" },
  };
  const messages = chatAbort.buildPersistableMessagesFromSnapshot({
    executionMode: "agent",
    model: {
      api: "openai-responses",
      provider: "codex",
      id: "gpt-5",
    },
    draftAssistantText: "",
    liveRounds: [
      {
        round: 1,
        blocks: [
          {
            kind: "tool",
            item: {
              toolCall: toolCall(cardId, "Agent", {
                subagent_card: true,
                parent_tool_call_id: parentId,
                id: "reviewer",
              }),
              toolResult: {
                ...toolResult(cardId, "Agent", "done"),
                details: { kind: "subagent_card" },
              },
            },
          },
        ],
      },
      {
        round: 2,
        blocks: [{ kind: "text", text: "Final visible text." }],
      },
    ],
    completedThroughRound: 1,
    suppressedToolTrace: [
      {
        round: 1,
        toolCall: parentToolCall,
        toolResult: parentToolResult,
      },
    ],
    timestamp: 10,
  });

  assert.deepEqual(
    messages.map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
  assert.equal(messages[0].stopReason, "toolUse");
  assert.deepEqual(
    messages[0].content.map((block) => (block.type === "toolCall" ? block.id : block.type)),
    [parentId],
  );
  assert.equal(messages[1].toolCallId, parentId);
  assert.equal(messages[2].stopReason, "aborted");
  assert.equal(JSON.stringify(messages).includes(cardId), false);
});

test("continuation request context skips cancelled rounds by default but can include them explicitly", () => {
  const state = conversationState.createConversationStateFromContext({
    messages: [
      user("先读取文件", 1),
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先读一下。" },
          toolCall("call-1"),
        ],
        stopReason: "aborted",
        timestamp: 2,
      },
      toolResult("call-1", "Read", "partial tool output", 3),
      user("继续", 4),
    ],
  });

  const requestContext = conversationState.buildRequestContext(state);
  assert.deepEqual(
    requestContext.messages.map((message) => message.role),
    ["user", "user"],
  );
  assert.deepEqual(
    requestContext.messages.map((message) => message.content),
    ["先读取文件", "继续"],
  );

  const rawContext = conversationState.buildRequestContext(state, {
    includeAbortedMessages: true,
  });
  assert.deepEqual(
    rawContext.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "user"],
  );
  assert.equal(rawContext.messages[1].content[1].type, "toolCall");
});

test("model request sanitizer drops aborted hosted search rounds", () => {
  const completedSearch = {
    type: "hostedSearch",
    id: "call_00_21yLmJkIP3NyfRTI1iVW2950",
    provider: "claude_code",
    status: "completed",
    queries: ["weibo-like-someone"],
    sources: [{ url: "https://github.com/superzhang21/weibo-like-someone" }],
  };
  const abortedSearch = {
    type: "hostedSearch",
    id: "call_01_PIQ9ADQKpEaBFU6f38f19272",
    provider: "claude_code",
    status: "completed",
    queries: ["second search"],
    sources: [{ url: "https://www.sourcepulse.org/projects/22643222" }],
  };

  const context = requestContextSanitizer.sanitizeContextForModelRequest({
    messages: [
      user("https://github.com/superzhang21/weibo-like-someone 请你多次联网搜索", 1),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "searching" },
          completedSearch,
        ],
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [abortedSearch],
        stopReason: "aborted",
        timestamp: 3,
      },
    ],
  });

  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.deepEqual(
    context.messages[1].content.map((block) => block.type),
    ["thinking"],
  );
  assert.doesNotMatch(JSON.stringify(context.messages), /Provider-hosted web search completed/);
  assert.doesNotMatch(JSON.stringify(context.messages), /Provider: claude_code/);
  assert.doesNotMatch(JSON.stringify(context.messages), /Sources:/);
  assert.doesNotMatch(JSON.stringify(context.messages), /call_01_PIQ9ADQKpEaBFU6f38f19272/);
});

test("model request sanitizer strips DSML from text and thinking blocks", () => {
  const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  const context = requestContextSanitizer.sanitizeContextForModelRequest({
    messages: [
      user("search", 1),
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: `before <${dsml}tool_calls><${dsml}invoke name="Read"></${dsml}invoke></${dsml}tool_calls> after`,
          },
          {
            type: "text",
            text: `visible <${dsml}tool_calls><${dsml}invoke name="Read"></${dsml}invoke></${dsml}tool_calls> answer`,
          },
        ],
        stopReason: "stop",
        timestamp: 2,
      },
    ],
  });

  const serialized = JSON.stringify(context.messages);
  assert.equal(serialized.includes("DSML"), false);
  assert.equal(context.messages[1].content[0].thinking, "before  after");
  assert.equal(context.messages[1].content[1].text, "visible  answer");
});

test("model request sanitizer drops assistant rounds that only contain hosted search metadata", () => {
  const context = requestContextSanitizer.sanitizeContextForModelRequest({
    messages: [
      user("search", 1),
      {
        role: "assistant",
        content: [
          {
            type: "hostedSearch",
            id: "search-only",
            provider: "claude_code",
            status: "completed",
            queries: ["only metadata"],
            sources: [{ url: "https://example.com/source" }],
          },
        ],
        stopReason: "stop",
        timestamp: 2,
      },
    ],
  });

  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user"],
  );
  const serialized = JSON.stringify(context.messages);
  assert.equal(serialized.includes("Provider-hosted web search"), false);
  assert.equal(serialized.includes("example.com/source"), false);
});

test("model request sanitizer removes persisted synthetic subagent cards", () => {
  const parentId = "call-parent|fc_parent";
  const cardId = `${parentId}:agent:1`;
  const context = requestContextSanitizer.sanitizeContextForModelRequest({
    messages: [
      user("delegate", 1),
      {
        role: "assistant",
        provider: "codex",
        api: "openai-responses",
        model: "gpt-5",
        content: [
          { type: "text", text: "Delegating work." },
          toolCall(cardId, "Agent", {
            subagent_card: true,
            parent_tool_call_id: parentId,
            id: "reviewer",
          }),
          toolCall(parentId, "Agent", { agents: [] }),
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        ...toolResult(cardId, "Agent", "done", 3),
        details: { kind: "subagent_card" },
      },
      {
        ...toolResult(parentId, "Agent", "batch done", 4),
        details: { kind: "subagent_batch" },
      },
      user("continue", 5),
    ],
  });

  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "user"],
  );
  assert.deepEqual(
    context.messages[1].content.map((block) =>
      block.type === "toolCall" ? block.id : block.type,
    ),
    ["text", parentId],
  );
  assert.equal(context.messages[2].toolCallId, parentId);
  assert.equal(JSON.stringify(context.messages).includes(cardId), false);
});
