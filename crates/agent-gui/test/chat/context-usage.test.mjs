import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const contextUsage = loader.loadModule("@liveagent/ui/lib/chat/contextUsage.ts");
const tokenLedger = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");

const {
  CONTEXT_USAGE_WARN_RATIO,
  CONTEXT_USAGE_DANGER_RATIO,
  contextUsageLevel,
  canManualCompact,
  contextUsageRatio,
  deriveContextUsageTokens,
  estimateTextTokens,
} = contextUsage;

test("threshold boundaries: <50% ok, 50-80% warn, >=80% danger", () => {
  assert.equal(CONTEXT_USAGE_WARN_RATIO, 0.5);
  assert.equal(CONTEXT_USAGE_DANGER_RATIO, 0.8);
  assert.equal(contextUsageLevel(0), "ok");
  assert.equal(contextUsageLevel(0.49), "ok");
  assert.equal(contextUsageLevel(0.5), "warn");
  assert.equal(contextUsageLevel(0.79), "warn");
  assert.equal(contextUsageLevel(0.8), "danger");
  assert.equal(contextUsageLevel(1.5), "danger");
});

test("manual compaction unlocks exactly at the warn ratio", () => {
  assert.equal(canManualCompact(0.49), false);
  assert.equal(canManualCompact(0.5), true);
  assert.equal(canManualCompact(0.99), true);
});

test("contextUsageRatio guards degenerate inputs", () => {
  assert.equal(contextUsageRatio(100_000, 200_000), 0.5);
  assert.equal(contextUsageRatio(undefined, 200_000), 0);
  assert.equal(contextUsageRatio(100_000, undefined), 0);
  assert.equal(contextUsageRatio(100_000, 0), 0);
  assert.equal(contextUsageRatio(-1, 200_000), 0);
  assert.equal(contextUsageRatio(Number.NaN, 200_000), 0);
});

test("deriveContextUsageTokens reads the newest assistant round usage", () => {
  const items = [
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [{ meta: { usageTotalTokens: 10_000 } }, { meta: { usageTotalTokens: 12_000 } }],
    },
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [{ meta: {} }, { meta: { usageTotalTokens: 34_000 } }, { meta: {} }],
    },
  ];
  assert.equal(deriveContextUsageTokens(items), 34_000);
});

test("deriveContextUsageTokens falls back to checkpoint estimate after compaction", () => {
  const summaryText = "摘要正文 summary body".repeat(50);
  // GUI 检查点（kind:"summary"）与 WebUI 检查点（kind:"checkpoint"）同口径。
  for (const kind of ["summary", "checkpoint"]) {
    const items = [
      { kind: "assistant", rounds: [{ meta: { usageTotalTokens: 190_000 } }] },
      { kind, content: summaryText },
    ];
    const derived = deriveContextUsageTokens(items);
    assert.equal(derived, estimateTextTokens(summaryText));
    assert.ok(derived > 0, "checkpoint estimate must keep the ring alive");
    assert.ok(derived < 190_000, "estimate must reflect the freed context");
  }
});

test("deriveContextUsageTokens returns undefined without any usage", () => {
  assert.equal(deriveContextUsageTokens([]), undefined);
  assert.equal(deriveContextUsageTokens([{ kind: "user" }]), undefined);
  assert.equal(
    deriveContextUsageTokens([{ kind: "assistant", rounds: [{ meta: {} }] }]),
    undefined,
  );
});

test("estimateTextTokens keeps the CJK-aware estimate after the move to shared", () => {
  // tokenLedger re-export 与共享层实现必须是同一函数（迁移不改口径）。
  assert.equal(tokenLedger.estimateTextTokens, estimateTextTokens);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("   "), 0);
  // 4 个西文字符 ≈ 1 token；CJK 每字 0.7 token（向上取整）。
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("你好世界"), Math.ceil(4 * 0.7));
  // 可加性：分段和 = 整体（同一字符串拼接）。
  const west = "hello world ";
  const cjk = "上下文压缩";
  assert.equal(
    Math.ceil(
      contextUsage.estimateTextTokenUnits(west) + contextUsage.estimateTextTokenUnits(cjk),
    ),
    estimateTextTokens(west + cjk),
  );
});
