#!/usr/bin/env node
// Design token guardrail for the shared UI, the desktop frontend and the
// WebUI (`src/` of crates/agent-ui, crates/agent-gui, crates/agent-gateway/web).
//
// Colors, radii, shadows, z-index layers and font sizes come from the theme
// tokens in crates/agent-ui/src/styles/tokens.css (mapped to Tailwind in
// semantic-colors.css). This check counts the styles that bypass them:
//
//   color-literal   hex / rgb() / hsl() / oklch() literals in code or CSS
//   palette-color   raw Tailwind palette utilities (`text-amber-700`,
//                   `bg-emerald-500/10`, `bg-black/40`) instead of a role
//                   (`text-warning`, `bg-success/10`, `bg-overlay`)
//   arbitrary-color arbitrary color values (`bg-[#2168d5]`,
//                   `text-[hsl(var(--chat-error))]`)
//   arbitrary-size  arbitrary font size, weight, leading, tracking, radius,
//                   shadow, z-index and spacing values (`text-[11px]`,
//                   `rounded-[10px]`, `shadow-[...]`, `z-[60]`, `gap-[3px]`)
//
// Files that existed with such styles are listed per rule in
// scripts/budgets/design-token-baseline.json. A listed count must not grow
// and the baseline only ever shrinks: when a file gets cleaner the check asks
// for `--update`, which lowers the recorded counts and removes entries that
// reached zero. It never adds an entry or raises a count.
//
// Usage:
//   node scripts/check-design-tokens.mjs [--update] [--report]

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_FILE = path.join(repoRoot, "scripts/budgets/design-token-baseline.json");

