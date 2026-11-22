#!/usr/bin/env node
// Performance regression gate built on the node micro-benchmarks in
// crates/agent-gui/perf (SSE record splitting, transcript projection, WebUI
// transcript store, measurement LRU).
//
// Wall-clock numbers on shared CI runners are noisy, and they also differ by
// engine and memory bandwidth in ways a CPU calibration does not capture
// (the SSE split measured ~4x slower, normalized, on Node 22 / ubuntu than
// on the Node 26 machine that recorded the baseline). So the gate is built on
// signals that survive a slow, busy or different machine:
//   - scaling ratios are the primary gate: cost for 8x the event size (SSE),
//     10x the history (store), re-projection vs. fresh projection. They need
//     no baseline, are the same on any engine, and catch the regressions that
//     matter: work that grows quadratically with event or conversation size;
//   - every benchmark runs in several fresh processes and the median is used;
//   - timings are only a backstop against gross slowdowns: normalized by a
//     calibration workload measured in the same job, they fail beyond a wide
//     factor (5-10x) of the committed baseline plus an absolute floor;
//   - deterministic outputs (persisted snapshot bytes) are compared directly.
//
// Usage:
//   node scripts/check-perf-micro.mjs [--repeat N] [--update] [--json out.json]
// `--update` rewrites scripts/budgets/perf-micro-baseline.json from this run
// (see docs/testing/ci-checks.md).

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(repoRoot, "crates/agent-gui");
export const BASELINE_FILE = path.join(repoRoot, "scripts/budgets/perf-micro-baseline.json");

// Gate kinds:
//   time:  normalized value may not exceed max(baseline * factor, baseline + floor);
//   ratio: value may not exceed `max` (machine- and engine-independent);
//   exact: value may not drift more than `tolerance` (relative) from baseline;
//   info:  reported only.
//
// Limits (observed: Node 26 / macOS arm64 baseline machine, Node 22 / ubuntu CI):
//   - SSE 16 MB / 2 MB: linear work gives 5-10, idle or with every core
//     busy; a splitter that re-joins its buffer per chunk gives ~100.
//     Limit 30. The sizes stay small on purpose: past ~16 MB the per-MB cost
//     itself rises under load (32 MB / 8 MB went from 7 to 12 with all cores
//     busy) and the ratio stops meaning "linear or not".
//   - SSE times: CI ran at ~4x the baseline after normalization (engine and
//     memory differences); the backstop allows 10x. The quadratic splitter
//     measured 30-100x.
//   - store/projection times: CI ran at 1.2-2x; the backstop allows 5-6x.
export const METRICS = [
  { key: "sse.scaling16vs2", label: "SSE split 16 MB / 2 MB", kind: "ratio", max: 30 },
  { key: "sse.incremental2mbMs", label: "SSE split, 2 MB event, fastest run (ms)", kind: "time", factor: 10, floor: 5 },
  { key: "sse.incremental16mbMs", label: "SSE split, 16 MB event, fastest run (ms)", kind: "time", factor: 10, floor: 20 },
  { key: "projection.reuseRatio", label: "Re-projection / projection", kind: "ratio", max: 0.5 },
  { key: "projection.freshMs", label: "Projection, 2000 messages (ms)", kind: "time", factor: 5, floor: 10 },
  { key: "projection.reprojectMs", label: "Re-projection, same messages (ms)", kind: "time", factor: 6, floor: 3 },
  { key: "store.historyScaling", label: "Store event 2000 / 200 turns", kind: "ratio", max: 5 },
  { key: "store.usPerEvent200", label: "Store token event, 200 turns (us)", kind: "time", factor: 5, floor: 3 },
  { key: "store.usPerEvent2000", label: "Store token event, 2000 turns (us)", kind: "time", factor: 5, floor: 3 },
  { key: "lru.persistedBytes", label: "Measurement snapshot (bytes)", kind: "exact", tolerance: 0.05 },
];

function parseArguments(argv) {
  const options = { repeat: 5, update: false, json: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return value;
    };
    if (flag === "--repeat") options.repeat = Math.max(1, Number(take()) || 1);
    else if (flag === "--update") options.update = true;
    else if (flag === "--json") options.json = path.resolve(take());
    else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

export function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * A fixed CPU-bound workload with the same flavor as the benchmarks (object
 * churn, JSON, string scanning, Map traffic). Median of several rounds, ms.
 */
export function calibrate(rounds = 9) {
  const times = [];
  let sink = 0;
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    const rows = [];
    for (let index = 0; index < 20_000; index += 1) {
      rows.push({ id: `row-${index}`, size: index % 97, text: `item ${index} `.repeat(4) });
    }
    const parsed = JSON.parse(JSON.stringify(rows));
    const map = new Map();
    for (const row of parsed) map.set(row.id, row.size);
    const text = parsed.map((row) => row.text).join("\n");
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      sink += 1;
    }
    sink += map.size;
    times.push(performance.now() - started);
  }
  if (sink === 0) throw new Error("calibration did nothing");
  return median(times);
}

