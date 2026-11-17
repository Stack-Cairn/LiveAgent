/**
 * Settings → Usage: K-brain's cross-session token usage (`GET /v1/usage/stats`,
 * `capabilities.usage_stats`), read leniently and shaped for the page's cards,
 * heatmap, trend and model breakdown. Pure functions only, so the page logic is
 * testable without a DOM.
 *
 * Dates are K-brain's local calendar days ("YYYY-MM-DD" in the requested time
 * zone) and all calendar math here runs on those strings in UTC, so the browser's
 * own offset never shifts a day.
 */

/** One year of days: 52 full weeks plus the current one. */
export const USAGE_STATS_DAYS = 371;
export const HEATMAP_WEEKS = 52;
export const MAX_MONTH_LABELS = 12;
/** More model slices than this fold into top (limit - 1) + "other". */
export const MAX_MODEL_SLICES = 6;
export const MAX_TREND_SERIES = 5;
export const USAGE_SERIES_SLOTS = 8;
export const HEATMAP_LEVELS = 4;

export type UsageTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type UsageDay = UsageTokens & {
  date: string;
  turns: number;
  models: Record<string, number>;
};

export type UsageModel = UsageTokens & {
  model: string;
  provider: string;
  turns: number;
  costUSD: number | null;
};

export type UsageStats = {
  generatedAt: string;
  timezone: string;
  days: number;
  totals: UsageTokens & { turns: number; sessions: number; costUSD: number | null };
  summary: {
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
    topModel: string | null;
    longestSession: { id: string; title: string; total: number } | null;
  };
  daily: UsageDay[];
  models: UsageModel[];
};

/**
 * What a host returns for one load. `available: false` means the K-brain behind it
 * has no `capabilities.usage_stats` (an older backend), which the page reports as
 * "update needed" rather than as an error. `stats` is K-brain's JSON as received.
 */
export type UsageStatsAnswer = { available: false } | { available: true; stats: unknown };

export type UsageStatsQuery = { days: number; timezone: string };

export function supportsUsageStats(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const version = (capabilities as Record<string, unknown>).usage_stats;
  return typeof version === "number" && Number.isFinite(version) && version >= 1;
}

/** The browser's IANA time zone; empty lets K-brain use its own. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

// ---- lenient parsing ----

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokens(source: Record<string, unknown>): UsageTokens {
  const input = count(source.input);
  const output = count(source.output);
  const cacheRead = count(source.cacheRead);
  const cacheWrite = count(source.cacheWrite);
  // K-brain input already includes cache reads/writes; those are subsets.
  const total =
    source.total === undefined || source.total === null ? input + output : count(source.total);
  return { input, output, cacheRead, cacheWrite, total };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
}

function modelCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, amount] of Object.entries(record(value))) {
    const name = model.trim();
    const total = count(amount);
    if (name && total > 0) out[name] = (out[name] ?? 0) + total;
  }
  return out;
}

/**
 * Reads K-brain's answer without trusting its shape: missing or malformed numbers
 * are 0, unknown fields are ignored, daily rows with bad dates are dropped and
 * duplicates merged, and models are ordered by total (largest first).
 */
