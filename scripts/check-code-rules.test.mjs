// Unit tests for the CI code-rule and budget checks (bundle size, file size,
// design token baseline, knip baseline and loader compiler, micro-benchmark gate). The checks themselves run in CI; these
// cover the comparison logic with fixtures so it can change safely.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectStartupJs,
  compareToBudget,
  measureDist,
  readIndexAssets,
  staticImports,
} from "./check-bundle-size.mjs";
import {
  evaluate as evaluateDesignTokens,
  formatReport as formatDesignTokenReport,
  isCheckedSource as isDesignTokenSource,
  scanSource,
  stripComments,
} from "./check-design-tokens.mjs";
import { countLines, evaluate, formatReport, isCheckedSource } from "./check-file-size.mjs";
import { collectFindings, diffFindings } from "./check-knip.mjs";
import { appendLoaderImports, loaderCalls } from "./knip-loader-imports.mjs";
import { compare as comparePerf, median } from "./check-perf-micro.mjs";
import { aggregate, change, renderReport } from "./report-perf-scenarios.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

function tempDir(t) {
  // Keep fixtures next to the scripts' own temp space when TMPDIR is set
  // (CI and agent sandboxes point it at a scratch directory).
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "code-rules-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("bundle size: index assets and static imports", () => {
  const html = `<script type="module" crossorigin src="/assets/index-a.js"></script>
    <link rel="modulepreload" href="/assets/vendor-b.js">
    <link rel="stylesheet" crossorigin href="/assets/index-c.css">
    <script src="/legacy.js"></script>`;
  assert.deepEqual(readIndexAssets(html), {
    scripts: ["/assets/index-a.js"],
    styles: ["/assets/index-c.css"],
  });
  const code = `import{a as b}from"./vendor-b.js";import"./side.js";export*from './re.js';
    const lazy=()=>import("./lazy.js");const s="import ./not-a-spec.js";`;
  assert.deepEqual(staticImports(code), ["./vendor-b.js", "./side.js", "./re.js"]);
});

test("bundle size: startup set follows static imports only", (t) => {
  const dist = tempDir(t);
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(
    path.join(dist, "index.html"),
    '<script type="module" src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/app.css">',
  );
  writeFileSync(path.join(dist, "assets/entry.js"), 'import"./shared.js";const l=()=>import("./lazy.js");');
  writeFileSync(path.join(dist, "assets/shared.js"), 'import"./entry.js";export const x=1;');
  writeFileSync(path.join(dist, "assets/lazy.js"), "export const big='x'.repeat(10);");
  writeFileSync(path.join(dist, "assets/app.css"), "body{color:red}");

  const startup = collectStartupJs(dist, ["/assets/entry.js"]).map((file) => path.basename(file));
  assert.deepEqual(startup, ["entry.js", "shared.js"], "dynamic imports and cycles are handled");
  const { metrics } = measureDist(dist);
  assert.equal(metrics.startupJsFiles, 2);
  assert.ok(metrics.startupJsGzip > 0 && metrics.startupCssGzip > 0);
  assert.ok(metrics.totalJsRaw > metrics.startupJsRaw, "lazy chunk counts toward total only");
});

test("bundle size: budget comparison with tolerance", () => {
  const budget = { startupJsGzip: 1000, startupJsRaw: 4000, startupJsFiles: 5, startupCssGzip: 100, totalJsRaw: 9000, totalDistRaw: 10_000 };
  const status = (metrics) =>
    Object.fromEntries(compareToBudget({ ...budget, ...metrics }, budget, 0.03).map((row) => [row.key, row.status]));
  assert.equal(status({}).startupJsGzip, "ok");
  assert.equal(status({ startupJsGzip: 1030 }).startupJsGzip, "ok", "within tolerance");
  assert.equal(status({ startupJsGzip: 1031 }).startupJsGzip, "over");
  assert.equal(status({ startupJsGzip: 900 }).startupJsGzip, "under");
  assert.equal(status({ startupJsFiles: 50, totalJsRaw: 1e9 }).startupJsFiles, "info", "informational metrics never fail");
  const rows = compareToBudget(budget, { ...budget, totalDistRaw: undefined }, 0.03);
  assert.equal(rows.find((row) => row.key === "totalDistRaw").status, "new");
});

test("file size: checked sources and line counting", () => {
  assert.equal(isCheckedSource("crates/agent-gui/src/a.tsx"), true);
  assert.equal(isCheckedSource("crates/agent-gateway/internal/x.go"), true);
  assert.equal(isCheckedSource("crates/agent-gateway/internal/x.pb.go"), false);
  assert.equal(isCheckedSource("crates/agent-gui/src/env.d.ts"), false);
  assert.equal(isCheckedSource("crates/agent-gui/test/a.test.mjs"), false);
  assert.equal(isCheckedSource("scripts/big.ts"), false);
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
});