function runBench(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: appRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

/** Runs every benchmark `repeat` times in fresh processes; returns per-metric medians. */
export function measure(repeat) {
  const samples = {};
  const add = (key, value) => {
    samples[key] ??= [];
    samples[key].push(value);
  };
  for (let run = 0; run < repeat; run += 1) {
    // Fastest of several runs per process: interference only adds time, and
    // it hits the longer run more, which would skew the ratio.
    const [sse2] = runBench("perf/sse-bench.mjs", ["--parsers=incremental", "--mb=2", "--runs=15"]);
    const [sse16] = runBench("perf/sse-bench.mjs", ["--parsers=incremental", "--mb=16", "--runs=9"]);
    add("sse.incremental2mbMs", sse2.minMs);
    add("sse.incremental16mbMs", sse16.minMs);
    add("sse.scaling16vs2", sse16.minMs / Math.max(0.01, sse2.minMs));

    const [projection] = runBench("perf/projection-bench.mjs");
    add("projection.freshMs", projection.freshMedianMs);
    add("projection.reprojectMs", projection.reprojectMedianMs);
    add("projection.reuseRatio", projection.reprojectMedianMs / Math.max(0.05, projection.freshMedianMs));

    const store = runBench("perf/store-bench.mjs");
    const small = store.find((row) => row.turns === 200);
    const large = store.find((row) => row.turns === 2000);
    add("store.usPerEvent200", small.usPerEvent);
    add("store.usPerEvent2000", large.usPerEvent);
    add("store.historyScaling", large.usPerEvent / Math.max(0.05, small.usPerEvent));

    const [lru] = runBench("perf/lru-bench.mjs");
    add("lru.persistedBytes", lru.bytes);
  }
  return Object.fromEntries(
    Object.entries(samples).map(([key, values]) => [key, Number(median(values).toFixed(3))]),
  );
}

/** One row per metric with its verdict. `speed` = current calibration / baseline calibration. */
export function compare(metrics, baseline, speed) {
  return METRICS.map((metric) => {
    const current = metrics[metric.key];
    const expected = baseline.metrics?.[metric.key];
    const row = { ...metric, current, baseline: expected ?? null, normalized: null, limit: null };
    if (metric.kind === "info") return { ...row, status: "info" };
    if (typeof current !== "number" || Number.isNaN(current)) return { ...row, status: "missing" };
    if (metric.kind === "ratio") {
      row.limit = metric.max;
      return { ...row, status: current > metric.max ? "fail" : "ok" };
    }
    if (typeof expected !== "number") return { ...row, status: "missing" };
    if (metric.kind === "exact") {
      row.limit = expected * (1 + metric.tolerance);
      const drift = Math.abs(current - expected) / Math.max(1, expected);
      return { ...row, status: drift > metric.tolerance ? "fail" : "ok" };
    }
    // time
    row.normalized = Number((current / speed).toFixed(3));
    row.limit = Math.max(expected * metric.factor, expected + metric.floor);
    return { ...row, status: row.normalized > row.limit ? "fail" : "ok" };
  });
}

function fmt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
  return String(Number(value.toFixed(2)));
}

export function renderTable(rows, { calibrationMs, baselineCalibrationMs, speed }) {
  const lines = [
    `Micro-benchmark gate (calibration ${fmt(calibrationMs)} ms vs baseline ${fmt(baselineCalibrationMs)} ms, machine factor ${speed.toFixed(2)})`,
    "",
    "| Metric | Baseline | Current | Normalized | Limit | Status |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    const status = { ok: "ok", fail: "REGRESSION", info: "info only", missing: "no baseline" }[row.status];
    lines.push(
      `| ${row.label} | ${fmt(row.baseline)} | ${fmt(row.current)} | ${fmt(row.normalized)} | ${row.limit === null ? "-" : `${row.kind === "ratio" ? "<= " : ""}${fmt(row.limit)}`} | ${status} |`,
    );
  }
  return lines.join("\n");
}

function writeStepSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const calibrationBefore = calibrate();
  const metrics = measure(options.repeat);
  // Calibrate on both sides of the benchmarks so a load spike during one of
  // them does not skew the machine factor.
  const calibrationMs = Number(median([calibrationBefore, calibrate()]).toFixed(3));
  const baselineCalibrationMs = baseline.calibrationMs ?? calibrationMs;
  const speed = calibrationMs / baselineCalibrationMs;

  if (options.update) {
    baseline.calibrationMs = calibrationMs;
    baseline.metrics = metrics;
    baseline.updated = new Date().toISOString().slice(0, 10);
    baseline.node = process.version;
    writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`updated ${path.relative(repoRoot, BASELINE_FILE)}`);
  }
  const rows = compare(metrics, baseline, options.update ? 1 : speed);
  const table = renderTable(rows, { calibrationMs, baselineCalibrationMs, speed });
  console.log(table);
  if (options.json) writeFileSync(options.json, `${JSON.stringify({ calibrationMs, metrics, rows }, null, 2)}\n`);

  const failing = rows.filter((row) => row.status === "fail" || row.status === "missing");
  if (failing.length > 0) {
    const message = [
      "",
      "Micro-benchmark regression:",
      ...failing.map((row) =>
        row.status === "missing"
          ? `- ${row.label}: no baseline (run with --update)`
          : `- ${row.label}: ${fmt(row.normalized ?? row.current)} exceeds ${fmt(row.limit)}`,
      ),
      "",
      "Re-run locally with `pnpm check:perf-micro` and profile the benchmark named above",
      "(crates/agent-gui/perf). If the slowdown is intended, update the baseline with",
      "`pnpm check:perf-micro --update` and explain why in the commit.",
    ].join("\n");
    writeStepSummary(`${table}\n${message}`);
    console.error(message);
    process.exitCode = 1;
    return rows;
  }
  writeStepSummary(table);
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
