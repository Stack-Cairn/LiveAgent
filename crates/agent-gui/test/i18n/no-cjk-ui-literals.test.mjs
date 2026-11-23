import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseTypeScriptSource, walkSyntaxTree } from "../../../../scripts/typescript-source-tools.mjs";

// UI text goes through i18n (en + zh). A CJK string in a component, or in the
// hooks, services and helpers that hand text to components, is almost always
// untranslated UI text, so every such literal must be either moved to a
// translation module or listed in cjk-literal-allowlist.json with a reason.
// Both .tsx and .ts sources are scanned: UI text also reaches the screen from
// plain modules (a service's display label, an error message a hook shows).

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const roots = ["crates/agent-ui/src", "crates/agent-gui/src", "crates/agent-gateway/web/src"];
const SKIPPED_DIRECTORIES = new Set(["i18n", "node_modules", "gen", "test", "tests", "__tests__"]);
// CJK symbols and punctuation, CJK ideographs (incl. extension A), full-width forms.
const CJK = /[　-〿㐀-鿿＀-￯]/;
const allowlistPath = fileURLToPath(new URL("./cjk-literal-allowlist.json", import.meta.url));

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(path.join(directory, entry.name));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
      yield path.join(directory, entry.name);
    }
  }
}

function literalTexts(node) {
  if (node.type === "StringLiteral" || node.type === "JSXText") return [node.value];
  if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
  return [];
}

function collectCjkLiterals() {
  const found = new Map();
  let scanned = 0;
  for (const root of roots) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      scanned++;
      const source = readFileSync(file, "utf8");
      if (!CJK.test(source)) continue;
      const relative = path.relative(repoRoot, file).split(path.sep).join("/");
      walkSyntaxTree(parseTypeScriptSource(source, file), (node) => {
        for (const text of literalTexts(node)) {
          if (!CJK.test(text)) continue;
          const literal = text.trim();
          const lines = found.get(`${relative}\n${literal}`) ?? { file: relative, literal, lines: [] };
          lines.lines.push(node.loc.start.line);
          found.set(`${relative}\n${literal}`, lines);
        }
      });
    }
  }
  return { found, scanned };
}

function loadAllowlist() {
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const allowed = new Map();
  for (const section of ["intentional", "deferred"]) {
    assert.ok(Array.isArray(allowlist[section]), `allowlist.${section} must be an array`);
    for (const entry of allowlist[section]) {
      assert.equal(typeof entry.file, "string", `${section} entry needs a file`);
      assert.ok(entry.reason?.trim(), `${section} entry for ${entry.file} needs a reason`);
      assert.ok(entry.literals?.length > 0, `${section} entry for ${entry.file} lists no literals`);
      for (const literal of entry.literals) {
        const key = `${entry.file}\n${literal}`;
        assert.ok(!allowed.has(key), `duplicate allowlist entry: ${entry.file} ${JSON.stringify(literal)}`);
        allowed.set(key, { section, file: entry.file, literal });
      }
    }
  }
  return allowed;
}

test("UI .ts and .tsx sources contain no CJK literals outside the allowlist", () => {
  const { found, scanned } = collectCjkLiterals();
  const allowed = loadAllowlist();
  assert.ok(scanned > 1000, `expected to scan the UI sources, scanned ${scanned} files`);

  const unexpected = [...found]
    .filter(([key]) => !allowed.has(key))
    .map(([, item]) => `${item.file}:${item.lines.join(",")} ${JSON.stringify(item.literal)}`);
  assert.deepEqual(
    unexpected,
    [],
    "Move these strings to an i18n translation module (en + zh), or allowlist an intentional locale-specific literal with a reason in test/i18n/cjk-literal-allowlist.json",
  );

  const stale = [...allowed]
    .filter(([key]) => !found.has(key))
    .map(([, item]) => `${item.section}: ${item.file} ${JSON.stringify(item.literal)}`);
  assert.deepEqual(stale, [], "Remove allowlist entries that no longer match a literal in the source");
});
