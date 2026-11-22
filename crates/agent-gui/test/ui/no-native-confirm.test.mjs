import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseTypeScriptSource, walkSyntaxTree } from "../../../../scripts/typescript-source-tools.mjs";

// Native confirm() blocks the webview, ignores the app theme and locale, and
// is unavailable in some hosts. Every confirmation goes through the shared
// in-app dialog (useConfirmDialog) instead.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const roots = ["crates/agent-ui/src", "crates/agent-gui/src", "crates/agent-gateway/web/src"];
const NATIVE_DIALOGS = new Set(["confirm", "alert", "prompt"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$|\.test\.tsx?$/.test(entry.name)) yield full;
  }
}

const propertyName = (node) =>
  node.computed ? (node.property.type === "StringLiteral" ? node.property.value : undefined) : node.property.name;

test("no UI source calls the native confirm/alert/prompt dialogs", () => {
  const found = [];
  let scanned = 0;
  for (const root of roots) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      scanned++;
      const relative = path.relative(repoRoot, file);
      const tree = parseTypeScriptSource(readFileSync(file, "utf8"), file);
      walkSyntaxTree(tree, (node) => {
        if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
        const callee = node.callee;
        const member = callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression";
        const native = member
          ? callee.object.type === "Identifier" && GLOBAL_OBJECTS.has(callee.object.name) &&
            NATIVE_DIALOGS.has(propertyName(callee))
          : false;
        if (native) found.push(`${relative}:${node.loc.start.line}`);
      });
    }
  }
  assert.ok(scanned > 500, `expected to scan the UI sources, scanned ${scanned}`);
  assert.deepEqual(found, []);
});
