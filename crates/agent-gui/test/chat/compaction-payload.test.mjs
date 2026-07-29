import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const payloadModule = loader.loadModule("src/lib/chat/compaction/payload.ts");

const {
  buildCompactionPayload,
  serializeMessageForCompaction,
  shrinkCompactionPayload,
  fitCompactionPayloadToBudget,
  estimateCompactionPayloadTokens,
  trimText,
} = payloadModule;

function user(content, timestamp = 1) {
  return { role: "user", content, timestamp };
}

function assistant(text, timestamp = 2, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
    ...extra,
  };
}

function toolResult(text, timestamp = 3) {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function buildState(messages, summary) {
  const segment = {
    segmentIndex: 0,
    segmentId: "seg-0",
    summary,
    messages,
    messageCount: messages.length,
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    meta: {
      schemaVersion: 3,
      systemPrompt: "base prompt",
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: messages.length,
    },
    segments: [segment],
    transcript: {
      items: [],
      segmentWindows: [],
      oldestMessageOffset: 0,
      hasMoreBefore: false,
      revision: null,
    },
    activeSegmentIndex: 0,
  };
}

function summaryMessage(content) {
  return {
    role: "summary",
    id: "summary-1",
    timestamp: 1,
    content,
    summaryMeta: {
      format: "plain-text-v1",
      strategy: "cumulative-checkpoint",
      coversThroughMessageId: "m-1",
      coveredMessageCount: 4,
      generatedBy: { providerId: "anthropic", model: "claude" },
    },
  };
}

test("trimText keeps head and tail around a truncation marker", () => {
  const text = `${"a".repeat(500)}${"z".repeat(500)}`;
  const trimmed = trimText(text, 100);
  assert.ok(trimmed.includes("... [truncated] ..."));
  assert.ok(trimmed.startsWith("a"));
  assert.ok(trimmed.endsWith("z"));
  assert.equal(trimText("short", 100), "short");
});

test("serializeMessageForCompaction captures each role's essentials", () => {
  const assistantWithTool = assistant("analysis", 2, {
    content: [
      { type: "text", text: "analysis" },
      { type: "toolCall", id: "t1", name: "Bash", arguments: { command: "cargo build" } },
    ],
    stopReason: "toolUse",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4321, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const serializedAssistant = serializeMessageForCompaction(assistantWithTool, 0);
  assert.equal(serializedAssistant.role, "assistant");
  assert.equal(serializedAssistant.text, "analysis");
  assert.equal(serializedAssistant.usageTotalTokens, 4321);
  assert.equal(serializedAssistant.toolCalls.length, 1);
  assert.match(serializedAssistant.toolCalls[0], /^Bash [\s\S]*cargo build/);

  const bigToolResult = serializeMessageForCompaction(toolResult("x".repeat(40_000)), 1);
  assert.equal(bigToolResult.role, "toolResult");
  assert.equal(bigToolResult.toolName, "Read");
  assert.ok(bigToolResult.content.includes("... [truncated] ..."));
  assert.ok(bigToolResult.content.length < 40_000);

  const serializedUser = serializeMessageForCompaction(user("question"), 2);
  assert.deepEqual(serializedUser, {
    index: 2,
    role: "user",
    timestamp: 1,
    content: "question",
  });
});

test("buildCompactionPayload carries the previous summary and the pending user text", () => {
  const state = buildState([user("q1"), assistant("a1")], summaryMessage("earlier summary"));
  const payload = buildCompactionPayload({
    state,
    incomingUserText: "next question",
    intent: "optimization",
    contextTokens: 190_000,
    threshold: 152_000,
  });

  assert.equal(payload.compaction_reason.trigger, "pre-send-optimization-threshold");
  assert.equal(payload.compaction_reason.context_tokens, 190_000);
  assert.equal(payload.system_prompt, "base prompt");
  assert.equal(payload.previous_summary.content, "earlier summary");
  assert.equal(payload.active_segment_messages.length, 2);
  assert.equal(payload.next_user_message, "next question");

  const protectionPayload = buildCompactionPayload({
    state,
    intent: "protection",
    contextTokens: 1,
    threshold: 1,
  });
  assert.equal(protectionPayload.compaction_reason.trigger, "mid-turn-protection-threshold");
  assert.equal(protectionPayload.next_user_message, undefined);
});

test("buildCompactionPayload removes synthetic subagent card calls and paired results", () => {
  const parentId = "fc_parent";
  const cardId = `${parentId}:agent:1`;
  const state = buildState([
    {
      ...assistant("Delegating work."),
      content: [
        { type: "text", text: "Delegating work." },
        { type: "toolCall", id: parentId, name: "Agent", arguments: { agents: [] } },
        {
          type: "toolCall",
          id: cardId,
          name: "Agent",
          arguments: {
            subagent_card: true,
            parent_tool_call_id: parentId,
            id: "reviewer",
          },
        },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: cardId,
      toolName: "Agent",
      content: [{ type: "text", text: "synthetic card result" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: parentId,
      toolName: "Agent",
      content: [{ type: "text", text: "real parent result" }],
      details: { kind: "subagent_batch" },
      isError: false,
      timestamp: 4,
    },
  ]);

  const payload = buildCompactionPayload({
    state,
    intent: "protection",
    contextTokens: 1,
    threshold: 1,
  });

  assert.deepEqual(
    payload.active_segment_messages.map((message) => message.role),
    ["assistant", "toolResult"],
  );
  assert.equal(payload.active_segment_messages[1].toolCallId, parentId);
  assert.match(payload.active_segment_messages[0].toolCalls[0], /^Agent /);
  assert.equal(JSON.stringify(payload).includes(cardId), false);
  assert.equal(JSON.stringify(payload).includes("synthetic card result"), false);
});

test("shrink keeps head+tail and records the omitted count; summary-backed payloads drop the head", () => {
  const messages = Array.from({ length: 20 }, (_, i) =>
    serializeMessageForCompaction(user(`msg-${i}`, i), i),
  );
  const base = {
    compaction_reason: { trigger: "t", context_tokens: 1, threshold: 1 },
    system_prompt: "p",
    previous_summary: null,
    active_segment_messages: messages,
  };

  const shrunk = shrinkCompactionPayload(base);
  assert.equal(shrunk.active_segment_messages.length, 12);
  assert.equal(shrunk.compaction_reason.omitted_message_count, 8);
  assert.equal(shrunk.compaction_reason.reduced_input, true);
  assert.equal(shrunk.active_segment_messages[0].content, "msg-0");
  assert.equal(shrunk.active_segment_messages.at(-1).content, "msg-19");

  const withSummary = shrinkCompactionPayload({
    ...base,
    previous_summary: { id: "s", content: "sum", summaryMeta: {} },
  });
  assert.equal(withSummary.active_segment_messages.length, 10);
  assert.equal(withSummary.active_segment_messages[0].content, "msg-10");

  assert.equal(
    shrinkCompactionPayload({ ...base, active_segment_messages: messages.slice(0, 6) }),
    null,
  );
});

test("fitCompactionPayloadToBudget converges under the model budget", () => {
  const messages = Array.from({ length: 40 }, (_, i) =>
    serializeMessageForCompaction(toolResult("y".repeat(6000), i), i),
  );
  const payload = {
    compaction_reason: { trigger: "t", context_tokens: 1, threshold: 1 },
    system_prompt: "p".repeat(30_000),
    previous_summary: { id: "s", content: "c".repeat(30_000), summaryMeta: {} },
    active_segment_messages: messages,
    next_user_message: "n".repeat(10_000),
  };

  // contextWindow 10k / maxOutput 2k → budget = floor((10000-1000-1500)*0.9) = 6750
  const fitted = fitCompactionPayloadToBudget({
    payload,
    modelConfig: { contextWindow: 10_000, maxOutputToken: 2_000 },
  });

  assert.equal(fitted.compaction_reason.reduced_input, true);
  assert.equal(fitted.compaction_reason.payload_budget_tokens, 6_750);
  assert.ok(estimateCompactionPayloadTokens(fitted) < estimateCompactionPayloadTokens(payload));
  assert.ok(fitted.active_segment_messages.length < messages.length);

  const tiny = {
    ...payload,
    system_prompt: "p",
    previous_summary: null,
    next_user_message: undefined,
    active_segment_messages: messages.slice(0, 1),
  };
  assert.equal(
    fitCompactionPayloadToBudget({ payload: tiny, modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 } }),
    tiny,
  );
});
