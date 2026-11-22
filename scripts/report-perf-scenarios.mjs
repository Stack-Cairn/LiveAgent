#!/usr/bin/env node
// Report-only summary of the browser transcript scenarios
// (crates/agent-gui/perf/run.mjs --out=results.json).
//
// Browser timings on shared runners are too noisy to gate on, so this never
// fails: it renders the results as markdown, next to the last results from
// main when CI restored them, and flags large changes for a human to look at.
//
// Usage:
//   node scripts/report-perf-scenarios.mjs --current results.json
//     [--baseline main-results.json] [--title "..."]
// The markdown goes to stdout and, on GitHub Actions, to the job summary.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The numbers worth reading first, per scenario; everything else is in the
// collapsed full table. Lower is better for all of them.
export const HEADLINE = {
  stream: ["taskMs", "scriptMs", "commitsPerFrame"],
  find: ["coldMs", "taskMs", "longTaskMax"],
  scroll: ["taskMs", "frameP95"],
  editdiff: ["mountMs", "domNodes20k", "streamSyncMsPerTick"],
  gitdiff: ["peakNodes", "stepP95"],
  projection: ["projectionMs", "reprojectionMs", "taskMs"],
};

// A change worth a look (not a failure): at least this much slower and more
// than the absolute noise floor.
export const FLAG_RATIO = 0.25;
const FLAG_FLOOR = 5;

const IDENTITY_KEYS = new Set(["scenario", "throttle", "run"]);

function parseArguments(argv) {
  const options = { current: "", baseline: "", title: "Transcript performance scenarios (report only)" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--current", "--baseline", "--title"].includes(flag)) throw new Error(`unknown option: ${flag}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.current) throw new Error("--current is required");
  return options;
}

function readResults(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Median per (scenario, throttle, metric) across repeated runs. */
export function aggregate(rows) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const id = `${row.scenario}@${row.throttle}`;
    if (!grouped.has(id)) grouped.set(id, { scenario: row.scenario, throttle: row.throttle, values: {} });
    const entry = grouped.get(id);
    for (const [key, value] of Object.entries(row)) {
      if (IDENTITY_KEYS.has(key) || typeof value !== "number") continue;
      entry.values[key] ??= [];
      entry.values[key].push(value);
    }
  }
  for (const entry of grouped.values()) {
    for (const [key, values] of Object.entries(entry.values)) {
      const sorted = [...values].sort((a, b) => a - b);
      entry.values[key] = sorted[Math.floor(sorted.length / 2)];
    }
  }
  return grouped;
}

export function change(current, baseline) {
  if (typeof baseline !== "number" || typeof current !== "number") return { text: "-", flagged: false };
  if (baseline === 0) return { text: current === 0 ? "0%" : "new", flagged: current > FLAG_FLOOR };
  const ratio = (current - baseline) / baseline;
  const flagged = ratio > FLAG_RATIO && current - baseline > FLAG_FLOOR;
  const percent = Math.round(ratio * 100);
  return { text: percent === 0 ? "0%" : `${percent > 0 ? "+" : ""}${percent}%`, flagged };
}

function fmt(value) {
  if (typeof value !== "number") return "-";
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(Number(value.toFixed(2)));
}

export function renderReport(currentRows, baselineRows, title) {
  const current = aggregate(currentRows);
  const baseline = baselineRows ? aggregate(baselineRows) : null;
  const lines = [`### ${title}`, ""];
  lines.push(
    baseline
      ? "Compared with the latest results from main on the same runner type. Browser timings are noisy; differences flagged with :warning: are worth a second run, not proof of a regression."
      : "No results from main to compare with yet; showing this run only.",
    "",
  );
  const table = (metricsFor) => {
    const out = ["| Scenario | CPU | Metric | main | This run | Change |", "| --- | ---: | --- | ---: | ---: | ---: |"];
    let flagged = 0;
    for (const [id, entry] of current) {
      const base = baseline?.get(id)?.values ?? {};
      for (const key of metricsFor(entry)) {
        if (!(key in entry.values)) continue;
        const delta = change(entry.values[key], base[key]);
        if (delta.flagged) flagged += 1;
        out.push(
          `| ${entry.scenario} | ${entry.throttle}x | ${key} | ${fmt(base[key])} | ${fmt(entry.values[key])} | ${delta.text}${delta.flagged ? " :warning:" : ""} |`,
        );
      }
    }
    return { out, flagged };
  };
  const headline = table((entry) => HEADLINE[entry.scenario] ?? Object.keys(entry.values).slice(0, 3));
  lines.push(...headline.out, "");
  const full = table((entry) => Object.keys(entry.values));
  lines.push("<details><summary>All metrics</summary>", "", ...full.out, "", "</details>", "");
  if (currentRows.length === 0) lines.push("The scenario run produced no results.");
  return { markdown: lines.join("\n"), flagged: full.flagged };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const currentRows = readResults(options.current);
  let markdown;
  if (!currentRows) {
    markdown = `### ${options.title}\n\nNo results at ${options.current}; the scenario run failed before writing them (see the step log).\n`;
  } else {
    const report = renderReport(currentRows, readResults(options.baseline), options.title);
    markdown = report.markdown;
    if (report.flagged > 0) console.warn(`${report.flagged} metric(s) look slower than main (report only)`);
  }
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    // Report only: a broken report must not fail the job.
    console.error(error instanceof Error ? error.message : error);
  }
}
