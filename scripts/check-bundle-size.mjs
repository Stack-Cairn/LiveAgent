#!/usr/bin/env node
// Bundle size budget for the desktop (crates/agent-gui) and Gateway WebUI
// (crates/agent-gateway/web) production builds.
//
// Measures, per app:
//   - startup JS: the entry chunk(s) from dist/index.html plus every chunk
//     they import statically (transitively), raw and gzip — what the browser
//     has to fetch, parse and evaluate before the first render;
//   - startup CSS: the stylesheets index.html links, raw and gzip;
//   - total JS and total dist size (every emitted file).
// and compares them with scripts/budgets/bundle-size.json. A metric fails
// when it exceeds its budget by more than the tolerance. The table goes to
// stdout and, on GitHub Actions, to the job summary.
//
// Usage:
//   node scripts/check-bundle-size.mjs [--app gui|webui|all] [--dist DIR]
//     [--update] [--json out.json]
// Build first (`pnpm build:gui`, `pnpm build:webui`). `--update` rewrites the
// budget entries of the measured apps with the current sizes; commit that
// change deliberately (see docs/testing/ci-checks.md).

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUDGET_FILE = path.join(repoRoot, "scripts/budgets/bundle-size.json");

export const APP_DISTS = {
  gui: "crates/agent-gui/dist",
  webui: "crates/agent-gateway/web/dist",
};

// [key, label, gated]. Informational metrics are reported but never fail.
export const METRICS = [
  ["startupJsGzip", "Startup JS (gzip)", true],
  ["startupJsRaw", "Startup JS (raw)", true],
  ["startupJsFiles", "Startup JS files", false],
  ["startupCssGzip", "Startup CSS (gzip)", true],
  ["totalJsRaw", "Total JS (raw)", false],
  ["totalDistRaw", "Total dist (raw)", true],
];

function parseArguments(argv) {
  const options = { apps: ["gui", "webui"], dist: "", update: false, json: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return value;
    };
    if (flag === "--app") {
      const app = take();
      options.apps = app === "all" ? ["gui", "webui"] : [app];
    } else if (flag === "--dist") options.dist = path.resolve(take());
    else if (flag === "--update") options.update = true;
    else if (flag === "--json") options.json = path.resolve(take());
    else throw new Error(`unknown option: ${flag}`);
  }
  for (const app of options.apps) {
    if (!APP_DISTS[app]) throw new Error(`unknown app: ${app} (expected gui, webui or all)`);
  }
  if (options.dist && options.apps.length !== 1) throw new Error("--dist needs a single --app");
  return options;
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** `src`/`href` attributes of the module scripts and stylesheets in index.html. */
export function readIndexAssets(html) {
  const scripts = [];
  const styles = [];
  for (const match of html.matchAll(/<script\b[^>]*>/g)) {
    const tag = match[0];
    if (!/type=["']module["']/.test(tag)) continue;
    const src = tag.match(/\bsrc=["']([^"']+)["']/)?.[1];
    if (src) scripts.push(src);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = match[0];
    if (!/rel=["']stylesheet["']/.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/)?.[1];
    if (href) styles.push(href);
  }
  return { scripts, styles };
}

// Static ESM specifiers in an emitted chunk: `import"./a.js"`,
// `import{x}from"./a.js"`, `export*from"./a.js"`. Dynamic `import("./a.js")`
// has a parenthesis between `import` and the quote, so it never matches.
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']([^"'\s]+\.m?js)["']/g;

export function staticImports(code) {
  return [...code.matchAll(STATIC_IMPORT)].map((match) => match[1]);
}

function resolveAsset(dist, fromFile, specifier) {
  if (/^[a-z]+:/i.test(specifier) || specifier.startsWith("//")) return null;
  const resolved = specifier.startsWith("/")
    ? path.join(dist, specifier)
    : path.resolve(path.dirname(fromFile), specifier);
  return resolved.startsWith(dist) && existsSync(resolved) ? resolved : null;
}

/** Entry chunks plus everything they import statically, transitively. */
export function collectStartupJs(dist, entries) {
  const seen = new Set();
  const queue = entries
    .map((entry) => resolveAsset(dist, path.join(dist, "index.html"), entry))
    .filter(Boolean);
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      const dependency = resolveAsset(dist, file, specifier);
      if (dependency && !seen.has(dependency)) queue.push(dependency);
    }
  }
  return [...seen].sort();
}

function sizes(files) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const content = readFileSync(file);
    raw += content.length;
    gzip += gzipSync(content, { level: 9 }).length;
  }
  return { raw, gzip };
}

