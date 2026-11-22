#!/usr/bin/env node
// Source file size limit for crates/ (.ts, .tsx, .rs, .go).
//
// A file over the line limit fails the check unless it is listed in
// scripts/budgets/file-size-allowlist.json, which records each existing
// offender with its line count when it was listed. Listed files must not
// grow, and the list only ever shrinks: when a listed file gets shorter (or
// drops under the limit, or is deleted) the check asks for `--update`, which
// lowers the recorded counts and removes entries that no longer apply. It
// never adds an entry or raises a count; that is a deliberate manual edit.
//
// Usage:
//   node scripts/check-file-size.mjs [--update]

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWLIST_FILE = path.join(repoRoot, "scripts/budgets/file-size-allowlist.json");

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".rs", ".go"]);

// Generated code is exempt: its size follows its source (protos, catalogs).
export const GENERATED_PATTERNS = [
  /\.pb\.go$/,
  /\/proto\/gen\//,
  /\.generated\.tsx?$/,
  /\.d\.ts$/,
];

export function isCheckedSource(file) {
  if (!file.startsWith("crates/")) return false;
  if (!SOURCE_EXTENSIONS.has(path.extname(file))) return false;
  return !GENERATED_PATTERNS.some((pattern) => pattern.test(file));
}

export function countLines(content) {
  if (content.length === 0) return 0;
  let lines = 0;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return content.endsWith("\n") ? lines : lines + 1;
}

function trackedSources() {
  const result = spawnSync("git", ["ls-files", "-z", "--", "crates"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return result.stdout.split("\0").filter(Boolean).filter(isCheckedSource);
}

/**
 * `sizes`: { path: lines } for every checked file. Returns the violations
 * (fail the check) and the stale allowlist entries (fail too, fixed by
 * `--update`), plus the tightened allowlist `--update` would write.
 */
export function evaluate(sizes, allowlist) {
  const limit = allowlist.limit;
  const allowed = allowlist.files ?? {};
  const violations = [];
  const stale = [];
  const tightened = {};
  for (const [file, lines] of Object.entries(sizes)) {
    if (lines <= limit) continue;
    const recorded = allowed[file];
    if (recorded === undefined) {
      violations.push({ file, lines, kind: "over-limit" });
    } else if (lines > recorded) {
      violations.push({ file, lines, recorded, kind: "grew" });
    }
  }
  for (const [file, recorded] of Object.entries(allowed)) {
    const lines = sizes[file];
    if (lines === undefined) {
      stale.push({ file, recorded, kind: "missing" });
    } else if (lines <= limit) {
      stale.push({ file, recorded, lines, kind: "under-limit" });
    } else {
      if (lines < recorded) stale.push({ file, recorded, lines, kind: "shrank" });
      tightened[file] = Math.min(lines, recorded);
    }
  }
  return { violations, stale, tightened };
}

function sortedObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

export function formatReport({ violations, stale }, limit) {
  const lines = [];
  if (violations.length > 0) {
    lines.push(`Source files over the ${limit}-line limit:`);
    for (const violation of violations) {
      lines.push(
        violation.kind === "grew"
          ? `  - ${violation.file}: ${violation.lines} lines, grew from ${violation.recorded} (allowlisted files must not grow)`
          : `  - ${violation.file}: ${violation.lines} lines (limit ${limit})`,
      );
    }
    lines.push(
      "",
      "Split the file into focused modules (move helpers, subcomponents, or tests into",
      "their own files) so it stays under the limit. Files already over the limit are",
      "listed in scripts/budgets/file-size-allowlist.json and may only shrink.",
    );
  }
  if (stale.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("The file size allowlist is out of date (a listed file got smaller):");
    for (const entry of stale) {
      const now = entry.kind === "missing" ? "deleted" : `${entry.lines} lines`;
      lines.push(`  - ${entry.file}: recorded ${entry.recorded}, now ${now}`);
    }
    lines.push("", "Run `pnpm check:file-size --update` and commit the allowlist to lock in the gain.");
  }
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const update = argv.includes("--update");
  const unknown = argv.filter((arg) => arg !== "--update");
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(" ")}`);
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8"));
  const sizes = {};
  for (const file of trackedSources()) {
    sizes[file] = countLines(readFileSync(path.join(repoRoot, file), "utf8"));
  }
  const result = evaluate(sizes, allowlist);
  const checked = Object.keys(sizes).length;
  if (update) {
    allowlist.files = sortedObject(result.tightened);
    writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(allowlist, null, 2)}\n`);
    console.log(
      `file size allowlist: ${Object.keys(allowlist.files).length} entries (removed or lowered ${result.stale.length})`,
    );
    result.stale = [];
  }
  const report = formatReport(result, allowlist.limit);
  const failed = result.violations.length > 0 || result.stale.length > 0;
  if (failed) {
    console.error(report);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### File size limit\n\n\`\`\`\n${report}\n\`\`\`\n\n`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `file size: ${checked} source files checked, none over ${allowlist.limit} lines except ${Object.keys(allowlist.files).length} allowlisted (none grew)`,
    );
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
