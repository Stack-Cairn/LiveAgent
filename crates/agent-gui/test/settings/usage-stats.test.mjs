// Settings → 用量统计: the pure logic behind the page (K-brain /v1/usage/stats,
// capability usage_stats). Dates are K-brain calendar days; nothing here depends on
// the machine's time zone.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const usage = loader.loadModule("@liveagent/ui/lib/usage/usageStats.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function day(date, total, models = {}, turns = 1) {
  return { date, input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, turns, models };
}

function stats(overrides = {}) {
  return usage.parseUsageStats({
    generatedAt: "2026-11-15T08:00:00Z",
    timezone: "Asia/Shanghai",
    days: 371,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, sessions: 0, costUSD: null },
    summary: { activeDays: 0, currentStreak: 0, longestStreak: 0, topModel: null, longestSession: null },
    daily: [],
    models: [],
    ...overrides,
  });
}

test("capability gating needs usage_stats >= 1", () => {
  assert.equal(usage.supportsUsageStats({ usage_stats: 1 }), true);
  assert.equal(usage.supportsUsageStats({ usage_stats: 2 }), true);
  for (const capabilities of [{}, { usage_stats: 0 }, { usage_stats: true }, { usage_stats: "1" }, null, undefined]) {
    assert.equal(usage.supportsUsageStats(capabilities), false, JSON.stringify(capabilities));
  }
});

