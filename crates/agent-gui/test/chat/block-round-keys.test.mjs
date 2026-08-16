import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const uiMessages = loader.loadModule("src/lib/chat/messages/uiMessages.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const bubbleUtils = loader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);

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

// ---------------------------------------------------------------------------
// Block ids: stable at creation, never shifted by later inserts

test("appendTextDeltaToRound extends the trailing block without changing its id", () => {
  let round = { blocks: [] };
  round = uiMessages.appendTextDeltaToRound(round, "Hello ");
  round = uiMessages.appendTextDeltaToRound(round, "world");
  assert.equal(round.blocks.length, 1);
  assert.equal(round.blocks[0].id, "text-1");
  assert.equal(round.blocks[0].text, "Hello world");
});

test("interleaved thinking/text/tool blocks get per-kind ordinal ids", () => {
  let round = { blocks: [] };
  round = uiMessages.appendThinkingDeltaToRound(round, "pondering");
  round = uiMessages.appendTextDeltaToRound(round, "part one");
  round = uiMessages.upsertToolCallToRound(round, {
    type: "toolCall",
    id: "call-1",
    name: "Read",
    arguments: {},
  });
  round = uiMessages.appendTextDeltaToRound(round, "part two");
  const ids = round.blocks.map((block) => (block.kind === "tool" ? "tool" : block.id));
  assert.deepEqual(ids, ["thinking-1", "text-1", "tool", "text-2"]);
});

test("block ids assign deterministically across replays of the same sequence", () => {
  const build = () => {
    let round = { blocks: [] };
    round = uiMessages.appendThinkingDeltaToRound(round, "t");
    round = uiMessages.appendTextDeltaToRound(round, "a");
    round = uiMessages.upsertToolCallToRound(round, {
      type: "toolCall",
      id: "call-1",
      name: "Bash",
      arguments: {},
    });
    round = uiMessages.appendTextDeltaToRound(round, "b");
    return round.blocks.map((block) => (block.kind === "tool" ? block.item.toolCall.id : block.id));
  };
  assert.deepEqual(build(), build());
});

// ---------------------------------------------------------------------------
// groupRoundBlocks keys derive from block ids, not array positions

test("groupRoundBlocks keys survive a block being inserted before them", () => {
  const before = [
    { kind: "thinking", id: "thinking-1", text: "think" },
    { kind: "text", id: "text-1", text: "answer" },
  ];
  const after = [
    { kind: "thinking", id: "thinking-1", text: "think" },
    {
      kind: "tool",
      item: { toolCall: { type: "toolCall", id: "call-1", name: "Read", arguments: {} } },
    },
    { kind: "text", id: "text-1", text: "answer" },
  ];
  const keysBefore = bubbleUtils.groupRoundBlocks(before).map((block) => block.key);
  const keysAfter = bubbleUtils.groupRoundBlocks(after).map((block) => block.key);
  // The text block's key must not change when a tool block lands before it —
  // an index-derived key would flip and remount the rendered markdown.
  assert.equal(keysBefore.at(-1), "text-1");
  assert.equal(keysAfter.at(-1), "text-1");
  assert.equal(keysBefore[0], "thinking-1");
  assert.equal(keysAfter[0], "thinking-1");
});

test("ordinary tool activity keeps one group identity as later tools append", () => {
  const tool = (id) => ({
    kind: "tool",
    item: { toolCall: { type: "toolCall", id, name: "Bash", arguments: {} } },
  });
  const first = bubbleUtils.groupRoundBlocks([tool("call-1")]);
  const appended = bubbleUtils.groupRoundBlocks([tool("call-1"), tool("call-2")]);

  assert.equal(first.length, 1);
  assert.equal(appended.length, 1);
  assert.equal(first[0].kind, "toolGroup");
  assert.equal(appended[0].kind, "toolGroup");
  assert.equal(appended[0].key, first[0].key);
  assert.deepEqual(
    appended[0].items.map((item) => item.toolCall.id),
    ["call-1", "call-2"],
  );
});

test("shell session controls remain visible across rounds without mutating transcript", () => {
  const result = (toolCallId, status, cursor, text) => ({
    role: "toolResult",
    toolCallId,
    toolName: toolCallId === "bash-1" ? "Bash" : "ProcessWait",
    content: [{ type: "text", text }],
    details: {
      status,
      session_id: "bash-session-1",
      cursor,
      output: text ? [{ stream: "stdout", text }] : [],
      output_truncated: false,
      has_more: false,
      exit_code: status === "completed" ? 0 : null,
      duration_ms: cursor * 10,
      shell: "bash",
    },
    isError: false,
    timestamp: cursor,
  });
  const rounds = [
    {
      round: 1,
      blocks: [
        {
          kind: "tool",
          item: {
            toolCall: {
              type: "toolCall",
              id: "bash-1",
              name: "Bash",
              arguments: { command: "pnpm build" },
            },
            toolResult: result("bash-1", "running", 6, "start\n"),
          },
        },
      ],
    },
    {
      round: 2,
      blocks: [
        {
          kind: "tool",
          item: {
            toolCall: {
              type: "toolCall",
              id: "wait-1",
              name: "ProcessWait",
              arguments: { session_id: "bash-session-1", cursor: 6 },
            },
            toolResult: result("wait-1", "running", 12, "middle\n"),
          },
        },
      ],
    },
    {
      round: 3,
      blocks: [
        {
          kind: "tool",
          item: {
            toolCall: {
              type: "toolCall",
              id: "wait-2",
              name: "ProcessWait",
              arguments: { session_id: "bash-session-1", cursor: 12 },
            },
            toolResult: result("wait-2", "completed", 17, "done\n"),
          },
        },
      ],
    },
  ];

  assert.equal(rounds[1].blocks.length, 1, "source transcript remains unchanged");
  const grouped = rounds.map((round) => bubbleUtils.groupRoundBlocks(round.blocks));
  assert.equal(grouped[0][0].kind, "toolGroup");
  assert.deepEqual(grouped[0][0].items.map((item) => item.toolCall.name), ["Bash"]);
  assert.equal(grouped[1][0].kind, "tool");
  assert.equal(grouped[1][0].item.toolCall.name, "ProcessWait");
  assert.equal(grouped[1][0].item.toolResult.details.status, "running");
  assert.equal(grouped[2][0].kind, "tool");
  assert.equal(grouped[2][0].item.toolCall.name, "ProcessWait");
  assert.equal(grouped[2][0].item.toolResult.details.status, "completed");
});

test("shell session controls preserve each response output without display aggregation", () => {
  const largeOutput = "x".repeat(40 * 1024);
  const makeResult = (toolCallId, status, output) => ({
    role: "toolResult",
    toolCallId,
    toolName: toolCallId === "bash-large" ? "Bash" : "ProcessWait",
    content: [{ type: "text", text: output }],
    details: {
      status,
      session_id: "bash-session-large",
      cursor: output.length,
      output: [{ stream: "stdout", text: output }],
      output_truncated: false,
      has_more: false,
      exit_code: status === "completed" ? 0 : null,
      duration_ms: status === "completed" ? 20_000 : 10_000,
      shell: "bash",
    },
    isError: false,
  });
  const rounds = [
    {
      round: 1,
      blocks: [
        {
          kind: "tool",
          item: {
            toolCall: {
              type: "toolCall",
              id: "bash-large",
              name: "Bash",
              arguments: { command: "cargo test" },
            },
            toolResult: makeResult("bash-large", "running", largeOutput),
          },
        },
      ],
    },
    {
      round: 2,
      blocks: [
        {
          kind: "tool",
          item: {
            toolCall: {
              type: "toolCall",
              id: "wait-large",
              name: "ProcessWait",
              arguments: { session_id: "bash-session-large", cursor: largeOutput.length },
            },
            toolResult: makeResult("wait-large", "completed", largeOutput),
          },
        },
      ],
    },
  ];

  const grouped = rounds.map((round) => bubbleUtils.groupRoundBlocks(round.blocks));
  assert.equal(grouped[0][0].kind, "toolGroup");
  assert.equal(grouped[1][0].kind, "tool");
  assert.equal(grouped[0][0].items[0].toolResult.content[0].text.length, largeOutput.length);
  assert.equal(grouped[1][0].item.toolResult.content[0].text.length, largeOutput.length);
  assert.equal("display_truncated" in grouped[1][0].item.toolResult.details, false);
});

test("shell session controls keep failed waits visible", () => {
  const rounds = [
    {
      round: 1,
      blocks: [
        {
          kind: "tool",
          item: {
            toolCall: {
              type: "toolCall",
              id: "bash-running",
              name: "Bash",
              arguments: { command: "pnpm build" },
            },
            toolResult: {
              role: "toolResult",
              toolCallId: "bash-running",
              toolName: "Bash",
              content: [{ type: "text", text: "building\n" }],
              details: {
                status: "running",
                session_id: "bash-session-error",
                cursor: 9,
                output: [{ stream: "stdout", text: "building\n" }],
                output_truncated: false,
                has_more: false,
                exit_code: null,
                duration_ms: 10_000,
                shell: "bash",
              },
              isError: false,
            },
          },
        },
      ],
    },
    {
      round: 2,
      blocks: [
        {
          kind: "tool",
          item: {
            toolCall: {
              type: "toolCall",
              id: "wait-failed",
              name: "ProcessWait",
              arguments: { session_id: "bash-session-error", cursor: 9 },
            },
            toolResult: {
              role: "toolResult",
              toolCallId: "wait-failed",
              toolName: "ProcessWait",
              content: [{ type: "text", text: "shell session not found" }],
              details: {},
              isError: true,
            },
          },
        },
      ],
    },
  ];

  const grouped = rounds.map((round) => bubbleUtils.groupRoundBlocks(round.blocks));
  assert.equal(grouped[0][0].kind, "toolGroup");
  assert.equal(grouped[0][0].items[0].toolResult.details.status, "running");
  assert.equal(grouped[1][0].kind, "tool");
  assert.equal(grouped[1][0].item.toolCall.id, "wait-failed");
  assert.equal(grouped[1][0].item.toolResult.isError, true);
});

test("special tool result updates preserve their direct activity identity", () => {
  for (const name of [
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "AskUserQuestion",
    "Image",
    "Agent",
    "ProcessWait",
    "ProcessStop",
  ]) {
    const pendingItem = {
      toolCall: { type: "toolCall", id: `call-${name}`, name, arguments: {} },
    };
    const settledItem = {
      ...pendingItem,
      toolResult: {
        role: "toolResult",
        toolCallId: `call-${name}`,
        content: [],
        isError: name === "Image",
      },
    };
    const pending = bubbleUtils.groupRoundBlocks([{ kind: "tool", item: pendingItem }]);
    const settled = bubbleUtils.groupRoundBlocks([{ kind: "tool", item: settledItem }]);

    assert.equal(pending.length, 1, name);
    assert.equal(settled.length, 1, name);
    assert.equal(pending[0].kind, "tool", name);
    assert.equal(settled[0].kind, "tool", name);
    assert.equal(settled[0].key, pending[0].key, name);
  }
});

test("hosted search activity keeps one group identity as later searches append", () => {
  const first = bubbleUtils.groupRoundBlocks([
    { kind: "hostedSearch", item: { id: "search-1" } },
  ]);
  const appended = bubbleUtils.groupRoundBlocks([
    { kind: "hostedSearch", item: { id: "search-1" } },
    { kind: "hostedSearch", item: { id: "search-2" } },
  ]);

  assert.equal(first[0].kind, "hostedSearchGroup");
  assert.equal(appended[0].kind, "hostedSearchGroup");
  assert.equal(appended[0].key, first[0].key);
});

// ---------------------------------------------------------------------------
// Round keys: history rounds are r<n>; rebuilds are deterministic

test("buildUiMessages stamps r<n> round keys and deterministic block ids", () => {
  const messages = [
    user("question", 1),
    assistant("first round", 2, { stopReason: "toolUse" }),
    assistant("second round", 3),
  ];
  const first = uiMessages.buildUiMessages(messages);
  const second = uiMessages.buildUiMessages(messages);
  const reply = first.find((message) => message.role === "assistant");
  assert.deepEqual(
    reply.rounds.map((round) => round.key),
    ["r1", "r2"],
  );
  assert.deepEqual(first, second, "rebuilding the same messages yields identical keys/ids");
});

test("merging render-only rounds shifts r<n> keys in lockstep with round numbers", () => {
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "base",
    tools: [],
    messages: [user("question", 1), assistant("first reply", 2)],
  });
  const lastBefore = state.transcript.items.at(-1);
  assert.equal(lastBefore.kind, "assistant");
  assert.deepEqual(
    lastBefore.rounds.map((round) => round.key),
    ["r1"],
  );

  const merged = conversationState.appendRenderOnlyMessagesToConversation(state, [
    assistant("appended reply", 3),
  ]);
  const lastAfter = merged.transcript.items.at(-1);
  assert.deepEqual(
    lastAfter.rounds.map((round) => round.round),
    [1, 2],
  );
  assert.deepEqual(
    lastAfter.rounds.map((round) => round.key),
    ["r1", "r2"],
    "shifted rounds re-stamp their ordinal keys so merged keys stay collision-free",
  );
});
