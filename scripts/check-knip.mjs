#!/usr/bin/env node
// Unused files, exports, types and dependencies across the pnpm workspace,
// found by knip (configured in knip.config.ts).
//
// The workspace had findings when the check was introduced; those are
// recorded in scripts/budgets/knip-baseline.json and tolerated. The check
// fails only on findings that are not in the baseline, so new dead code is
// caught without first cleaning up every old export. Baseline entries that no
// longer show up are reported; `--update` rewrites the baseline from the
// current findings (commit that deliberately, see docs/testing/ci-checks.md).
//
// Usage:
//   node scripts/check-knip.mjs [--update] [--report knip.json]
// `--report` reads an existing `knip --reporter json` output instead of
// running knip (used by the tests).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_FILE = path.join(repoRoot, "scripts/budgets/knip-baseline.json");

// knip issue types this check gates, in report order.
export const ISSUE_TYPES = [
  "files",
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "unlisted",
  "binaries",
  "unresolved",
  "exports",
  "nsExports",
  "types",
  "nsTypes",
  "enumMembers",
  "namespaceMembers",
  "duplicates",
  "catalog",
];

function parseArguments(argv) {
  const options = { update: false, report: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--update") options.update = true;
    else if (flag === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report needs a file");
      options.report = path.resolve(value);
      index += 1;
    } else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

function itemName(item) {
  // Duplicate exports come as a list of aliases for the same value.
  if (Array.isArray(item)) return item.map((entry) => entry.name).sort().join("|");
  return item.name;
}

/**
 * Flattens a knip JSON report into stable keys, `type -> ["file#name", ...]`.
 * Line numbers are left out so unrelated edits do not churn the baseline.
 */
export function collectFindings(report) {
  const findings = Object.fromEntries(ISSUE_TYPES.map((type) => [type, new Set()]));
  for (const issue of report.issues ?? []) {
    for (const type of ISSUE_TYPES) {
      const items = issue[type];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        findings[type].add(type === "files" ? issue.file : `${issue.file}#${itemName(item)}`);
      }
    }
  }
  // Older report shape: unused files as a top-level list.
  for (const file of report.files ?? []) findings.files.add(typeof file === "string" ? file : file.name);
  return Object.fromEntries(
    Object.entries(findings)
      .filter(([, keys]) => keys.size > 0)
      .map(([type, keys]) => [type, [...keys].sort()]),
  );
}

/** New findings (fail) and baseline entries that are gone (informational). */
export function diffFindings(findings, baseline) {
  const added = [];
  const resolved = [];
  for (const type of ISSUE_TYPES) {
    const current = new Set(findings[type] ?? []);
    const known = new Set(baseline[type] ?? []);
    for (const key of current) if (!known.has(key)) added.push({ type, key });
    for (const key of known) if (!current.has(key)) resolved.push({ type, key });
  }
  return { added, resolved };
}

export function countFindings(findings) {
  return Object.fromEntries(Object.entries(findings).map(([type, keys]) => [type, keys.length]));
}

function runKnip() {
  const binary = path.join(repoRoot, "node_modules/.bin/knip");
  if (!existsSync(binary)) throw new Error("knip is not installed; run pnpm install");
  const result = spawnSync(binary, ["--reporter", "json", "--no-progress"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // knip exits 1 when it finds anything; only a missing report is an error.
  const start = result.stdout.indexOf("{");
  if (start === -1) {
    throw new Error(`knip produced no report (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.slice(start));
}

function describe(entry) {
  return `  - ${entry.type}: ${entry.key.replace("#", " -> ")}`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = options.report ? JSON.parse(readFileSync(options.report, "utf8")) : runKnip();
  const findings = collectFindings(report);
  const baselineFile = existsSync(BASELINE_FILE)
    ? JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
    : { issues: {} };
  const counts = countFindings(findings);
  const summary = Object.entries(counts)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");

  if (options.update) {
    baselineFile.updated = new Date().toISOString().slice(0, 10);
    baselineFile.counts = counts;
    baselineFile.issues = findings;
    writeFileSync(BASELINE_FILE, `${JSON.stringify(baselineFile, null, 2)}\n`);
    console.log(`updated ${path.relative(repoRoot, BASELINE_FILE)} (${summary || "no findings"})`);
    return { findings, added: [], resolved: [] };
  }

  const { added, resolved } = diffFindings(findings, baselineFile.issues ?? {});
  if (resolved.length > 0) {
    console.log(
      [
        `${resolved.length} baselined knip finding(s) no longer reported; run`,
        "`pnpm check:knip --update` to drop them from the baseline:",
        ...resolved.slice(0, 20).map(describe),
        ...(resolved.length > 20 ? [`  ... and ${resolved.length - 20} more`] : []),
      ].join("\n"),
    );
  }
  if (added.length > 0) {
    const message = [
      "New knip findings (not in scripts/budgets/knip-baseline.json):",
      ...added.map(describe),
      "",
      "Delete the unused file/export/dependency, or stop exporting what is only used",
      "locally. If knip is wrong (the code is loaded dynamically, by a test through a",
      "path string, or by Tauri/the e2e harness), teach knip.config.ts about that entry",
      "point. Run `pnpm check:knip` locally to reproduce.",
    ].join("\n");
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### knip\n\n\`\`\`\n${message}\n\`\`\`\n\n`);
    }
    process.exitCode = 1;
  } else {
    console.log(`knip: no new findings (baselined: ${summary || "none"})`);
  }
  return { findings, added, resolved };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