test("parsing is lenient: bad numbers are 0, bad dates dropped, duplicates merged, models ordered", () => {
  const parsed = usage.parseUsageStats({
    totals: { input: "12", output: -3, cacheRead: Number.NaN, total: 40, turns: 2.5, sessions: "x", costUSD: "1.5" },
    summary: { topModel: "  ", longestSession: { id: "s1", title: 7, total: "90" } },
    daily: [
      { date: "2026-11-02", total: 5, turns: 1, models: { a: 5, "": 3, b: -1 } },
      { date: "2026-11-01", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      { date: "2026-02-30", total: 9 },
      { date: "nope", total: 9 },
      { date: "2026-11-02", total: 1, turns: 2, models: { a: 1 } },
      "garbage",
    ],
    models: [
      { model: "small", total: 1 },
      { model: "", total: 99 },
      { model: "big", provider: "p", total: 10, costUSD: 0.25 },
    ],
    extra: true,
  });
  assert.deepEqual(plain(parsed.totals), { input: 12, output: 0, cacheRead: 0, cacheWrite: 0, total: 40, turns: 2.5, sessions: 0, costUSD: null });
  assert.deepEqual(parsed.daily.map((row) => [row.date, row.total, row.turns]), [["2026-11-01", 10, 0], ["2026-11-02", 6, 3]]);
  assert.deepEqual(plain(parsed.daily[1].models), { a: 6 });
  assert.deepEqual(parsed.models.map((model) => [model.model, model.costUSD]), [["big", 0.25], ["small", null]]);
  assert.equal(parsed.summary.topModel, "big");
  assert.deepEqual(plain(parsed.summary.longestSession), { id: "s1", title: "", total: 90 });
  // No summary counts: worked out from the daily rows.
  assert.equal(parsed.summary.activeDays, 2);
  assert.equal(parsed.summary.longestStreak, 2);
  assert.equal(usage.hasUsage(parsed), true);
  assert.equal(usage.hasUsage(usage.parseUsageStats(null)), false);
  assert.equal(usage.hasUsage(usage.parseUsageStats("not json")), false);
});

test("gap filling yields consecutive days ending today, zero where K-brain had nothing", () => {
  const filled = usage.fillDailyRange([day("2026-10-30", 4), day("2026-11-01", 7)], "2026-11-02", 5);
  assert.deepEqual(filled.map((row) => [row.date, row.total]), [
    ["2026-10-29", 0], ["2026-10-30", 4], ["2026-10-31", 0], ["2026-11-01", 7], ["2026-11-02", 0],
  ]);
  // Month and year boundaries.
  assert.deepEqual(usage.fillDailyRange([], "2026-03-01", 2).map((row) => row.date), ["2026-02-28", "2026-03-01"]);
  assert.deepEqual(usage.fillDailyRange([], "2027-01-01", 2).map((row) => row.date), ["2026-12-31", "2027-01-01"]);
});

test("heatmap weeks start on Sunday and end with today's week", () => {
  // 2026-11-15 is a Sunday; 2026-11-18 a Wednesday.
  assert.equal(usage.weekday("2026-11-15"), 0);
  assert.equal(usage.weekStart("2026-11-18"), "2026-11-15");
  assert.equal(usage.weekStart("2026-11-15"), "2026-11-15");
  assert.equal(usage.weekStart("2026-11-14"), "2026-11-08");

  const map = usage.buildHeatmap([day("2026-11-16", 3), day("2026-11-18", 5)], "2026-11-18", "daily");
  assert.equal(map.weeks.length, 52);
  assert.equal(map.weeks.every((week) => week.cells.length === 7 && usage.weekday(week.start) === 0), true);
  const last = map.weeks.at(-1);
  assert.equal(last.start, "2026-11-15");
  assert.equal(last.end, "2026-11-18");
  assert.deepEqual(last.cells.map((cell) => [cell.date, cell.future, cell.total]), [
    ["2026-11-15", false, 0], ["2026-11-16", false, 3], ["2026-11-17", false, 0], ["2026-11-18", false, 5],
    ["2026-11-19", true, 0], ["2026-11-20", true, 0], ["2026-11-21", true, 0],
  ]);
  assert.equal(map.weeks[0].start, usage.addDays("2026-11-15", -51 * 7));
  assert.deepEqual(last.cells.map((cell) => cell.level), [0, 1, 0, 4, 0, 0, 0]);
});

test("weekly and cumulative heatmaps give a whole column its week's value", () => {
  const daily = [day("2026-11-01", 2, {}, 1), day("2026-11-03", 4, {}, 2), day("2026-11-09", 6, {}, 3), day("2026-11-16", 1, {}, 1)];
  const weekly = usage.buildHeatmap(daily, "2026-11-17", "weekly");
  const [a, b, c] = weekly.weeks.slice(-3);
  assert.deepEqual([a.start, a.total, a.turns], ["2026-11-01", 6, 3]);
  assert.deepEqual([b.start, b.total, b.turns], ["2026-11-08", 6, 3]);
  assert.deepEqual([c.start, c.total, c.turns], ["2026-11-15", 1, 1]);
  assert.equal(new Set(a.cells.map((cell) => cell.total)).size, 1);
  assert.equal(a.cells[0].total, 6);
  assert.equal(a.cells[0].level, 4);
  assert.equal(c.cells[0].level, 1);
  assert.equal(c.cells.at(-1).future, true);

  const cumulative = usage.buildHeatmap(daily, "2026-11-17", "cumulative");
  assert.deepEqual(cumulative.weeks.slice(-3).map((week) => [week.cumulativeTotal, week.cumulativeTurns]), [[6, 3], [12, 6], [13, 7]]);
  assert.equal(cumulative.weeks.at(-1).cells[0].total, 13);
  assert.equal(cumulative.weeks.at(-1).cells[0].level, 4);
  assert.equal(cumulative.weeks.at(-2).cells[0].level, 2);
  assert.equal(cumulative.weeks.at(-3).cells[0].level, 1);
  assert.equal(cumulative.weeks[0].cells[0].level, 0);
});

test("heat levels are quartiles of the days with usage, so one outlier doesn't wash out the rest", () => {
  // Eight ordinary days and one day 100x larger.
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 8000];
  const scale = plain(usage.heatScale([0, 0, ...values]));
  assert.deepEqual(scale, { p25: 30, p50: 50, p75: 70, max: 8000 });
  assert.deepEqual(values.map((value) => usage.heatLevel(value, scale)), [1, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(usage.heatLevel(0, scale), 0);
  // A share of the maximum would have put every ordinary day on level 1.
  const daily = values.map((value, index) => day(usage.addDays("2026-11-07", index), value));
  const map = usage.buildHeatmap(daily, "2026-11-15", "daily");
  const levels = map.weeks.flatMap((week) => week.cells).filter((cell) => cell.total > 0).map((cell) => cell.level);
  assert.deepEqual(levels, [1, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test("heat levels with ties and few values: the top value is always full strength", () => {
  const level = (values, value) => usage.heatLevel(value, usage.heatScale(values));
  // Everything equal (including a single active day): all on the top step.
  assert.deepEqual([5, 5, 5].map((value) => level([5, 5, 5], value)), [4, 4, 4]);
  assert.equal(level([7], 7), 4);
  // Two values: the smaller one lightest, the larger one darkest.
  assert.deepEqual([level([3, 5], 3), level([3, 5], 5)], [1, 4]);
  // Ties at the top stay on the top step; ties at the bottom stay on the lowest.
  assert.deepEqual([1, 5].map((value) => level([1, 5, 5, 5], value)), [1, 4]);
  assert.deepEqual([1, 5].map((value) => level([1, 1, 1, 5], value)), [1, 4]);
  // Nothing with usage: no scale, every cell empty.
  assert.deepEqual(plain(usage.heatScale([0, 0])), { p25: 0, p50: 0, p75: 0, max: 0 });
  assert.equal(level([], 3), 0);
});

test("weekly heat levels take one sample per week, not one per drawn cell", () => {
  // Three full weeks of 10, 20, 30 and the current week (today = Sunday) with 40.
  const daily = [day("2026-10-25", 10), day("2026-11-01", 20), day("2026-11-08", 30), day("2026-11-15", 40)];
  const weekly = usage.buildHeatmap(daily, "2026-11-15", "weekly");
  assert.deepEqual(plain(weekly.scale), { p25: 17.5, p50: 25, p75: 32.5, max: 40 });
  assert.deepEqual(weekly.weeks.slice(-4).map((week) => week.cells[0].level), [1, 2, 3, 4]);
});

test("month labels sit on the column holding the 1st; only the last 12 are kept", () => {
  const starts = Array.from({ length: 52 }, (_, index) => usage.addDays("2025-11-23", index * 7));
  const labels = usage.monthLabels(starts);
  assert.equal(labels.length, 12);
  for (const label of labels) {
    const start = starts[label.column];
    const first = `${label.year}-${String(label.month).padStart(2, "0")}-01`;
    assert.equal(first >= start && first <= usage.addDays(start, 6), true, `${first} in week of ${start}`);
  }
  // Column 0 (Nov 23-29) holds no 1st, so it stays blank; Dec 1 anchors column 1.
  assert.deepEqual(plain(labels[0]), { column: 1, year: 2025, month: 12, span: 4 });
  assert.deepEqual([labels.at(-1).year, labels.at(-1).month], [2026, 11]);
  // Spans run to the next label and the last one to the end.
  for (let index = 0; index < labels.length - 1; index++) {
    assert.equal(labels[index].column + labels[index].span, labels[index + 1].column);
  }
  assert.equal(labels.at(-1).column + labels.at(-1).span, 52);
  // A longer run keeps only the last 12 months; the dropped ones leave blank columns.
  const long = usage.monthLabels(Array.from({ length: 60 }, (_, index) => usage.addDays("2025-09-28", index * 7)));
  assert.equal(long.length, 12);
  // Oct and Nov 2025 are dropped: columns 0-8 carry no label.
  assert.deepEqual(plain(long[0]), { column: 9, year: 2025, month: 12, span: 4 });
  // A week containing the 1st on its Saturday still anchors there.
  const saturdayFirst = usage.monthLabels(["2026-07-26", "2026-08-02"]);
  assert.deepEqual(plain(saturdayFirst), [{ column: 0, year: 2026, month: 8, span: 2 }]);
});

test("more than six models fold into the top five plus other models", () => {
  const models = ["a", "b", "c", "d", "e", "f", "g"].map((model, index) => ({ model, provider: "p", total: 70 - index * 10 }));
  const slices = usage.buildModelSlices(stats({ models }));
  assert.equal(slices.length, 6);
  assert.deepEqual(slices.map((slice) => slice.model), ["a", "b", "c", "d", "e", null]);
  assert.deepEqual([slices[5].total, slices[5].merged, slices[5].colorIndex], [30, 2, null]);
  assert.equal(Math.abs(slices.reduce((sum, slice) => sum + slice.share, 0) - 1) < 1e-9, true);
  assert.deepEqual(slices.slice(0, 5).map((slice) => slice.colorIndex), [0, 1, 2, 3, 4]);

  const six = usage.buildModelSlices(stats({ models: models.slice(0, 6) }));
  assert.equal(six.length, 6);
  assert.equal(six.every((slice) => slice.model !== null), true);
  assert.deepEqual(usage.buildModelSlices(stats({ models: [{ model: "zero", total: 0 }] })), []);
});

test("the trend shows the range's top models, gap-filled, with Y max the largest single point", () => {
  const parsed = stats({
    models: [{ model: "m1", total: 100 }, { model: "m2", total: 50 }, { model: "m3", total: 10 }],
    daily: [
      day("2026-11-10", 30, { m1: 20, m2: 10 }),
      day("2026-11-12", 45, { m2: 40, m3: 5 }),
      day("2026-10-01", 999, { m1: 999 }),
    ],
  });
  const trend = usage.buildTrend(parsed, "2026-11-12", 7);
  assert.deepEqual(trend.days.map((row) => row.date), [
    "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12",
  ]);
  assert.deepEqual(trend.series.map((line) => [line.model, line.colorIndex]), [["m2", 1], ["m1", 0], ["m3", 2]]);
  assert.deepEqual(trend.series[0].values, [0, 0, 0, 0, 10, 0, 40]);
  // 40 (m2 on the 12th), not the 45 day total and not the out-of-range 999.
  assert.equal(trend.yMax, 40);
  assert.equal(usage.buildTrend(parsed, "2026-11-12", 30).days.length, 30);
  assert.equal(usage.buildTrend(parsed, "2026-11-12", 30, 1).series.length, 1);
  assert.equal(usage.trendYMax([]), 1);
  assert.equal(usage.trendYMax([{ values: [0, 0] }]), 1);
  assert.equal(usage.trendYMax([{ values: [3, 9] }, { values: [12, 1] }]), 12);
});

test("compact units: 万/亿 in Chinese, K/M/B in English, rolling over at unit edges", () => {
  const zh = (value) => usage.formatCompact(value, "zh-CN");
  const en = (value) => usage.formatCompact(value, "en-US");
  assert.equal(zh(0), "0");
  assert.equal(zh(9876), "9,876");
  assert.equal(zh(12_345), "1.23万");
  assert.equal(zh(123_456), "12.3万");
  assert.equal(zh(1_234_567), "123万");
  assert.equal(zh(99_999_999), "1亿");
  assert.equal(zh(250_000_000), "2.5亿");
  assert.equal(en(999), "999");
  assert.equal(en(1_500), "1.5K");
  assert.equal(en(999_999), "1M");
  assert.equal(en(12_340_000), "12.3M");
  assert.equal(en(3_000_000_000), "3B");
  assert.equal(en(-5), "0");
  assert.equal(en(Number.NaN), "0");
  assert.deepEqual(plain(usage.compactParts(123_456, "zh-CN")), { value: "12.3", unit: "万" });
  assert.deepEqual(plain(usage.compactParts(42, "en-US")), { value: "42", unit: "" });
  assert.equal(usage.formatTokens(1_500, "en-US"), "1.5K tokens");
  assert.equal(usage.formatTokens(15_000, "zh-CN"), "1.5万 tokens");
  assert.equal(usage.formatCostUSD(12.3456, "en-US"), "$12.35");
});

test("today follows the requested time zone", () => {
  const now = new Date("2026-11-15T20:30:00Z");
  assert.equal(usage.todayIn("Asia/Shanghai", now), "2026-11-16");
  assert.equal(usage.todayIn("America/Los_Angeles", now), "2026-11-15");
  assert.match(usage.todayIn("Not/AZone", now), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(usage.formatDay("2026-11-05", "zh-CN"), "11月5日");
  assert.equal(usage.formatDay("2026-11-05", "en-US", true), "Nov 5, 2026");
  assert.equal(usage.formatMonth(1, "zh-CN"), "1月");
  assert.equal(usage.formatMonth(11, "zh-CN"), "11月");
  assert.equal(usage.formatMonth(12, "en-US"), "Dec");
});
