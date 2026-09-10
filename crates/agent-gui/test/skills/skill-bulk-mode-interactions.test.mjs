import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const selection = loader.loadModule(
  "@liveagent/ui/pages/skills-hub/skillBulkSelection.ts",
);

const uiRoot = new URL("../../../agent-ui/src/pages/skills-hub/", import.meta.url);

function readSkillHubSource(file) {
  return readFileSync(new URL(file, uiRoot), "utf8");
}

test("bulk selection helpers support toggle, range updates, and complete-selection checks", () => {
  const oneSelected = selection.toggleBulkSelection(new Set(), "alpha");
  assert.deepEqual([...oneSelected], ["alpha"]);
  assert.equal(selection.toggleBulkSelection(oneSelected, "alpha").size, 0);

  const allSelected = selection.updateBulkSelection(oneSelected, ["beta", "gamma"], true);
  assert.deepEqual([...allSelected], ["alpha", "beta", "gamma"]);
  assert.equal(selection.includesEveryBulkSelection(allSelected, ["alpha", "gamma"]), true);
  assert.equal(selection.includesEveryBulkSelection(allSelected, ["alpha", "missing"]), false);
  assert.equal(selection.includesEveryBulkSelection(allSelected, []), false);
});

test("installed bulk mode exits on empty selection, all-deselect, actions, and Escape", () => {
  const source = readSkillHubSource("SkillsHubPage.tsx");

  assert.match(source, /if \(next\.size === 0\) \{\s*exitBulkMode\(\);\s*return;/);
  assert.match(source, /if \(allVisibleBulkSelected\) exitBulkMode\(\)/);
  assert.match(
    source,
    /allVisibleBulkSelected\s*\? t\("settings\.skillsBulkDeselectAll"\)/,
  );
  assert.match(source, /setBulkUndo\([\s\S]*?exitBulkMode\(\);[\s\S]*?setSettings/);
  assert.match(source, /if \(event\.key === "Escape"\) \{\s*exitBulkMode\(\);/);
});

test("Skill cards use one selected border and never move on hover", () => {
  const installed = readSkillHubSource("InstalledSkillCard.tsx");
  const imported = readSkillHubSource("SkillsImportView.tsx");
  const store = readSkillHubSource("SkillsStoreView.tsx");

  assert.match(installed, /bulkSelected\s*\? "border-foreground bg-muted\/30 shadow-sm"/);
  assert.match(imported, /checked\s*\? "border-foreground bg-muted\/30 shadow-sm"/);
  assert.match(imported, /focus-visible:ring-offset-2/);
  assert.doesNotMatch(installed, /hover:-translate|hover:scale|ring-2 ring-ring\/40/);
  assert.doesNotMatch(imported, /focus:ring-2|ring-2 ring-ring\/40/);
  assert.doesNotMatch(imported, /hover:-translate|hover:scale/);
  assert.doesNotMatch(store, /hover:-translate|hover:scale/);
});

test("bulk-mode guidance stays in the overlay instead of shifting page content", () => {
  const page = readSkillHubSource("SkillsHubPage.tsx");
  const imported = readSkillHubSource("SkillsImportView.tsx");

  assert.doesNotMatch(page, /hub-panel-enter flex items-center gap-2 text-11px[^>]*skillsBulkHint/);
  assert.doesNotMatch(imported, /hub-panel-enter flex items-center gap-2 text-11px[^>]*skillsBulkImportHint/);
  assert.match(page, /pointer-events-none absolute inset-x-0 bottom-4/);
  assert.match(page, /settings\.skillsBulkClickToSelect/);
});