export function measureDist(dist) {
  const indexFile = path.join(dist, "index.html");
  if (!existsSync(indexFile)) throw new Error(`no index.html in ${dist}; build the app first`);
  const { scripts, styles } = readIndexAssets(readFileSync(indexFile, "utf8"));
  if (scripts.length === 0) throw new Error(`${indexFile} has no module entry script`);
  const startupJs = collectStartupJs(dist, scripts);
  const startupCss = styles.map((href) => resolveAsset(dist, indexFile, href)).filter(Boolean);
  const all = walkFiles(dist);
  const js = sizes(startupJs);
  const css = sizes(startupCss);
  return {
    metrics: {
      startupJsGzip: js.gzip,
      startupJsRaw: js.raw,
      startupJsFiles: startupJs.length,
      startupCssGzip: css.gzip,
      totalJsRaw: all
        .filter((file) => /\.m?js$/.test(file))
        .reduce((sum, file) => sum + statSync(file).size, 0),
      totalDistRaw: all.reduce((sum, file) => sum + statSync(file).size, 0),
    },
    startupFiles: startupJs.map((file) => path.relative(dist, file)),
  };
}

/**
 * One row per metric. `limit` is budget * (1 + tolerance); a metric without
 * a budget is reported as "new" and fails, so a new metric needs `--update`.
 */
export function compareToBudget(metrics, budget, tolerance) {
  return METRICS.map(([key, label, gated]) => {
    const current = metrics[key];
    const expected = budget?.[key];
    if (typeof expected !== "number") {
      const status = gated ? "new" : "info";
      return { key, label, current, budget: null, limit: null, delta: null, status };
    }
    const limit = Math.floor(expected * (1 + tolerance));
    const delta = expected === 0 ? 0 : (current - expected) / expected;
    let status = "ok";
    if (!gated) status = "info";
    else if (current > limit) status = "over";
    else if (current < expected * (1 - tolerance)) status = "under";
    return { key, label, current, budget: expected, limit, delta, status };
  });
}

export function formatValue(key, value) {
  if (value === null || value === undefined) return "-";
  if (key.endsWith("Files")) return String(value);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  return `${(value / 1024).toFixed(1)} kB`;
}

const STATUS_LABEL = {
  ok: "ok",
  under: "ok (under budget, consider --update)",
  over: "OVER BUDGET",
  new: "no budget",
  updated: "budget updated",
  info: "info only",
};

export function renderTable(results, tolerance) {
  const lines = [
    `Bundle size budget (tolerance +${Math.round(tolerance * 100)}%)`,
    "",
    "| App | Metric | Budget | Current | Change | Status |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  ];
  for (const { app, rows } of results) {
    for (const row of rows) {
      const percent = row.delta === null ? null : (row.delta * 100).toFixed(1);
      const change =
        percent === null ? "-" : Number(percent) === 0 ? "0.0%" : `${row.delta > 0 ? "+" : ""}${percent}%`;
      lines.push(
        `| ${app} | ${row.label} | ${formatValue(row.key, row.budget)} | ${formatValue(row.key, row.current)} | ${change} | ${STATUS_LABEL[row.status]} |`,
      );
    }
  }
  return lines.join("\n");
}

function writeStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n\n`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const budgetFile = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
  const tolerance = Number(budgetFile.tolerance ?? 0.03);
  const results = [];
  for (const app of options.apps) {
    const dist = options.dist || path.join(repoRoot, APP_DISTS[app]);
    const { metrics, startupFiles } = measureDist(dist);
    results.push({
      app,
      metrics,
      startupFiles,
      rows: compareToBudget(metrics, budgetFile.apps?.[app], tolerance),
    });
  }

  if (options.update) {
    budgetFile.apps ??= {};
    budgetFile.updated = new Date().toISOString().slice(0, 10);
    for (const result of results) {
      budgetFile.apps[result.app] = result.metrics;
      for (const row of result.rows) row.status = "updated";
    }
    writeFileSync(BUDGET_FILE, `${JSON.stringify(budgetFile, null, 2)}\n`);
    console.log(`updated ${path.relative(repoRoot, BUDGET_FILE)} for ${options.apps.join(", ")}`);
  }

  const table = renderTable(results, tolerance);
  console.log(table);
  if (options.json) writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`);

  const failing = options.update
    ? []
    : results.flatMap(({ app, rows }) =>
        rows.filter((row) => row.status === "over" || row.status === "new").map((row) => ({ app, row })),
      );
  if (failing.length > 0) {
    const detail = failing
      .map(({ app, row }) =>
        row.status === "new"
          ? `- ${app} ${row.label}: no budget recorded`
          : `- ${app} ${row.label}: ${formatValue(row.key, row.current)} > limit ${formatValue(row.key, row.limit)}`,
      )
      .join("\n");
    const message = [
      "",
      "Bundle size budget exceeded:",
      detail,
      "",
      "Keep startup code lazy (dynamic import) where you can. If the growth is intended,",
      "run `pnpm check:bundle-size --update` after a production build and commit",
      "scripts/budgets/bundle-size.json with a note on why the bundle grew.",
    ].join("\n");
    writeStepSummary(`${table}\n${message}`);
    console.error(message);
    process.exitCode = 1;
    return results;
  }
  writeStepSummary(table);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
