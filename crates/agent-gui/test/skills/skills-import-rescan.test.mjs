import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { normalizeClassGroups } from "../../../agent-ui/test-support/source-class-groups.mjs";

const loader = createTsModuleLoader();
const scanState = loader.loadModule(
  "@liveagent/ui/pages/skills-hub/externalSkillScanState.ts",
);
const hubSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
  "utf8",
);
const importViewSource = normalizeClassGroups(
  readFileSync(
    new URL("../../../agent-ui/src/pages/skills-hub/SkillsImportView.tsx", import.meta.url),
    "utf8",
  ),
);

function scans(description = "A useful skill") {
  return [
    {
      tool: "codex",
      rootDir: "/tmp/codex/skills",
      exists: true,
      errors: [],
      skills: [
        {
          name: "example",
          description,
          baseDir: "/tmp/codex/skills/example",
          skillFile: "/tmp/codex/skills/example/SKILL.md",
        },
      ],
    },
  ];
}

test("unchanged external scan results preserve the current list reference", () => {
  const previous = scans();
  assert.equal(scanState.reconcileExternalToolScans(previous, scans()), previous);
  assert.notEqual(
    scanState.reconcileExternalToolScans(previous, scans("Updated description")),
    previous,
  );
});

test("manual rescans retain stale content and only mark the scan button busy", () => {
  assert.match(hubSource, /reconcileExternalToolScans\(previous, scans\)/);
  assert.match(hubSource, /setExternalScans\(\(previous\) => previous \?\? \[\]\)/);
  assert.match(hubSource, /initializing=\{externalScans === null\}/);
  assert.match(hubSource, /disabled=\{externalScans === null \|\| externalLoading\}/);
  assert.match(hubSource, /externalLoading \? \(\s*<Loader2[^>]*animate-spin/);
  assert.match(hubSource, /onClick=\{\(\) => void rescanExternalSkills\(\)\}/);
  assert.match(importViewSource, /\{initializing \? \(/);
  assert.doesNotMatch(importViewSource, /\{loading \? \(\s*<GlassPanel/);
});

test("the local import shell and card padding stay stable during the initial scan", () => {
  assert.match(importViewSource, /<SkillsImportSourceTabs[\s\S]*disabled=\{initializing\}/);
  assert.match(importViewSource, /overflow-y-auto px-0\.5 pb-4 pr-1/);
  assert.match(importViewSource, /className=\{SKILL_CARD_SHELL_CLASS\}/);
  assert.match(importViewSource, /cn\(\s*SKILL_CARD_SHELL_CLASS,/);
  assert.match(importViewSource, /gap-1\.5 rounded-lg bg-background text-foreground/);
  assert.doesNotMatch(importViewSource, /w-fit self-end/);
  assert.doesNotMatch(importViewSource, /skill-card-enter group flex min-h-48/);
});

test("the local import bulk bar reuses the installed bulk bar shell", () => {
  const sharedBulkBarShell =
    /rounded-full border border-border\/50 bg-background\/95[\s\S]{0,160}?py-2 pl-4 pr-2 text-xs shadow-ui-skillshubpage-51/;

  assert.match(hubSource, sharedBulkBarShell);
  assert.match(importViewSource, sharedBulkBarShell);
  assert.match(importViewSource, /absolute inset-x-0 bottom-4 z-20 flex justify-center px-3/);
  assert.match(importViewSource, /max-sm:bottom-safe-bottom-offset/);
  assert.match(importViewSource, /const showBulkBar = importableSelectedCount > 0 \|\| importing/);
  assert.match(importViewSource, /skillsImportButton/);
});
