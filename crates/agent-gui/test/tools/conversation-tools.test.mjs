import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function toolCall(conversationId, argumentsValue = {}) {
  return {
    type: "toolCall",
    id: `read-${conversationId}`,
    name: "ReadConversation",
    arguments: { conversation_id: conversationId, ...argumentsValue },
  };
}

function loadConversationTools() {
  return createTsModuleLoader({
    mocks: {
      "../chat/history/chatHistory": {
        getChatHistoryWindow() {
          throw new Error("injected history loader was expected");
        },
      },
      "@liveagent/ui/components/chat/MentionComposerModel": {
        MAX_CONVERSATION_MENTIONS: 3,
      },
      "@liveagent/ui/lib/chat/uiMessages": {
        getMessageText(message) {
          return message.content?.find((part) => part.type === "text")?.text ?? "";
        },
      },
    },
  }).loadModule("src/lib/tools/conversationTools.ts");
}

test("ReadConversation is exposed in the shared system-tool catalog", () => {
  const { BUILTIN_TOOL_CATALOG } = createTsModuleLoader().loadModule(
    "@liveagent/ui/lib/tools/builtinToolCatalog.ts",
  );
  const entry = BUILTIN_TOOL_CATALOG.find((candidate) => candidate.toolName === "ReadConversation");

  assert.deepEqual(entry, {
    id: "read_conversation",
    toolName: "ReadConversation",
    icon: "messageSquare",
    categoryId: "intelligence",
    isReadOnly: true,
    runtimeScopes: ["chat"],
    conditional: true,
  });
});

function historyWindow(overrides = {}) {
  return {
    conversation: { id: "old-1", title: "Earlier work" },
    meta: {},
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-0",
        startMessageIndex: 10,
        summary: { content: "Earlier summary" },
        messages: [
          { role: "user", content: [{ type: "text", text: "Original question" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Previous answer" },
              { type: "toolCall", id: "tool-1", name: "Bash", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "Bash",
            isError: false,
            content: [{ type: "text", text: "private tool output" }],
          },
        ],
      },
    ],
    returnedMessageCount: 3,
    oldestOffset: 10,
    hasMoreBefore: true,
    revision: "revision-7",
    updatedAt: 1,
    ...overrides,
  };
}

test("ReadConversation only accepts conversations selected in the current turn", async () => {
  const { createConversationTools } = loadConversationTools();
  let reads = 0;
  const bundle = createConversationTools({
    references: [{ id: "old-1", title: "Earlier work" }],
    currentConversationId: "current",
    loadWindow: async () => {
      reads += 1;
      return historyWindow();
    },
  });

  const rejected = await bundle.executeToolCall(toolCall("old-2"));
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /not selected through the current message/);
  assert.equal(reads, 0);
  assert.equal(bundle.metadataByName.get("ReadConversation").isReadOnly, true);
});

test("ReadConversation returns structured turns, tool status, and no tool output", async () => {
  const { createConversationTools } = loadConversationTools();
  const calls = [];
  const bundle = createConversationTools({
    references: [{ id: "old-1", title: "Earlier work" }],
    currentConversationId: "current",
    loadWindow: async (params) => {
      calls.push(params);
      return historyWindow();
    },
  });

  const result = await bundle.executeToolCall(toolCall("old-1", { max_turns: 1 }));
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [
    {
      id: "old-1",
      maxMessages: 1,
      beforeOffset: undefined,
      expectedRevision: undefined,
      includeActiveSegment: false,
    },
  ]);
  assert.equal(payload.snapshot_kind, "persisted_history");
  assert.equal(payload.returned_turns, 1);
  assert.equal(payload.turns[0].user.text, "Original question");
  assert.equal(payload.turns[0].assistant[0].text, "Previous answer");
  assert.deepEqual(payload.turns[0].tools, [{ name: "Bash", status: "completed" }]);
  assert.equal(payload.filtered_tool_result_count, 1);
  assert.doesNotMatch(result.content[0].text, /private tool output/);
  assert.match(payload.next_cursor, /^v1\./);
});