export const SOURCE_ROOTS = ["crates/agent-ui/src/", "crates/agent-gui/src/", "crates/agent-gateway/web/src/"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

// Files that define colors on purpose: the token files themselves and the
// brand marks, which must keep their vendor colors.
export const EXEMPT_FILES = new Set([
  "crates/agent-ui/src/styles/tokens.css",
  "crates/agent-ui/src/styles/semantic-colors.css",
  "crates/agent-ui/src/components/IconSet.tsx",
]);

export const RULES = ["color-literal", "palette-color", "arbitrary-color", "arbitrary-size"];

export function isCheckedSource(file) {
  if (!SOURCE_ROOTS.some((root) => file.startsWith(root))) return false;
  if (!SOURCE_EXTENSIONS.has(path.extname(file))) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /\/__tests__\//.test(file)) return false;
  if (/\.d\.ts$/.test(file) || /\.generated\./.test(file)) return false;
  return !EXEMPT_FILES.has(file);
}

/**
 * Blanks out comments while keeping string contents and line breaks, so issue
 * references such as `#359` in comments are not read as colors.
 */
export function stripComments(source) {
  let out = "";
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }
    // Line comments: `//` not preceded by `:` (URLs inside CSS values).
    if (char === "/" && next === "/" && source[index - 1] !== ":") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const PALETTE_HUES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_UTILITIES =
  "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|decoration|caret|accent|placeholder|shadow";

const PATTERNS = {
  "color-literal": [
    /(?<![\w&$-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
    /(?<![\w-])(?:rgba?|hsla?|oklch|oklab)\(\s*[\d.]/g,
  ],
  "palette-color": [
    new RegExp(
      `(?<![\\w-])(?:${COLOR_UTILITIES})-(?:(?:${PALETTE_HUES})-(?:50|[1-9]00|950)|black|white)(?:/(?:\\d+|\\[[^\\]\\s]+\\]))?(?![\\w-])`,
      "g",
    ),
  ],
  "arbitrary-color": [
    new RegExp(`(?<![\\w-])(?:${COLOR_UTILITIES})-\\[(?:color:)?(?:#|rgba?\\(|hsla?\\(|oklch\\(|var\\()`, "g"),
  ],
  "arbitrary-size": [
    /(?<![\w-])-?(?:text|font|leading|tracking|rounded(?:-[trblse]{1,2})?|shadow|z|p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\[(?!(?:color:)?(?:#|rgba?\(|hsla?\(|oklch\(|var\())[^\]\s]+\]/g,
  ],
};

/** Returns { rule: [{ line, match }] } for one file's content. */
export function scanSource(content) {
  const text = stripComments(content);
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const findings = {};
  for (const [rule, patterns] of Object.entries(PATTERNS)) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        (findings[rule] ??= []).push({ line: lineOf(match.index), match: match[0] });
      }
    }
  }
  return findings;
}

export function countFindings(findings) {
  const counts = {};
  for (const [rule, list] of Object.entries(findings)) {
    if (list.length > 0) counts[rule] = list.length;
  }
  return counts;
}

function trackedSources() {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...SOURCE_ROOTS], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return result.stdout.split("\0").filter(Boolean).filter(isCheckedSource);
}

/**
 * `counts`: { file: { rule: n } } for every checked file with findings.
 * Returns violations (new or grown counts), stale baseline entries (a count
 * went down or a file is gone) and the tightened baseline `--update` writes.
 */
export function evaluate(counts, baseline) {
  const allowed = baseline.files ?? {};
  const violations = [];
  const stale = [];
  const tightened = {};
  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, count] of Object.entries(rules)) {
      const recorded = allowed[file]?.[rule] ?? 0;
      if (count > recorded) violations.push({ file, rule, count, recorded });
    }
  }
  for (const [file, rules] of Object.entries(allowed)) {
    for (const [rule, recorded] of Object.entries(rules)) {
      const count = counts[file]?.[rule] ?? 0;
      if (count < recorded) stale.push({ file, rule, count, recorded });
      const kept = Math.min(count, recorded);
      if (kept > 0) (tightened[file] ??= {})[rule] = kept;
    }
  }
  return { violations, stale, tightened };
}

export function totals(counts) {
  const byRule = Object.fromEntries(RULES.map((rule) => [rule, 0]));
  let files = 0;
  for (const rules of Object.values(counts)) {
    if (Object.keys(rules).length > 0) files += 1;
    for (const [rule, count] of Object.entries(rules)) byRule[rule] = (byRule[rule] ?? 0) + count;
  }
  return { byRule, files };
}

export function formatReport({ violations, stale }, details = {}) {
  const lines = [];
  if (violations.length > 0) {
    lines.push("New hard-coded styles that bypass the design tokens:");
    for (const violation of violations) {
      const where = (details[violation.file]?.[violation.rule] ?? [])
        .slice(0, 6)
        .map((finding) => `${finding.line}:${finding.match}`)
        .join(", ");
      lines.push(
        `  - ${violation.file} [${violation.rule}] ${violation.count} (baseline ${violation.recorded})${where ? `  ${where}` : ""}`,
      );
    }
    lines.push(
      "",
      "Use the semantic tokens and shared primitives instead (docs/design-system.md):",
      "status colors -> text-success / text-warning / text-info / text-destructive",
      "(tints with opacity: bg-warning/10 border-warning/25), overlays -> bg-overlay,",
      "font sizes -> text-tiny..text-5xl, radii -> rounded-sm..rounded-4xl, layers -> layer-*.",
      "Existing offenders are listed in scripts/budgets/design-token-baseline.json and may only shrink.",
    );
  }
  if (stale.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("The design token baseline is out of date (a listed file got cleaner):");
    for (const entry of stale) {
      lines.push(`  - ${entry.file} [${entry.rule}]: recorded ${entry.recorded}, now ${entry.count}`);
    }
    lines.push("", "Run `pnpm check:design-tokens --update` and commit the baseline to lock in the gain.");
  }
  return lines.join("\n");
}

function sortedObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

export function scanRepo() {
  const counts = {};
  const details = {};
  const files = trackedSources();
  for (const file of files) {
    const findings = scanSource(readFileSync(path.join(repoRoot, file), "utf8"));
    const fileCounts = countFindings(findings);
    if (Object.keys(fileCounts).length > 0) {
      counts[file] = fileCounts;
      details[file] = findings;
    }
  }
  return { counts, details, checked: files.length };
}

export function main(argv = process.argv.slice(2)) {
  const update = argv.includes("--update");
  const report = argv.includes("--report");
  const unknown = argv.filter((arg) => arg !== "--update" && arg !== "--report");
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(" ")}`);
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const { counts, details, checked } = scanRepo();
  if (report) {
    const { byRule, files } = totals(counts);
    console.log(JSON.stringify({ checked, files, byRule }, null, 2));
  }
  const result = evaluate(counts, baseline);
  if (update) {
    baseline.files = sortedObject(result.tightened);
    writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `design token baseline: ${Object.keys(baseline.files).length} files (lowered or removed ${result.stale.length} entries)`,
    );
    result.stale = [];
  }
  const text = formatReport(result, details);
  if (result.violations.length > 0 || result.stale.length > 0) {
    console.error(text);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Design tokens\n\n\`\`\`\n${text}\n\`\`\`\n\n`);
    }
    process.exitCode = 1;
  } else {
    const { byRule } = totals(counts);
    const summary = RULES.map((rule) => `${rule} ${byRule[rule]}`).join(", ");
    console.log(`design tokens: ${checked} files checked, no new hard-coded styles (baseline: ${summary})`);
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
