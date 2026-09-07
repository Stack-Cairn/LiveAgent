import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controlsSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillCategoryControls.tsx", import.meta.url),
  "utf8",
);
const hubSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
  "utf8",
);
const importSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsImportView.tsx", import.meta.url),
  "utf8",
);
const importTabsSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsImportSourceTabs.tsx", import.meta.url),
  "utf8",
);
const externalToolIconSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/resources/ExternalToolSourceIcon.tsx",
    import.meta.url,
  ),
  "utf8",
);
const resourceTabsSource = readFileSync(
  new URL("../../../agent-ui/src/components/resources/ResourceTabsList.tsx", import.meta.url),
  "utf8",
);

test("skill category navigation uses the shared standard Tabs components", () => {
  assert.match(controlsSource, /import \{ Tabs, TabsList, TabsTrigger \}/);
  assert.match(controlsSource, /<Tabs[\s\S]*<TabsList[\s\S]*<TabsTrigger/);
  assert.doesNotMatch(controlsSource, /ToggleGroup/);
});

test("installed skill categories reuse the quiet store tabs with icons", () => {
  assert.match(hubSource, /<StoreCategoryChips[\s\S]*value=\{installedCategory\}/);
  assert.doesNotMatch(hubSource, /appearance="outlined"/);
  assert.doesNotMatch(hubSource, /showIcons=\{false\}/);
  assert.match(controlsSource, /appearance === "outlined"/);
  assert.match(controlsSource, /showIcons \? <CategoryIcon/);
  assert.match(controlsSource, /<Badge[\s\S]*h-4 min-w-4 rounded-full px-1/);
  // Height lives in the base TabsTrigger now, so the chips must NOT pin their
  // own — that drift is what made every tab row a different size.
  assert.match(controlsSource, /shrink-0 gap-1 rounded-md px-2/);
  assert.doesNotMatch(controlsSource, /<TabsTrigger[\s\S]{0,400}?"[^"]*\bh-\d/);
  assert.doesNotMatch(hubSource, /-mt-1\.5 border-b border-border/);
});

test("primary and local-import navigation use standard Tabs without divider borders", () => {
  assert.match(hubSource, /<ResourceTabsList/);
  assert.match(resourceTabsSource, /<TabsList[\s\S]*rounded-lg bg-muted p-1/);
  assert.match(resourceTabsSource, /<TabsTrigger/);
  assert.doesNotMatch(
    hubSource,
    /hub-panel-enter flex min-h-11 items-center justify-between gap-3 border-b/,
  );
  assert.match(importSource, /<SkillsImportSourceTabs/);
  assert.match(importTabsSource, /export function SkillsImportSourceTabs/);
  assert.match(importTabsSource, /ExternalToolSourceIcon/);
  assert.match(externalToolIconSource, /"claude-code": ClaudeIcon/);
  assert.match(externalToolIconSource, /codex: OpenaiChatgptIcon/);
  assert.match(externalToolIconSource, /codebuddy: Bot/);
  assert.match(externalToolIconSource, /agents: SkillIcon/);
  assert.match(importTabsSource, /data-\[active\]:bg-muted/);
  assert.doesNotMatch(importSource, /sticky top-0[^\"]*border-b/);
});

test("installed and local-import content keep stable scroll-area spacing", () => {
  assert.match(hubSource, /overflow-y-auto px-0\.5 pr-1 \[overflow-anchor:none\]/);
  assert.match(hubSource, /<div className="flex flex-col gap-3">/);
  assert.match(importSource, /overflow-y-auto px-1\.5 pb-4 pt-1\.5/);
  assert.match(importSource, /<div className="flex flex-col gap-3">/);
  assert.doesNotMatch(hubSource, /overflow-y-auto px-0\.5 pr-1 pt-1\.5/);
  assert.doesNotMatch(importSource, /sticky top-0[^\"]*(?:pb-1\.5|pt-1\.5)/);
});
