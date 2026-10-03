import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const checkpoint = loader.loadModule("src/lib/chat/compaction/checkpoint.ts");
const { PROMPT_VERSION } = loader.loadModule("src/lib/chat/compaction/prompt.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");

const { buildCheckpointMessage, deterministicSummary, withContextTokensAfter } = checkpoint;

function usage(input, output) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function user(content, timestamp, extra = {}) {
  return { role: "user", content, timestamp, ...extra };
}

function assistant(text, timestamp) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-real",
    stopReason: "stop",
    usage: usage(10, 10),
    timestamp,
  };
}

function buildState() {
  return conversationState.createConversationStateFromContext({
    systemPrompt: "base prompt",
    messages: [user("please edit src/app.ts", 1, { id: "u-1" }), assistant("edited src/app.ts", 2)],
  });
}

function checkpointMessage(overrides = {}) {
  return buildCheckpointMessage({
    summaryText: "## Goal\nRefactor the compaction subsystem",
    providerId: "openrouter",
    model: "served-model",
    promptVersion: PROMPT_VERSION.transcript,
    timestamp: 1234,
    conversationTokens: 190_000,
    summarizerUsage: { inputTokens: 5_000, outputTokens: 300, cacheReadTokens: 4_000 },
    retainedUserMessages: [],
    ...overrides,
  });
}

test("v4 prompt versions name the stage that produced the summary", () => {
  assert.deepEqual(PROMPT_VERSION, {
    fork: "summary-v4",
    transcript: "summary-v4-transcript",
    deterministic: "summary-v4-deterministic",
  });
});

test("the checkpoint marker keeps zero usage and carries the summarizer usage in compactionStats", () => {
  const message = checkpointMessage();

  assert.equal(message.api, "liveagent-compaction");
  assert.equal(message.provider, "openrouter");
  assert.equal(message.model, "served-model");
  assert.equal(message.promptVersion, "summary-v4-transcript");
  assert.equal(message.stopReason, "stop");
  assert.match(message.responseId, /^liveagent-compaction-1234-/);
  // usage 恒为零：摘要请求的用量只进 compactionStats，绝不冒充会话上下文规模。
  assert.equal(message.usage.totalTokens, 0);
  assert.equal(message.usage.input, 0);
  assert.deepEqual(message.compactionStats, {
    conversationTokens: 190_000,
    summarizer: { inputTokens: 5_000, outputTokens: 300, cacheReadTokens: 4_000 },
  });
  assert.equal("retainedUserMessages" in message, false);
  assert.ok(conversationState.isCompactionAssistantMessage(message));
});

test("applying a checkpoint opens an empty new segment and records the serving target", () => {
  const retained = [{ id: "u-1", timestamp: 1, text: "please edit src/app.ts" }];
  const state = conversationState.applyCompactionCheckpoint(
    buildState(),
    checkpointMessage({ retainedUserMessages: retained }),
  );

  assert.equal(state.activeSegmentIndex, 1);
  assert.equal(state.segments.length, 2);
  // 旧消息保留展示，新 segment 从空开始、summary 挂载。
  assert.equal(state.segments[0].messages.length, 2);
  assert.equal(state.segments[1].messages.length, 0);

  const summary = state.segments[1].summary;
  assert.equal(summary.content, "## Goal\nRefactor the compaction subsystem");
  assert.deepEqual(summary.retainedUserMessages, retained);
  assert.equal(summary.summaryMeta.format, "plain-text-v1");
  assert.equal(summary.summaryMeta.strategy, "cumulative-checkpoint");
  assert.deepEqual(summary.summaryMeta.generatedBy, {
    providerId: "openrouter",
    model: "served-model",
    promptVersion: "summary-v4-transcript",
  });
  assert.equal(summary.summaryMeta.stats.estimatedInputTokens, 190_000);
  assert.deepEqual(summary.summaryMeta.stats.summarizer, {
    inputTokens: 5_000,
    outputTokens: 300,
    cacheReadTokens: 4_000,
  });

  const anchored = withContextTokensAfter(state, 12_345);
  assert.equal(anchored.segments[1].summary.summaryMeta.stats.contextTokensAfter, 12_345);
  assert.equal(anchored.segments[0], state.segments[0]);
  assert.equal(withContextTokensAfter(buildState(), 1).segments[0].summary, undefined);
});

test("the deterministic summary inherits the previous summary and appends clipped activity", () => {
  const text = deterministicSummary({
    previousSummary: "  ## Goal\nShip it  ",
    messages: [
      user("run the tests", 1),
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "Bash",
        content: [{ type: "text", text: "x".repeat(2_000) }],
        isError: false,
        timestamp: 2,
      },
    ],
    reason: "fork stall: stream stalled",
  });

  assert.ok(text.startsWith("## Goal\nShip it\n\n## Unsummarized activity"));
  assert.match(text, /\(Automatic summary unavailable: fork stall: stream stalled; re-read files/);
  assert.match(text, /\[User\]\nrun the tests/);
  assert.ok(text.length < 1_000, "tool results are clipped to 300 characters");
});

test("the legacy resume constant is untouched and still dropped at message 0 of a checkpoint segment", () => {
  assert.equal(
    conversationState.INTERNAL_RESUME_MESSAGE_TEXT,
    "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
  );
  const compacted = conversationState.applyCompactionCheckpoint(buildState(), checkpointMessage());
  const legacy = conversationState.appendMessagesToConversation(compacted, [
    user(conversationState.INTERNAL_RESUME_MESSAGE_TEXT, 3, { id: "user-legacy" }),
    assistant("continuing", 4),
  ]);
  assert.deepEqual(
    legacy.segments[1].messages.map((message) => message.role),
    ["assistant"],
  );
});
