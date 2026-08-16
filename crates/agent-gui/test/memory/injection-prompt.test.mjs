import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const injection = loader.loadModule("src/lib/memory/prompts/injection.ts");
const { formatMemoryOverview, buildMemoryToolsSuffixSection, freshnessBucket } = injection;
const { capturePrefixShape, comparePrefixShape } = loader.loadModule(
  "src/lib/debug/prefixCacheShape.ts",
);

const DAY_MS = 86_400_000;

function entry(overrides = {}) {
  return {
    slug: "user-name",
    scope: "global",
    memoryType: "user",
    description: "用户叫苏枫",
    headline: "",
    dateLocal: null,
    updatedAt: Date.now(),
    unreviewed: false,
    confidence: "high",
    ...overrides,
  };
}

function overview(overrides = {}) {
  return {
    user: [],
    project: [],
    global: [],
    recentDays: [],
    root: "/tmp/memory",
    workdirHash: null,
    ...overrides,
  };
}

test("index renders compact lines with slug/type/age markers", () => {
  const text = formatMemoryOverview(overview({ user: [entry()] }));
  assert.ok(text.startsWith("# Memory Index"));
  assert.ok(text.includes("- 用户叫苏枫 [user-name|u|d0]"));
});

test("unreviewed entries carry the *:confidence marker and their own bucket", () => {
  const text = formatMemoryOverview(
    overview({
      user: [entry(), entry({ slug: "user-editor", unreviewed: true, confidence: "medium" })],
    }),
  );
  assert.ok(text.includes("## Unreviewed user memory"));
  assert.ok(text.includes("[user-editor|u*:m|d0]"));
});

test("buckets truncate at 30 entries with a recovery hint", () => {
  const entries = Array.from({ length: 35 }, (_, i) =>
    entry({ slug: `ref-${i}`, memoryType: "reference", description: `ref ${i}` }),
  );
  const text = formatMemoryOverview(overview({ global: entries }));
  assert.ok(text.includes("(5 more entries hidden"));
});

test("daily section renders titles only with the on-demand warning", () => {
  const text = formatMemoryOverview(
    overview({
      recentDays: [entry({ slug: "daily-2026-07-04", memoryType: "daily", dateLocal: "2026-07-04" })],
    }),
  );
  assert.ok(text.includes("## Recent daily journals"));
  assert.ok(text.includes("journal available on demand"));
});

test("project section shadows global and names the workdir", () => {
  const text = formatMemoryOverview(
    overview({
      project: [entry({ slug: "project-x", memoryType: "project", scope: "project" })],
      global: [entry({ slug: "ref-a", memoryType: "reference" })],
    }),
    "/Users/dev/project",
  );
  const projectIndex = text.indexOf("## Project memory (workdir: /Users/dev/project)");
  const globalIndex = text.indexOf("## Global memory");
  assert.ok(projectIndex >= 0 && globalIndex > projectIndex);
});

test("oversized overview truncates at the prompt cap with a suffix", () => {
  const entries = Array.from({ length: 30 }, (_, i) =>
    entry({
      slug: `ref-${i}`,
      memoryType: "reference",
      description: "很长的描述".repeat(60),
    }),
  );
  const text = formatMemoryOverview(overview({ global: entries, user: entries, project: entries }));
  assert.ok(text.length <= 16_000 + 200);
  assert.ok(text.includes("truncated"));
});

test("tools suffix embeds the memory usage rules exactly once", () => {
  const suffix = buildMemoryToolsSuffixSection();
  assert.ok(suffix.startsWith("## Memory"));
  assert.equal(suffix.match(/Conflict resolution \(in order\)/g)?.length, 1);
  assert.ok(suffix.includes('scope="project" gate'));
  assert.ok(suffix.includes("Self-review of (unreviewed) entries"));
});

// ---------------------------------------------------------------------------
// 新鲜度分桶:绝对天数会让 system prompt 每天漂移一次,整条缓存前缀作废。
// 分桶把漂移压到仅跨桶边界发生。

test("freshness buckets land on the documented boundaries", () => {
  assert.equal(freshnessBucket(0), "d0");
  assert.equal(freshnessBucket(1), "w");
  assert.equal(freshnessBucket(6), "w");
  assert.equal(freshnessBucket(7), "m");
  assert.equal(freshnessBucket(29), "m");
  assert.equal(freshnessBucket(30), "old");
});

test("freshness bucket is a pure function of the day count", () => {
  // 非法/缺失天数退化到 d0,与 daysAgo 的兜底一致,不得抛错。
  assert.equal(freshnessBucket(-1), "d0");
  assert.equal(freshnessBucket(Number.NaN), "d0");
  assert.equal(freshnessBucket(3), freshnessBucket(3));
  assert.equal(freshnessBucket(10_000), "old");
});

// 跨天稳定性是本次改动的核心收益:同一条 entry 只要还在同一个桶内,
// 无论 updatedAt 差几天,渲染出的 overview 必须字节一致。
function overviewAtAge(days) {
  return formatMemoryOverview(
    overview({ user: [entry({ updatedAt: Date.now() - days * DAY_MS })] }),
  );
}

test("crossing midnight inside one bucket keeps the overview byte-identical", () => {
  for (const [from, to] of [
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
    [12, 13],
    [28, 29],
    [30, 31],
    [90, 400],
  ]) {
    assert.equal(
      overviewAtAge(from),
      overviewAtAge(to),
      `${from}d 与 ${to}d 同桶,输出应完全相同`,
    );
  }
});

test("crossing a bucket boundary is the only case that changes the overview", () => {
  assert.notEqual(overviewAtAge(0), overviewAtAge(1));
  assert.notEqual(overviewAtAge(6), overviewAtAge(7));
  assert.notEqual(overviewAtAge(29), overviewAtAge(30));
});

// ---------------------------------------------------------------------------
// 用阶段 ① 的前缀哈希对账做端到端验证:memory 段是 system prompt 的一部分,
// 跨天但同桶时,归因必须是 unchanged(改动前此处为 "system")。

function shapeForAge(days) {
  return capturePrefixShape({
    systemPrompt: `base system prompt\n\n${overviewAtAge(days)}`,
    tools: [{ name: "MemoryManager", description: "memory", parameters: { type: "object" } }],
  });
}

test("3d → 4d crossing midnight is attributed as unchanged by prefix shape", () => {
  const diagnostics = comparePrefixShape(shapeForAge(3), shapeForAge(4));
  assert.equal(diagnostics.prefixChangeSummary, "unchanged");
  assert.equal(diagnostics.prefixChanged, false);
  assert.deepEqual(diagnostics.prefixChangeReasons, []);
});

test("6d → 7d crosses a bucket boundary and is still attributed to system", () => {
  const diagnostics = comparePrefixShape(shapeForAge(6), shapeForAge(7));
  assert.equal(diagnostics.prefixChangeSummary, "system");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["system"]);
});
