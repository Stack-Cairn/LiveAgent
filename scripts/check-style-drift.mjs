import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { compactClasses, splitUtility } from "./lib/style-classes.mjs";
import { syncStyleTokens } from "./sync-style-tokens.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const parser = require("@babel/parser");
const postcss = require("postcss");
const root = fileURLToPath(new URL("..", import.meta.url));
function walk(n, visit) {
  if (!n || typeof n !== "object") return;
  visit(n);
  for (const [key, value] of Object.entries(n)) {
    if (["loc", "extra"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}
export function styleIssues(file, source) {
  if (!source) return [];
  const issues = [];
  const add = (key, line, message) => issues.push({ key, line, message });
  if (/tailwind\.config\.[cm]?[jt]s$/.test(file))
    add("legacy-config", 1, "Use the existing Tailwind v4 CSS configuration.");
  if (/\.css$/.test(file)) {
    const ast = postcss.parse(source),
      primitives = new Map();
    ast.walkAtRules("keyframes", (n) => {
      if (file !== "crates/agent-ui/src/styles/animations.css")
        add(
          "keyframe:" + n.params,
          n.source.start.line,
          "Define keyframes in styles/animations.css.",
        );
    });
    ast.walkDecls((decl) => {
      if (decl.prop.startsWith("--animate-") && file !== "crates/agent-ui/src/styles/animations.css")
        add(
          "animation:" + decl.prop,
          decl.source.start.line,
          "Define animation utilities in styles/animations.css.",
        );
      if (
        !/^--(?:ui-color-|ui-duration-|shadow-|background-image-)/.test(decl.prop) ||
        /^var\(--[^)]+\)$/.test(decl.value)
      )
        return;
      const family = decl.prop.match(/^--(?:ui-color|ui-duration|shadow|background-image)/)[0];
      let context = "";
      for (let n = decl.parent; n?.type !== "root"; n = n.parent)
        context += n.selector || n.name + " " + n.params;
      const key = context + "|" + family + "|" + decl.value.replace(/\s+/g, " ");
      const previous = primitives.get(key);
      if (previous && previous !== decl.prop)
        add(
          "duplicate:" + decl.prop,
          decl.source.start.line,
          `Reuse ${previous} through an alias instead of repeating its value.`,
        );
      else primitives.set(key, decl.prop);
    });
    ast.walkAtRules("apply", (n) => {
      for (const c of compactClasses(n.params).changes)
        add("compact:" + c.before, n.source.start.line, `Use ${c.after} for ${c.before}.`);
    });
  } else if (/\.[jt]sx?$/.test(file)) {
    const ast = parser.parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
    walk(ast, (node) => {
      const value =
        node.type === "StringLiteral"
          ? node.value
          : node.type === "TemplateElement"
            ? node.value.raw
            : null;
      if (value === null) return;
      for (const c of compactClasses(value).changes)
        add("compact:" + c.before, node.loc.start.line, `Use ${c.after} for ${c.before}.`);
      for (const token of value.split(/\s+/)) {
        const { utility } = splitUtility(token);
        if (
          /^(?:h|w|size|p[xytrbl]?|m[xytrbl]?|text|gap(?:-[xy])?)-\[(?:-?\d+(?:\.\d+)?(?:px|rem|em)|#[0-9a-fA-F]{3,8})\]$/.test(
            utility,
          )
        )
          add(
            "literal:" + token,
            node.loc.start.line,
            `Use an existing exact token or add one for ${token}.`,
          );
      }
    });
  }
  return issues;
}
export function newStyleIssues(file, before, after) {
  const counts = new Map();
  for (const issue of styleIssues(file, before))
    counts.set(issue.key, (counts.get(issue.key) || 0) + 1);
  return styleIssues(file, after).filter((issue) => {
    const n = counts.get(issue.key) || 0;
    if (n) {
      counts.set(issue.key, n - 1);
      return false;
    }
    return true;
  });
}
export function checkStyleDrift(base = "HEAD") {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const files = new Set(
    [
      ...git(["diff", "--name-only", base, "--", "crates"]).split("\n"),
      ...git(["ls-files", "--others", "--exclude-standard", "--", "crates"]).split("\n"),
    ].filter(Boolean),
  );
  const problems = [];
  for (const file of files) {
    if (
      (!file.includes("/src/") && !/tailwind\.config\./.test(file)) ||
      file.endsWith("style-token-names.generated.json") ||
      !existsSync(resolve(root, file))
    )
      continue;
    let before = "";
    try {
      before = git(["show", `${base}:${file}`]);
    } catch {}
    for (const issue of newStyleIssues(file, before, readFileSync(resolve(root, file), "utf8")))
      problems.push(`${file}:${issue.line}: ${issue.message}`);
  }
  syncStyleTokens(true);
  return problems;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const i = process.argv.indexOf("--base");
    const problems = checkStyleDrift(i >= 0 ? process.argv[i + 1] : "HEAD");
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    } else console.log("No new style drift; token registry is current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
