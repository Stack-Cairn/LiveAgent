import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceRoots = [
  new URL("../../src/components/project-tools/git-review/", import.meta.url),
  new URL("../../../agent-gateway/web/src/components/project-tools/git-review/", import.meta.url),
];

function source(root, relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

test("git review section menus isolate animation transforms from positioning", () => {
  for (const root of sourceRoots) {
    const model = source(root, "model.ts");
    const statusView = source(root, "StatusView.tsx");

    assert.match(model, /type ChangesMenuState = \{\s+right: number;/);
    assert.match(statusView, /style=\{\{ right: changesMenu\.right, top: changesMenu\.y \}\}/);
    assert.match(statusView, /style=\{\{ transformOrigin: "top right" \}\}/);
    assert.doesNotMatch(statusView, /translateX\(-100%\)/);
  }
});
