import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const injection = loader.loadModule("src/lib/memory/prompts/injection.ts");
const { formatMemoryOverview, buildMemoryToolsSuffixSection } = injection;

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
  assert.ok(text.includes("- 用户叫苏枫 [user-name|u|0d]"));
});

test("unreviewed entries carry the *:confidence marker and their own bucket", () => {
  const text = formatMemoryOverview(
    overview({
      user: [entry(), entry({ slug: "user-editor", unreviewed: true, confidence: "medium" })],
    }),
  );
  assert.ok(text.includes("## Unreviewed user memory"));
  assert.ok(text.includes("[user-editor|u*:m|0d]"));
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
