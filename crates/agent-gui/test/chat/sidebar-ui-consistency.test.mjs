import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (path) =>
  readFileSync(new URL(`../../../agent-ui/src/${path}`, import.meta.url), "utf8");

test("branch folders use SVG icons without native disclosure markers or animation", () => {
  const source = readUi("components/git/GitBranchSelector.tsx");
  const summary = source.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "";
  assert.match(summary, /list-none/);
  assert.match(summary, /webkit-details-marker/);
  assert.match(summary, /<ChevronRight/);
  assert.match(summary, /<Folder/);
  assert.doesNotMatch(summary, /transition|animate/);
  assert.match(source, /\[&\[open\]>summary>svg:first-child\]:rotate-90/);
});


test("sidebar rows share settings hover and selection surfaces", () => {
  for (const path of ["components/chat/ChatHistorySidebar.tsx", "components/chat/ChatHistorySidebarRows.tsx", "pages/settings/SettingsShell.tsx"]) {
    const source = readUi(path);
    assert.match(source, /hover:bg-settings-tile-hover/);
    assert.match(source, /bg-settings-active/);
    assert.doesNotMatch(source, /hover:bg-foreground\/5\b/);
  }
});

test("chat and settings lists share scalable row heights and one-pixel gaps", () => {
  const sidebar = readUi("components/chat/ChatHistorySidebar.tsx");
  const rows = readUi("components/chat/ChatHistorySidebarRows.tsx");
  const settings = readUi("pages/settings/SettingsShell.tsx");
  for (const source of [sidebar, rows, settings]) {
    assert.match(source, /sidebar-list-row/);
  }
  assert.doesNotMatch(rows, /h-30px/);
  assert.match(sidebar, /mb-2 ml-3 space-y-px pl-2/);
  assert.match(sidebar, /HISTORY_ROW_GAP = 1/);
  assert.match(sidebar, /ref=\{historyVirtualizer.measureElement\}/);
  assert.match(sidebar, /absolute inset-x-0 top-0 pb-px/);
  assert.match(readUi("styles/base.css"), /@utility sidebar-list-row/);
});

test("right dock controls reuse standard buttons and segmented selectors", () => {
  const toolbar = readUi("components/project-tools/git-review/Toolbar.tsx");
  assert.match(toolbar, /<TabsList variant="segmented"/);
  assert.match(toolbar, /<SettingsToggleGroup/);
  assert.doesNotMatch(toolbar, /transition-\[left\]|scale-\[0\.7\]/);
  for (const path of ["components/project-tools/RightDockTabStrip.tsx", "components/project-tools/RightDockLauncher.tsx"]) {
    assert.doesNotMatch(readUi(path), /<button\s/);
  }
});