test("file size: allowlisted files may only shrink", () => {
  const allowlist = { limit: 10, files: { "big.ts": 20, "shrunk.ts": 30, "fixed.ts": 15, "gone.ts": 12 } };
  const sizes = { "big.ts": 21, "shrunk.ts": 25, "fixed.ts": 9, "new.ts": 11, "small.ts": 10 };
  const result = evaluate(sizes, allowlist);
  assert.deepEqual(
    result.violations.map((entry) => [entry.file, entry.kind]),
    [
      ["big.ts", "grew"],
      ["new.ts", "over-limit"],
    ],
  );
  assert.deepEqual(
    result.stale.map((entry) => [entry.file, entry.kind]).sort(),
    [
      ["fixed.ts", "under-limit"],
      ["gone.ts", "missing"],
      ["shrunk.ts", "shrank"],
    ],
  );
  assert.deepEqual(result.tightened, { "big.ts": 20, "shrunk.ts": 25 }, "--update never raises a count");
  const report = formatReport(result, 10);
  assert.match(report, /big\.ts: 21 lines, grew from 20/);
  assert.match(report, /new\.ts: 11 lines \(limit 10\)/);
  assert.match(report, /pnpm check:file-size --update/);
});

test("knip: findings are keyed without line numbers and only new ones fail", () => {
  const report = {
    issues: [
      {
        file: "a.ts",
        files: [{ name: "a.ts" }],
        exports: [],
      },
      {
        file: "b.ts",
        exports: [{ name: "unused", line: 3 }],
        duplicates: [[{ name: "Y" }, { name: "X" }]],
      },
      { file: "package.json", dependencies: [{ name: "left-pad", line: 9 }] },
    ],
  };
  const findings = collectFindings(report);
  assert.deepEqual(findings, {
    files: ["a.ts"],
    dependencies: ["package.json#left-pad"],
    exports: ["b.ts#unused"],
    duplicates: ["b.ts#X|Y"],
  });
  const { added, resolved } = diffFindings(findings, {
    files: ["a.ts", "old.ts"],
    exports: ["b.ts#unused"],
    duplicates: ["b.ts#X|Y"],
  });
  assert.deepEqual(added, [{ type: "dependencies", key: "package.json#left-pad" }]);
  assert.deepEqual(resolved, [{ type: "files", key: "old.ts" }]);
});

test("knip compiler: test loader calls become imports of the names read", () => {
  const source = `
const loader = createTsModuleLoader();
const { alpha, beta: renamed, gamma = 1 } = loader.loadModule("src/a.ts");
const ns = createTsModuleLoader({
  mocks: { "@liveagent/ui/lib/mocked": { x: 1 } },
}).loadModule("src/b.ts");
test("ns survives in a title and // a comment", () => ns.first(ns?.second));
const env = { tools: loader.loadModule("src/c.ts") };
env.tools.third();
const escaped = loader.loadModule("src/d.ts");
inspect(escaped);
const single = loader.loadModule("src/e.ts").only;
loader.loadModule("src/f.ts");
const { ...rest } = loadModule(
  "src/g.ts",
);
function load(options) {
  return createTsModuleLoader({ mocks: { typebox }, ...options }).loadModule("src/h.ts");
}`;
  assert.deepEqual(loaderCalls(source), [
    { specifier: "src/a.ts", names: ["alpha", "beta", "gamma"] },
    { specifier: "src/b.ts", names: ["first", "second"] },
    { specifier: "src/c.ts", names: ["third"] },
    { specifier: "src/d.ts", names: "all" },
    { specifier: "src/g.ts", names: "all" },
    { specifier: "src/e.ts", names: ["only"] },
    { specifier: "src/f.ts", names: "all" },
    { specifier: "src/h.ts", names: "all" },
  ]);
  assert.deepEqual(loaderCalls("import x from './x.mjs';"), []);

  const compiled = appendLoaderImports(
    'const { a } = loader.loadModule("src/a.ts");\nconst m = loader.loadModule("src/m.ts");\nloader.loadModule("pkg");',
    (specifier) => (specifier.startsWith("src/") ? `../../${specifier}` : null),
  );
  assert.match(compiled, /^import \{ a as __knip1_0 \} from "\.\.\/\.\.\/src\/a\.ts";$/m);
  assert.match(compiled, /^import "\.\.\/\.\.\/src\/m\.ts";$/m, "a module object that is never read imports nothing");
  assert.doesNotMatch(compiled, /from "pkg"/, "unresolved specifiers are skipped");
});