export function parseUsageStats(raw: unknown, now: Date = new Date()): UsageStats {
  const source = record(typeof raw === "string" ? safeJson(raw) : raw);
  const totalsSource = record(source.totals);
  const summarySource = record(source.summary);

  const byDate = new Map<string, UsageDay>();
  for (const item of Array.isArray(source.daily) ? source.daily : []) {
    const row = record(item);
    const date = text(row.date);
    if (!isCalendarDate(date)) continue;
    const day: UsageDay = {
      date,
      ...tokens(row),
      turns: count(row.turns),
      models: modelCounts(row.models),
    };
    const existing = byDate.get(date);
    if (!existing) {
      byDate.set(date, day);
      continue;
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "turns"] as const) {
      existing[key] += day[key];
    }
    for (const [model, amount] of Object.entries(day.models)) {
      existing.models[model] = (existing.models[model] ?? 0) + amount;
    }
  }
  const daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const models: UsageModel[] = [];
  for (const item of Array.isArray(source.models) ? source.models : []) {
    const row = record(item);
    const model = text(row.model);
    if (!model) continue;
    models.push({
      model,
      provider: text(row.provider),
      ...tokens(row),
      turns: count(row.turns),
      costUSD: cost(row.costUSD),
    });
  }
  models.sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));

  const longest = record(summarySource.longestSession);
  const longestId = text(longest.id);
  const topModel = text(summarySource.topModel) || models[0]?.model || null;

  // An answer without totals or summary counts still shows what its daily rows say.
  const sumDaily = (key: keyof UsageTokens | "turns") =>
    daily.reduce((total, day) => total + day[key], 0);
  const totals =
    source.totals && typeof source.totals === "object"
      ? { ...tokens(totalsSource), turns: count(totalsSource.turns) }
      : {
          input: sumDaily("input"),
          output: sumDaily("output"),
          cacheRead: sumDaily("cacheRead"),
          cacheWrite: sumDaily("cacheWrite"),
          total: sumDaily("total"),
          turns: sumDaily("turns"),
        };
  const generatedAt = new Date(text(source.generatedAt));
  const snapshotTime = Number.isNaN(generatedAt.getTime()) ? now : generatedAt;
  const streaks = dailyStreaks(daily, todayIn(text(source.timezone), snapshotTime));
  const summaryCount = (key: string, fallback: number) =>
    summarySource[key] === undefined || summarySource[key] === null
      ? fallback
      : count(summarySource[key]);

  return {
    generatedAt: text(source.generatedAt),
    timezone: text(source.timezone),
    days: count(source.days),
    totals: {
      ...totals,
      sessions: count(totalsSource.sessions),
      costUSD: cost(totalsSource.costUSD),
    },
    summary: {
      activeDays: summaryCount("activeDays", streaks.active),
      currentStreak: summaryCount("currentStreak", streaks.current),
      longestStreak: summaryCount("longestStreak", streaks.longest),
      topModel,
      longestSession: longestId
        ? { id: longestId, title: text(longest.title), total: count(longest.total) }
        : null,
    },
    daily,
    models,
  };
}

/**
 * Active days and streaks from daily rows alone, for answers without a summary.
 * The current streak must reach today or yesterday in the snapshot time zone.
 */
