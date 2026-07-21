import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const engineModule = loader.loadModule("src/lib/chat/compaction/engine.ts");
const summarizerModule = loader.loadModule("src/lib/chat/compaction/summarizer.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");

const { runCompaction, createSyntheticContinueUserMessage } = engineModule;
const { summarizeConversation } = summarizerModule;

const VALID_SUMMARY_XML = `<summary>
<task>Refactor the compaction subsystem</task>
<state>Engine modules extracted, src/app.ts updated, validation ported ${"x".repeat(300)}</state>
<artifacts>
- [file] src/app.ts | modified | rewired entry point
</artifacts>
<next_steps>
1. wire the controller
</next_steps>
</summary>`;

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

function summaryResponse(text = VALID_SUMMARY_XML, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-real",
    stopReason: "stop",
    usage: usage(5000, 300),
    timestamp: 1234,
    responseId: "resp-1",
    ...extra,
  };
}

function user(content, timestamp = 1) {
  return { role: "user", content, timestamp };
}

function assistant(text, timestamp = 2) {
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

function buildState(extraMessages = []) {
  return conversationState.createConversationStateFromContext({
    systemPrompt: "base prompt",
    messages: [user("please edit src/app.ts"), assistant("edited src/app.ts"), ...extraMessages],
  });
}

function runParams(complete, overrides = {}) {
  return {
    state: buildState(),
    intent: "optimization",
    contextTokens: 190_000,
    threshold: 152_000,
    providerId: "anthropic",
    model: "claude-x",
    runtime: { baseUrl: "https://example", apiKey: "k" },
    complete,
    ...overrides,
  };
}

test("runCompaction produces a zero-usage checkpoint and appends a new segment", async () => {
  const calls = [];
  const outcome = await runCompaction(
    runParams(async (params) => {
      calls.push(params);
      return summaryResponse();
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cacheRetention, "none");
  assert.ok(calls[0].context.systemPrompt.includes("CONTEXT CHECKPOINT"));

  const checkpoint = outcome.checkpointMessage;
  assert.equal(checkpoint.api, "liveagent-compaction");
  assert.equal(checkpoint.model, "claude-x");
  assert.equal(checkpoint.promptVersion, "summary-v3");
  // usage 恒为零：summarizer 用量只进 compactionStats。
  assert.equal(checkpoint.usage.totalTokens, 0);
  assert.equal(checkpoint.usage.input, 0);
  assert.deepEqual(checkpoint.compactionStats, {
    conversationTokens: 190_000,
    summarizer: { inputTokens: 5000, outputTokens: 300 },
  });

  assert.equal(outcome.newSegmentIndex, 1);
  assert.equal(outcome.state.activeSegmentIndex, 1);
  assert.equal(outcome.state.segments.length, 2);
  // 旧消息保留展示，新 segment 从空开始、summary 挂载。
  assert.equal(outcome.state.segments[0].messages.length, 2);
  assert.equal(outcome.state.segments[1].messages.length, 0);

  const summary = outcome.state.segments[1].summary;
  assert.ok(summary.content.startsWith("## Task"));
  assert.equal(summary.summaryMeta.strategy, "cumulative-checkpoint");
  assert.equal(summary.summaryMeta.generatedBy.providerId, "anthropic");
  assert.equal(summary.summaryMeta.generatedBy.promptVersion, "summary-v3");
  assert.equal(summary.summaryMeta.stats.estimatedInputTokens, 190_000);
  assert.deepEqual(summary.summaryMeta.stats.summarizer, { inputTokens: 5000, outputTokens: 300 });
});

test("invalid first output triggers exactly one self-repair round-trip", async () => {
  const calls = [];
  const outcome = await runCompaction(
    runParams(async (params) => {
      calls.push(params);
      if (calls.length === 1) {
        return summaryResponse("sure! here is a chatty non-xml answer");
      }
      return summaryResponse();
    }),
  );

  assert.equal(calls.length, 2);
  const repairMessages = calls[1].context.messages;
  assert.equal(repairMessages.length, 3);
  assert.equal(repairMessages[1].role, "assistant");
  assert.match(repairMessages[2].content, /previous compaction summary was invalid/);
  assert.match(repairMessages[2].content, /src\/app\.ts/);
  assert.equal(outcome.state.segments.length, 2);
});

test("verification repair identifies the exact recent technical references", async () => {
  const calls = [];
  const outcome = await runCompaction(
    runParams(async (params) => {
      calls.push(params);
      if (calls.length === 1) {
        return summaryResponse(VALID_SUMMARY_XML.replaceAll("src/app.ts", "src/other.ts"));
      }
      return summaryResponse();
    }),
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1].context.messages[2].content, /at least one.*recent technical references/);
  assert.match(calls[1].context.messages[2].content, /"src\/app\.ts"/);
  assert.equal(outcome.state.segments.length, 2);
});

test("an unrepairable summary rejects after the single repair attempt", async () => {
  let calls = 0;
  await assert.rejects(
    runCompaction(
      runParams(async () => {
        calls += 1;
        return summaryResponse("still not xml");
      }),
    ),
    /validation failed/,
  );
  assert.equal(calls, 2);
});

test("overflow errors shrink the payload once and retry", async () => {
  const extra = Array.from({ length: 12 }, (_, i) => user(`filler message ${i}`, 10 + i));
  const calls = [];
  await runCompaction(
    runParams(
      async (params) => {
        calls.push(JSON.parse(params.context.messages[0].content));
        if (calls.length === 1) {
          throw new Error("input is too large: maximum context length exceeded");
        }
        return summaryResponse();
      },
      { state: buildState(extra) },
    ),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].compaction_reason.omitted_message_count ?? 0, 0);
  assert.ok(calls[1].compaction_reason.omitted_message_count > 0);
  assert.ok(
    calls[1].active_segment_messages.length < calls[0].active_segment_messages.length,
  );
});

test("transient errors get one backoff retry; permanent errors do not", async () => {
  let transientCalls = 0;
  await summarizeConversation({
    providerId: "anthropic",
    model: "m",
    runtime: { baseUrl: "b", apiKey: "k" },
    payload: {
      compaction_reason: { trigger: "t", context_tokens: 1, threshold: 1 },
      system_prompt: "p",
      previous_summary: null,
      active_segment_messages: [
        { index: 0, role: "user", timestamp: null, content: "check src/app.ts" },
      ],
    },
    complete: async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw new Error("socket hang up (network)");
      return summaryResponse();
    },
  });
  assert.equal(transientCalls, 2);

  let permanentCalls = 0;
  await assert.rejects(
    runCompaction(
      runParams(async () => {
        permanentCalls += 1;
        throw new Error("invalid api key");
      }),
    ),
    /invalid api key/,
  );
  assert.equal(permanentCalls, 1);
});

test("an abort during the summarizer call rethrows without retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    runCompaction(
      runParams(
        async () => {
          calls += 1;
          controller.abort();
          throw new Error("request aborted mid-flight");
        },
        { signal: controller.signal },
      ),
    ),
    /aborted/,
  );
  assert.equal(calls, 1);
});

test("the synthetic continue message matches the conversation-state constant byte for byte", () => {
  const resume = createSyntheticContinueUserMessage(42);
  assert.equal(resume.content, conversationState.INTERNAL_RESUME_MESSAGE_TEXT);
  assert.equal(resume.timestamp, 42);
  assert.match(resume.id, /^user-/);
});