test("ReadConversation cursor binds pagination to the original revision", async () => {
  const { createConversationTools, decodeConversationCursor } = loadConversationTools();
  const calls = [];
  const bundle = createConversationTools({
    references: [{ id: "old-1", title: "Earlier work" }],
    currentConversationId: "current",
    loadWindow: async (params) => {
      calls.push(params);
      return historyWindow();
    },
  });

  const first = await bundle.executeToolCall(toolCall("old-1", { max_turns: 1 }));
  const cursor = JSON.parse(first.content[0].text).next_cursor;
  assert.deepEqual(decodeConversationCursor(cursor, "old-1"), {
    conversationId: "old-1",
    revision: "revision-7",
    beforeOffset: 10,
  });

  await bundle.executeToolCall(toolCall("old-1", { max_turns: 1, cursor }));
  assert.deepEqual(calls[1], {
    id: "old-1",
    maxMessages: 1,
    beforeOffset: 10,
    expectedRevision: "revision-7",
    includeActiveSegment: false,
  });

  const wrongConversation = await bundle.executeToolCall(
    toolCall("old-1", {
      cursor: cursor.replace("v1.", "v2."),
    }),
  );
  assert.equal(wrongConversation.isError, true);
  assert.match(wrongConversation.content[0].text, /cursor is invalid/);
});

test("ReadConversation keeps paging raw history until it finds semantic turns", async () => {
  const { createConversationTools } = loadConversationTools();
  const calls = [];
  const bundle = createConversationTools({
    references: [{ id: "old-1", title: "Earlier work" }],
    currentConversationId: "current",
    loadWindow: async (params) => {
      calls.push(params);
      if (calls.length === 1) {
        return historyWindow({
          segments: [
            {
              segmentIndex: 1,
              segmentId: "summary-only",
              summary: { content: "A compacted tail" },
              messages: [],
            },
          ],
          returnedMessageCount: 0,
          oldestOffset: 20,
        });
      }
      return historyWindow({ oldestOffset: 10, hasMoreBefore: false });
    },
  });

  const result = await bundle.executeToolCall(toolCall("old-1", { max_turns: 1 }));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(result.isError, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].beforeOffset, 20);
  assert.equal(calls[1].expectedRevision, "revision-7");
  assert.equal(payload.returned_turns, 1);
  assert.deepEqual(
    payload.summaries.map((summary) => summary.text),
    ["Earlier summary", "A compacted tail"],
  );
});

test("ReadConversation reports revision changes instead of mixing windows", async () => {
  const { createConversationTools, encodeConversationCursor } = loadConversationTools();
  const bundle = createConversationTools({
    references: [{ id: "old-1", title: "Earlier work" }],
    currentConversationId: "current",
    loadWindow: async () => {
      throw new Error("历史版本已变化");
    },
  });
  const cursor = encodeConversationCursor({
    conversationId: "old-1",
    revision: "revision-7",
    beforeOffset: 10,
  });

  const result = await bundle.executeToolCall(toolCall("old-1", { cursor }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Restart from the newest window/);
});

test("ReadConversation enforces current-conversation and three-reference limits", async () => {
  const { createConversationTools } = loadConversationTools();
  const bundle = createConversationTools({
    references: [
      { id: "current", title: "Current" },
      { id: "old-1", title: "One" },
      { id: "old-2", title: "Two" },
      { id: "old-3", title: "Three" },
      { id: "old-4", title: "Four" },
    ],
    currentConversationId: "current",
    loadWindow: async () => historyWindow({ hasMoreBefore: false }),
  });

  assert.equal((await bundle.executeToolCall(toolCall("current"))).isError, true);
  assert.equal((await bundle.executeToolCall(toolCall("old-3"))).isError, false);
  assert.equal((await bundle.executeToolCall(toolCall("old-4"))).isError, true);
});

test("ReadConversation marks text and whole-result truncation honestly", async () => {
  const { createConversationTools } = loadConversationTools();
  const huge = "x".repeat(40_000);
  const bundle = createConversationTools({
    references: [{ id: "old-1", title: "Earlier work" }],
    currentConversationId: "current",
    loadWindow: async () =>
      historyWindow({
        hasMoreBefore: false,
        segments: [
          {
            segmentIndex: 0,
            segmentId: "large",
            messages: [
              { role: "user", content: [{ type: "text", text: huge }] },
              { role: "assistant", content: [{ type: "text", text: huge }] },
            ],
          },
        ],
      }),
  });

  const result = await bundle.executeToolCall(toolCall("old-1", { max_turns: 1 }));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.result_truncated, true);
  assert.equal(payload.turns[0].user.original_chars, 40_000);
  assert.equal(payload.turns[0].user.truncated, true);
  assert.ok(result.content[0].text.length <= 30_000);
});
