import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const mod = loader.loadModule("src/lib/chat/contextUsage.ts");

const {
  estimateContextUsage,
  extractObservedTotalTokens,
  formatTokenCount,
  resolveContextUsageLevel,
  CONTEXT_USAGE_WARN_RATIO,
  CONTEXT_USAGE_CRITICAL_RATIO,
} = mod;

test("formatTokenCount scales units", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_200), "1.2k");
  assert.equal(formatTokenCount(12_400), "12k");
  assert.equal(formatTokenCount(1_500_000), "1.5M");
});

test("resolveContextUsageLevel thresholds", () => {
  assert.equal(resolveContextUsageLevel(null), "unknown");
  assert.equal(resolveContextUsageLevel(0), "ok");
  assert.equal(resolveContextUsageLevel(CONTEXT_USAGE_WARN_RATIO - 0.01), "ok");
  assert.equal(resolveContextUsageLevel(CONTEXT_USAGE_WARN_RATIO), "warn");
  assert.equal(resolveContextUsageLevel(CONTEXT_USAGE_CRITICAL_RATIO), "critical");
});

test("estimateContextUsage empty state", () => {
  const snap = estimateContextUsage({ messages: [], contextWindow: 200_000 });
  assert.equal(snap.usedTokens, 0);
  assert.equal(snap.contextWindow, 200_000);
  assert.equal(snap.ratio, 0);
  assert.equal(snap.level, "ok");
  assert.equal(snap.percentLabel, "0%");
});

test("estimateContextUsage without context window", () => {
  const snap = estimateContextUsage({
    messages: [{ role: "user", content: "hello world", timestamp: 1 }],
    contextWindow: 0,
  });
  assert.ok(snap.usedTokens > 0);
  assert.equal(snap.ratio, null);
  assert.equal(snap.level, "unknown");
  assert.equal(snap.percentLabel, null);
});

test("estimateContextUsage marks critical near full window", () => {
  // ~4 chars/token → 50k chars ≈ 12.5k tokens against a 12k window → critical.
  const longText = "x".repeat(50_000);
  const snap = estimateContextUsage({
    messages: [{ role: "user", content: longText, timestamp: 1 }],
    contextWindow: 12_000,
  });
  assert.equal(snap.level, "critical");
  assert.ok(snap.ratio != null && snap.ratio >= CONTEXT_USAGE_CRITICAL_RATIO);
});

test("estimateContextUsage anchors on observed usage.totalTokens", () => {
  assert.equal(
    extractObservedTotalTokens({
      role: "assistant",
      content: "hi",
      usage: { totalTokens: 12_500 },
    }),
    12_500,
  );
  const snap = estimateContextUsage({
    messages: [
      { role: "user", content: "before", timestamp: 1 },
      {
        role: "assistant",
        content: "anchor",
        usage: { totalTokens: 10_000 },
        timestamp: 2,
      },
      { role: "user", content: "x".repeat(400), timestamp: 3 },
    ],
    // Would double-count if naively summed with system after an observation.
    systemPrompt: "sys that is already in observed usage",
    contextWindow: 200_000,
  });
  // 10000 + ~100 tokens for the follow-up user message (400 chars / 4 + envelope)
  assert.ok(snap.usedTokens >= 10_000);
  assert.ok(snap.usedTokens < 10_200);
});
