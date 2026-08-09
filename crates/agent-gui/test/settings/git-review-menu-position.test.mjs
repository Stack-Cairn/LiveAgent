import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceRoot = new URL(
  "../../../agent-ui/src/components/project-tools/git-review/",
  import.meta.url,
);

function source(root, relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

test("git review section menus isolate animation transforms from positioning", () => {
  const model = source(sourceRoot, "model.ts");
  const statusView = source(sourceRoot, "StatusView.tsx");

  assert.match(model, /type ChangesMenuState = \{\s+right: number;/);
  assert.match(statusView, /style=\{\{ right: changesMenu\.right, top: changesMenu\.y \}\}/);
  assert.match(statusView, /style=\{\{ transformOrigin: "top right" \}\}/);
  assert.doesNotMatch(statusView, /translateX\(-100%\)/);
});
