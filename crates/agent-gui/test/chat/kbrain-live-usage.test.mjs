import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { kbrainUsage, hasKBrainUsage } = loader.loadModule("src/lib/kbrain/usage.ts");
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const { deriveContextUsageTokens, estimateTextTokenUnits } = loader.loadModule(
  "@liveagent/ui/lib/chat/contextUsage.ts",
);
const runTurnSource = readFileSync(
  new URL("../../src/pages/chat/turns/runKBrainConversationTurn.ts", import.meta.url),
  "utf8",
);

const report = (input, output, cached = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cached_tokens: cached,
  cache_write_tokens: cacheWrite,
});

test("K-brain usage keeps cache reads out of input so they are not counted twice", () => {
  const usage = kbrainUsage(report(12_000, 300, 9_000, 1_000));
  assert.equal(usage.input, 2_000);
  assert.equal(usage.cacheRead, 9_000);
  assert.equal(usage.cacheWrite, 1_000);
  assert.equal(usage.output, 300);
  assert.equal(usage.totalTokens, 12_300);
  assert.equal(usage.input + usage.cacheRead + usage.cacheWrite + usage.output, usage.totalTokens);
  assert.equal(kbrainUsage(undefined).totalTokens, 0);
  assert.equal(kbrainUsage(report(-5, Number.NaN)).totalTokens, 0);
  assert.equal(hasKBrainUsage(report(0, 0)), false);
  assert.equal(hasKBrainUsage({ cached_tokens: 1 }), true);
  assert.equal(hasKBrainUsage(null), false);
});

function sseFixture(connections) {
  let index = 0;
  const event = (seq, type, payload) =>
    `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", seq, type, payload })}\n\n`;
  const afterSeqs = [];
  const fetch = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/v1/sessions") return Response.json({ id: "s" });
    if (path.endsWith("/runs"))
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 });
    if (path.endsWith("/events")) {
      afterSeqs.push(parsed.searchParams.get("after_seq"));
      const batch = connections[Math.min(index, connections.length - 1)];
      index += 1;
      return new Response(batch.map(([seq, type, payload]) => event(seq, type, payload)).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  return { fetch, afterSeqs };
}

function turnParams(fetch, onUsage, conversationId) {
  return {
    baseUrl: "http://fixture.test",
    fetch,
    model: { provider: "fixture", model: "test" },
    sessionId: "frontend",
    conversationId,
    cwd: "/tmp",
    context: { messages: [] },
    prompt: "hello",
    signal: new AbortController().signal,
    onUsage,
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall() {},
    onToolResult() {},
  };
}

test("usage.updated reaches the live round during a run and survives a reconnect replay", async () => {
  const usages = [];
  const { fetch, afterSeqs } = sseFixture([
    // First stream: one model call, its usage report, then the connection drops.
    [
      [2, "assistant.text.delta", { text: "step one" }],
      [3, "usage.updated", report(10_000, 200, 8_000)],
    ],
    // Reconnect resumes after seq 3 and replays the rest of the run's reports.
    [
      [4, "usage.updated", report(0, 0)],
      [5, "usage.updated", report(14_000, 400, 10_000)],
      [6, "assistant.message.created", { role: "assistant", content: [{ type: "text", text: "done" }] }],
      [7, "run.completed", {}],
    ],
  ]);
  await runKBrainTurn(turnParams(fetch, (usage) => usages.push(usage), "live-usage"));
  assert.deepEqual(afterSeqs.slice(0, 2), ["1", "3"]);
  // Empty reports are skipped; every real report arrives once, in order.
  assert.deepEqual(
    usages.map((usage) => [usage.input, usage.cacheRead, usage.output, usage.totalTokens]),
    [
      [2_000, 8_000, 200, 10_200],
      [4_000, 10_000, 400, 14_400],
    ],
  );
});

test("a run without a final usage keeps the last live report on the round", () => {
  assert.match(runTurnSource, /const lastReport = readLiveUsage\(\);/);
  assert.match(
    runTurnSource,
    /projected\.usage\.totalTokens > 0 \|\| !lastReport \? projected\.usage : lastReport/,
  );
  assert.match(runTurnSource, /usageBlockCount: target\.blocks\.length/);
  assert.match(runTurnSource, /usageLive: true/);
});

test("the ring anchors on a mid-run report and adds only what came after it", () => {
  const toolResult = "r".repeat(4_000);
  const later = "t".repeat(400);
  const round = {
    meta: {
      usage: { input: 2_000, cacheRead: 8_000, output: 200 },
      usageBlockCount: 1,
    },
    blocks: [
      { kind: "text", text: "x".repeat(40_000) },
      {
        kind: "tool",
        item: {
          toolCall: { name: "Read", arguments: { path: "a.ts" } },
          toolResult: { content: [{ type: "text", text: toolResult }] },
        },
      },
      { kind: "text", text: later },
    ],
  };
  const value = deriveContextUsageTokens([{ kind: "user" }, { kind: "assistant", rounds: [round] }]);
  const toolTokens = Math.ceil(estimateTextTokenUnits(toolResult)) + 8;
  const laterTokens = Math.ceil(estimateTextTokenUnits(later)) + 8;
  // 10,200 reported, plus the tool result and the next call's text; the covered
  // 40,000-character block is not estimated again.
  assert.equal(value, 10_200 + toolTokens + laterTokens);

  // Without the marker the same round counts its tool result only (legacy settled rounds).
  const { usageBlockCount: _ignored, ...settledMeta } = round.meta;
  const settled = deriveContextUsageTokens([
    { kind: "assistant", rounds: [{ ...round, meta: { ...settledMeta, stopReason: "stop" } }] },
  ]);
  assert.equal(settled, 10_200 + toolTokens);
});

test("each new report moves the ring with the run", () => {
  const ring = (usage, blocks, count) =>
    deriveContextUsageTokens([
      { kind: "assistant", rounds: [{ meta: { usage, usageBlockCount: count }, blocks }] },
    ]);
  const first = ring({ input: 1_000, output: 100 }, [{ kind: "text", text: "a" }], 1);
  const second = ring(
    { input: 5_000, output: 100 },
    [{ kind: "text", text: "a" }, { kind: "text", text: "b" }],
    2,
  );
  assert.ok(second > first, `${second} > ${first}`);
  assert.equal(second, 5_100);
});