function dailyStreaks(
  daily: readonly UsageDay[],
  today: string,
): {
  active: number;
  current: number;
  longest: number;
} {
  let active = 0;
  let longest = 0;
  let run = 0;
  let previous = "";
  for (const day of daily) {
    if (day.date > today || !(day.total > 0 || day.turns > 0)) continue;
    active += 1;
    run = previous && addDays(previous, 1) === day.date ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day.date;
  }
  return { active, current: previous >= addDays(today, -1) ? run : 0, longest };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Nothing recorded yet: the page shows its empty state instead of empty charts. */
export function hasUsage(stats: UsageStats): boolean {
  return (
    stats.totals.total > 0 ||
    stats.totals.turns > 0 ||
    stats.daily.some((day) => day.total > 0 || day.turns > 0)
  );
}

// ---- calendar ----

const DAY_MS = 86_400_000;

function toTime(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromTime(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromTime(toTime(date) + days * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(toTime(date)).getUTCDay();
}

/** The Sunday that starts `date`'s week. */
export function weekStart(date: string): string {
  return addDays(date, -weekday(date));
}

/** Today in `timeZone` (falls back to the runtime's zone when it is not valid). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const format = (zone?: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  try {
    return format(timeZone || undefined);
  } catch {
    return format();
  }
}

/**
 * `length` consecutive days ending on `end`, with K-brain's usage where it has any
 * and zero days elsewhere (K-brain only lists days with usage).
 */
export function fillDailyRange(
  daily: readonly UsageDay[],
  end: string,
  length: number,
): UsageDay[] {
  const known = new Map(daily.map((day) => [day.date, day]));
  const out: UsageDay[] = [];
  for (let offset = length - 1; offset >= 0; offset--) {
    const date = addDays(end, -offset);
    out.push(
      known.get(date) ?? {
        date,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        turns: 0,
        models: {},
      },
    );
  }
  return out;
}

// ---- heatmap ----

export type HeatmapMode = "daily" | "weekly" | "cumulative";

export type HeatmapCell = {
  date: string;
  /** After today: drawn empty, no tooltip. */
  future: boolean;
  /** The day's (daily), the week's (weekly) or the running (cumulative) value. */
  total: number;
  turns: number;
  level: number;
};

export type HeatmapWeek = {
  /** Sunday. */
  start: string;
  /** Saturday, or today for the current week. */
  end: string;
  total: number;
  turns: number;
  cumulativeTotal: number;
  cumulativeTurns: number;
  /** Sunday first: index 0 is Sunday. */
  cells: HeatmapCell[];
};

export type MonthLabel = { column: number; span: number; year: number; month: number };

export type Heatmap = { weeks: HeatmapWeek[]; monthLabels: MonthLabel[]; scale: HeatScale };

/** Quartile cut points of the values with usage; see {@link heatScale}. */
export type HeatScale = { p25: number; p50: number; p75: number; max: number };

/** The q-quantile (0…1) of ascending `sorted`, interpolating between neighbours. */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const lower = sorted[below] ?? 0;
  const upper = sorted[Math.min(below + 1, sorted.length - 1)] ?? lower;
  return lower + (upper - lower) * (position - below);
}

/**
 * Quartiles of the positive values, so one huge day doesn't wash out the rest of
 * the map the way a share of the maximum would. Zeros don't count.
 */
export function heatScale(values: readonly number[]): HeatScale {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { p25: 0, p50: 0, p75: 0, max: 0 };
  return {
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * 0 for nothing; otherwise ≤p25 → 1, ≤p50 → 2, ≤p75 → 3, above → 4. The largest
 * value is always 4, so ties at the top (and a map where every value is the same)
 * show at full strength instead of dropping to a lighter step.
 */
export function heatLevel(value: number, scale: HeatScale): number {
  if (!(value > 0) || !(scale.max > 0)) return 0;
  if (value >= scale.max) return HEATMAP_LEVELS;
  if (value <= scale.p25) return 1;
  if (value <= scale.p50) return 2;
  if (value <= scale.p75) return 3;
  return 4;
}

/**
 * The last `weeks` weeks ending with today's, one column per week, Sunday in the
 * first row. Weekly and cumulative modes give every day of a column its week's
 * value, so the page can highlight the whole column.
 */
export function buildHeatmap(
  daily: readonly UsageDay[],
  today: string,
  mode: HeatmapMode,
  weeks = HEATMAP_WEEKS,
): Heatmap {
  const first = addDays(weekStart(today), -(weeks - 1) * 7);
  const days = fillDailyRange(daily, addDays(first, weeks * 7 - 1), weeks * 7);
  const columns: HeatmapWeek[] = [];
  let runningTotal = 0;
  let runningTurns = 0;
  for (let column = 0; column < weeks; column++) {
    const slice = days.slice(column * 7, column * 7 + 7);
    const past = slice.filter((day) => day.date <= today);
    const total = past.reduce((sum, day) => sum + day.total, 0);
    const turns = past.reduce((sum, day) => sum + day.turns, 0);
    runningTotal += total;
    runningTurns += turns;
    const start = slice[0]?.date ?? first;
    const saturday = addDays(start, 6);
    columns.push({
      start,
      end: saturday > today ? today : saturday,
      total,
      turns,
      cumulativeTotal: runningTotal,
      cumulativeTurns: runningTurns,
      cells: slice.map((day) => ({
        date: day.date,
        future: day.date > today,
        total: day.total,
        turns: day.turns,
        level: 0,
      })),
    });
  }

  const value = (week: HeatmapWeek, cell: HeatmapCell) =>
    mode === "daily" ? cell.total : mode === "weekly" ? week.total : week.cumulativeTotal;
  const turnsOf = (week: HeatmapWeek, cell: HeatmapCell) =>
    mode === "daily" ? cell.turns : mode === "weekly" ? week.turns : week.cumulativeTurns;
  // One sample per day (daily) or per week (weekly, cumulative), not per drawn cell,
  // so a week's seven copies of its value don't weigh seven times.
  const samples: number[] = [];
  for (const week of columns) {
    const past = week.cells.filter((cell) => !cell.future);
    if (mode === "daily") for (const cell of past) samples.push(cell.total);
    else if (past.length > 0) samples.push(mode === "weekly" ? week.total : week.cumulativeTotal);
  }
  const scale = heatScale(samples);
  for (const week of columns) {
    week.cells = week.cells.map((cell) =>
      cell.future
        ? cell
        : {
            ...cell,
            total: value(week, cell),
            turns: turnsOf(week, cell),
            level: heatLevel(value(week, cell), scale),
          },
    );
  }
  return { weeks: columns, monthLabels: monthLabels(columns.map((week) => week.start)), scale };
}

/**
 * A label for each month whose 1st falls in a column, at that column. Only the last
 * `limit` are kept; earlier columns stay unlabeled. Each label spans up to the next
 * one (or the end) so text never overlaps.
 */
export function monthLabels(weekStarts: readonly string[], limit = MAX_MONTH_LABELS): MonthLabel[] {
  const anchors: { column: number; year: number; month: number }[] = [];
  weekStarts.forEach((start, column) => {
    for (let day = 0; day < 7; day++) {
      const date = addDays(start, day);
      if (date.endsWith("-01")) {
        anchors.push({ column, year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) });
        break;
      }
    }
  });
  const kept = anchors.slice(-limit);
  return kept.map((anchor, index) => ({
    ...anchor,
    span: (kept[index + 1]?.column ?? weekStarts.length) - anchor.column,
  }));
}

// ---- models: colors, donut, trend ----

/**
 * Models ranked by all-time total (K-brain's models list, then any model only seen
 * in daily rows). A model keeps its rank, and so its color, across the donut and
 * the trend when it fits the fixed palette. Lower-ranked models use unused colors
 * among the visible trend series so they do not all collapse to gray.
 */
export function modelRanking(stats: UsageStats): string[] {
  const ranked = stats.models.map((model) => model.model);
  const seen = new Set(ranked);
  const extra = new Map<string, number>();
  for (const day of stats.daily) {
    for (const [model, amount] of Object.entries(day.models)) {
      if (!seen.has(model)) extra.set(model, (extra.get(model) ?? 0) + amount);
    }
  }
  return [
    ...ranked,
    ...[...extra.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m),
  ];
}

export type ModelSlice = {
  key: string;
  /** null for the merged "other models" slice. */
  model: string | null;
  provider: string;
  total: number;
  share: number;
  /** Rank in `modelRanking`; null for "other". */
  colorIndex: number | null;
  /** Models folded into "other". */
  merged: number;
};

/** Donut slices: every model, or top (limit - 1) + "other" when there are more than `limit`. */
export function buildModelSlices(stats: UsageStats, limit = MAX_MODEL_SLICES): ModelSlice[] {
  const ranking = modelRanking(stats);
  const models = stats.models.filter((model) => model.total > 0);
  const sum = models.reduce((total, model) => total + model.total, 0);
  if (sum <= 0) return [];
  const slice = (model: UsageModel): ModelSlice => ({
    key: JSON.stringify([model.model, model.provider]),
    model: model.model,
    provider: model.provider,
    total: model.total,
    share: model.total / sum,
    colorIndex: ranking.indexOf(model.model),
    merged: 0,
  });
  if (models.length <= limit) return models.map(slice);
  const head = models.slice(0, limit - 1).map(slice);
  const rest = models.slice(limit - 1);
  const restTotal = rest.reduce((total, model) => total + model.total, 0);
  return [
    ...head,
    {
      key: "__other__",
      model: null,
      provider: "",
      total: restTotal,
      share: restTotal / sum,
      colorIndex: null,
      merged: rest.length,
    },
  ];
}

export type TrendRange = 7 | 30;

export type TrendSeries = { model: string; colorIndex: number; values: number[] };

export type Trend = {
  days: UsageDay[];
  series: TrendSeries[];
  /** The largest single point among the shown lines (1 when all are 0). */
  yMax: number;
};

/** The largest single value among the given lines; 1 when there is none. */
export function trendYMax(series: readonly { values: readonly number[] }[]): number {
  let max = 0;
  for (const line of series) for (const value of line.values) if (value > max) max = value;
  return max > 0 ? max : 1;
}

/** The last `range` days (gap-filled), one line per top model of that range. */
export function buildTrend(
  stats: UsageStats,
  today: string,
  range: TrendRange,
  limit = MAX_TREND_SERIES,
): Trend {
  const days = fillDailyRange(stats.daily, today, range);
  const ranking = modelRanking(stats);
  const sums = new Map<string, number>();
  for (const day of days) {
    for (const [model, amount] of Object.entries(day.models)) {
      sums.set(model, (sums.get(model) ?? 0) + amount);
    }
  }
  const top = [...sums.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1] || ranking.indexOf(a[0]) - ranking.indexOf(b[0]))
    .slice(0, limit)
    .map(([model]) => model);
  // Preserve palette colors for the visible top-ranked models, then give each
  // lower-ranked visible model an unused slot. Only the donut's "other" is gray.
  // Slots the donut never shows (past its named slices) go first, so a borrowed
  // color does not match a top model still named in the donut.
  const colors = new Map<string, number>();
  for (const model of top) {
    const rank = ranking.indexOf(model);
    if (rank >= 0 && rank < USAGE_SERIES_SLOTS) colors.set(model, rank);
  }
  const used = new Set(colors.values());
  const donutSlots = MAX_MODEL_SLICES - 1;
  const free = Array.from({ length: USAGE_SERIES_SLOTS }, (_, index) => index).filter(
    (index) => !used.has(index),
  );
  const available = [
    ...free.filter((index) => index >= donutSlots),
    ...free.filter((index) => index < donutSlots),
  ];
  for (const model of [...top].sort((a, b) => ranking.indexOf(a) - ranking.indexOf(b))) {
    if (!colors.has(model))
      colors.set(model, available.shift() ?? ranking.indexOf(model) % USAGE_SERIES_SLOTS);
  }
  const series = top.map((model) => ({
    model,
    colorIndex: colors.get(model) ?? 0,
    values: days.map((day) => day.models[model] ?? 0),
  }));
  return { days, series, yMax: trendYMax(series) };
}

// ---- formatting ----

export type UsageLocale = "zh-CN" | "en-US";

export type CompactParts = { value: string; unit: string };

const UNITS: Record<UsageLocale, readonly (readonly [number, string])[]> = {
  "zh-CN": [
    [1e8, "亿"],
    [1e4, "万"],
  ],
  "en-US": [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ],
};

function trimmed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}

/**
 * A token count split into number and unit for the page's mono digits + sans unit:
 * 中文 万/亿, English K/M/B. Up to 3 significant digits above the first unit; a
 * value that rounds up to the next unit moves to it (999,999 → 1M, not 1000K).
 */
export function compactParts(raw: number, locale: UsageLocale): CompactParts {
  const value = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const units = UNITS[locale];
  const smallest = units[units.length - 1]?.[0] ?? 1;
  if (value < smallest) {
    return { value: Math.round(value).toLocaleString(locale), unit: "" };
  }
  for (let index = 0; index < units.length; index++) {
    const [size, unit] = units[index] as readonly [number, string];
    if (value < size) continue;
    const scaled = value / size;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    const rounded = Number(scaled.toFixed(digits));
    const larger = units[index - 1];
    if (larger && rounded * size >= larger[0]) {
      return { value: trimmed(1, 2), unit: larger[1] };
    }
    return { value: trimmed(rounded, digits), unit };
  }
  return { value: Math.round(value).toLocaleString(locale), unit: "" };
}

export function formatCompact(value: number, locale: UsageLocale): string {
  const parts = compactParts(value, locale);
  return `${parts.value}${parts.unit}`;
}

/** "1.2万 tokens" / "3.4M tokens". */
export function formatTokens(value: number, locale: UsageLocale): string {
  return `${formatCompact(value, locale)} tokens`;
}

export function formatInteger(value: number, locale: UsageLocale): string {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString(locale);
}

export function formatCostUSD(value: number, locale: UsageLocale): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

/** "11月15日" / "Nov 15"; with `year`, "2026年11月15日" / "Nov 15, 2026". */
export function formatDay(date: string, locale: UsageLocale, year = false): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    // zh-CN "long" reads 11月5日; "numeric" would give 11/5.
    month: locale === "zh-CN" ? "long" : "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  }).format(new Date(toTime(date)));
}

export function formatMonth(month: number, locale: UsageLocale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
  }).format(new Date(Date.UTC(2000, month - 1, 1)));
}