test("perf gate: ratios are absolute, times are a wide normalized backstop", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const baseline = {
    metrics: {
      "sse.incremental2mbMs": 2,
      "projection.reuseRatio": 0.03,
      "store.usPerEvent200": 1,
      "lru.persistedBytes": 1000,
    },
  };
  const rows = (metrics, speed = 1) =>
    Object.fromEntries(comparePerf(metrics, baseline, speed).map((row) => [row.key, row.status]));
  const fine = {
    "sse.scaling16vs2": 5,
    "sse.incremental2mbMs": 8,
    "projection.reuseRatio": 0.2,
    "store.usPerEvent200": 4.9,
    "lru.persistedBytes": 1040,
  };
  const result = rows(fine);
  assert.equal(result["sse.scaling16vs2"], "ok");
  assert.equal(result["sse.incremental2mbMs"], "ok", "4x the baseline is engine/runner noise, not a regression");
  assert.equal(result["projection.reuseRatio"], "ok");
  assert.equal(result["store.usPerEvent200"], "ok", "limit is max(1*5, 1+3) = 5");
  assert.equal(result["lru.persistedBytes"], "ok");
  assert.equal(result["projection.freshMs"], "missing", "a gated metric without baseline fails");
  assert.equal(result["store.historyScaling"], "missing", "a ratio that was not measured fails");

  assert.equal(rows({ ...fine, "sse.scaling16vs2": 100 })["sse.scaling16vs2"], "fail", "quadratic growth");
  assert.equal(rows({ ...fine, "sse.scaling16vs2": 100 }, 0.1)["sse.scaling16vs2"], "fail", "ratios ignore machine speed");
  assert.equal(rows({ ...fine, "sse.incremental2mbMs": 25 })["sse.incremental2mbMs"], "fail", "limit is max(2*10, 2+5) = 20");
  assert.equal(rows({ ...fine, "sse.incremental2mbMs": 25 }, 2)["sse.incremental2mbMs"], "ok", "a 2x slower machine halves the reading");
  assert.equal(rows({ ...fine, "projection.reuseRatio": 0.9 }, 0.1)["projection.reuseRatio"], "fail");
  assert.equal(rows({ ...fine, "lru.persistedBytes": 1100 })["lru.persistedBytes"], "fail");
});

test("perf scenarios report: medians per scenario and flagged slowdowns", () => {
  const rows = [
    { scenario: "stream", throttle: 1, run: 0, taskMs: 100, status: "n/a" },
    { scenario: "stream", throttle: 1, run: 1, taskMs: 300 },
    { scenario: "stream", throttle: 1, run: 2, taskMs: 200 },
  ];
  assert.deepEqual(aggregate(rows).get("stream@1").values, { taskMs: 200 });
  assert.deepEqual(change(130, 100), { text: "+30%", flagged: true });
  assert.deepEqual(change(3, 2), { text: "+50%", flagged: false }, "tiny absolute changes are noise");
  assert.deepEqual(change(90, 100), { text: "-10%", flagged: false });
  const { markdown, flagged } = renderReport(rows, [{ scenario: "stream", throttle: 1, run: 0, taskMs: 100 }], "T");
  assert.equal(flagged, 1);
  assert.match(markdown, /\| stream \| 1x \| taskMs \| 100 \| 200 \| \+100% :warning: \|/);
  assert.match(renderReport(rows, null, "T").markdown, /No results from main/);
});

test("design tokens: checked sources skip tests, declarations and token files", () => {
  assert.equal(isDesignTokenSource("crates/agent-ui/src/components/ui/badge.tsx"), true);
  assert.equal(isDesignTokenSource("crates/agent-gateway/web/src/app/App.css"), true);
  assert.equal(isDesignTokenSource("crates/agent-ui/src/styles/tokens.css"), false);
  assert.equal(isDesignTokenSource("crates/agent-ui/src/styles/semantic-colors.css"), false);
  assert.equal(isDesignTokenSource("crates/agent-gui/src/env.d.ts"), false);
  assert.equal(isDesignTokenSource("crates/agent-gui/src/a.test.ts"), false);
  assert.equal(isDesignTokenSource("crates/agent-gui/test/a.test.mjs"), false);
  assert.equal(isDesignTokenSource("scripts/a.ts"), false);
});

test("design tokens: comments are blanked, strings are kept", () => {
  const source = 'const a = "#fff"; // see #359\n/* rgb(1, 2, 3) */ const b = "https://x";';
  const stripped = stripComments(source);
  assert.equal(stripped.length, source.length);
  assert.match(stripped, /"#fff"/);
  assert.doesNotMatch(stripped, /#359|rgb\(/);
  assert.match(stripped, /"https:\/\/x"/);
});

test("design tokens: each rule matches raw styles and leaves tokens alone", () => {
  const counts = (source) =>
    Object.fromEntries(Object.entries(scanSource(source)).map(([rule, list]) => [rule, list.map((f) => f.match)]));
  assert.deepEqual(counts('cn("text-amber-700 dark:text-amber-300 bg-emerald-500/10 bg-black/40")'), {
    "palette-color": ["text-amber-700", "text-amber-300", "bg-emerald-500/10", "bg-black/40"],
  });
  assert.deepEqual(counts('"bg-[#2168d5] text-[hsl(var(--chat-error))] text-[11px] rounded-[10px] z-[60]"'), {
    // An arbitrary hex is both an arbitrary value and a color literal.
    "color-literal": ["#2168d5"],
    "arbitrary-color": ["bg-[#", "text-[hsl("],
    "arbitrary-size": ["text-[11px]", "rounded-[10px]", "z-[60]"],
  });
  assert.deepEqual(counts('const c = "#2a78d6"; const d = "rgba(0, 0, 0, 0.4)";'), {
    "color-literal": ["#2a78d6", "rgba(0"],
  });
  assert.deepEqual(
    counts('"text-warning bg-success/10 border-info/25 bg-overlay text-2xs font-book rounded-xl layer-popover w-[42rem] grid-cols-[1fr_auto]"'),
    {},
  );
  const [finding] = scanSource('a\nb\n  "text-red-500"')["palette-color"];
  assert.equal(finding.line, 3);
});

test("design tokens: baseline counts may only shrink", () => {
  const baseline = {
    files: {
      "grew.tsx": { "palette-color": 2 },
      "shrunk.tsx": { "palette-color": 5, "arbitrary-size": 1 },
      "gone.tsx": { "color-literal": 3 },
    },
  };
  const counts = {
    "grew.tsx": { "palette-color": 3 },
    "shrunk.tsx": { "palette-color": 4 },
    "new.tsx": { "arbitrary-color": 1 },
  };
  const result = evaluateDesignTokens(counts, baseline);
  assert.deepEqual(
    result.violations.map((entry) => [entry.file, entry.rule, entry.count, entry.recorded]),
    [
      ["grew.tsx", "palette-color", 3, 2],
      ["new.tsx", "arbitrary-color", 1, 0],
    ],
  );
  assert.deepEqual(
    result.stale.map((entry) => [entry.file, entry.rule]).sort(),
    [
      ["gone.tsx", "color-literal"],
      ["shrunk.tsx", "arbitrary-size"],
      ["shrunk.tsx", "palette-color"],
    ],
  );
  assert.deepEqual(
    result.tightened,
    { "grew.tsx": { "palette-color": 2 }, "shrunk.tsx": { "palette-color": 4 } },
    "--update never adds an entry or raises a count",
  );
  const report = formatDesignTokenReport(result, { "new.tsx": { "arbitrary-color": [{ line: 7, match: "bg-[#" }] } });
  assert.match(report, /new\.tsx \[arbitrary-color\] 1 \(baseline 0\)  7:bg-\[#/);
  assert.match(report, /pnpm check:design-tokens --update/);
});

test("budget files are well formed", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (name) => JSON.parse(readFileSync(path.join(scriptsDir, "budgets", name), "utf8"));
  const bundle = read("bundle-size.json");
  assert.ok(bundle.tolerance > 0 && bundle.tolerance < 0.2);
  assert.ok(bundle.apps.gui.startupJsGzip > 0 && bundle.apps.webui.startupJsGzip > 0);
  const files = read("file-size-allowlist.json");
  assert.equal(files.limit, 1500);
  for (const [file, lines] of Object.entries(files.files)) {
    assert.ok(isCheckedSource(file), file);
    assert.ok(lines > files.limit, `${file} is listed but under the limit`);
  }
  assert.ok(read("perf-micro-baseline.json").calibrationMs > 0);
  assert.ok(read("knip-baseline.json").issues);
  const tokens = read("design-token-baseline.json");
  for (const [file, rules] of Object.entries(tokens.files)) {
    assert.ok(isDesignTokenSource(file), file);
    for (const [rule, count] of Object.entries(rules)) {
      assert.ok(["color-literal", "palette-color", "arbitrary-color", "arbitrary-size"].includes(rule), rule);
      assert.ok(Number.isInteger(count) && count > 0, `${file} ${rule}`);
    }
  }
});
