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

test("manual rescans retain stale content and only mark the button busy", () => {
  assert.match(hubSource, /reconcileExternalToolScans\(previous, scans\)/);
  assert.match(hubSource, /setExternalScans\(\(previous\) => previous \?\? \[\]\)/);
  assert.match(hubSource, /initializing=\{externalScans === null\}/);
  assert.match(importViewSource, /\{initializing \? \(/);
  assert.match(importViewSource, /aria-busy=\{loading\}/);
  assert.match(importViewSource, /loading \? \(\s*<Loader2[^>]*animate-spin/);
  assert.match(importViewSource, /rescanComplete[\s\S]*settings\.skillsScanComplete/);
  assert.match(importViewSource, /aria-live="polite"/);
  assert.doesNotMatch(importViewSource, /\{loading \? \(\s*<GlassPanel/);
  assert.doesNotMatch(importViewSource, /disabled=\{[^}]*importing \|\| loading/);
});

test("the local import shell and card padding stay stable during the initial scan", () => {
  assert.match(importViewSource, /<SkillsImportSourceTabs[\s\S]*disabled=\{initializing\}/);
  assert.match(importViewSource, /overflow-y-auto px-1\.5 pb-4 pt-1\.5/);
  assert.match(importViewSource, /<LoadingSurface\s+variant="skeleton"[^>]*className="min-h-48 p-3\.5"/);
  assert.match(importViewSource, /group flex min-h-48[^\"]*p-3\.5/);
  assert.match(importViewSource, /className="h-9 w-full gap-1\.5 rounded-xl"/);
  assert.doesNotMatch(importViewSource, /w-fit self-end/);
  assert.doesNotMatch(importViewSource, /skill-card-enter group flex min-h-48/);
});

test("the local import bulk toolbar is bottom-aligned with balanced empty-state spacing", () => {
  assert.match(importViewSource, /pointer-events-none absolute inset-x-0 bottom-1/);
  assert.match(importViewSource, /max-sm:bottom-safe-bottom-offset-compact/);
  assert.match(importViewSource, /\? "py-2 pl-4 pr-2"\s*: "px-4 py-2\.5"/);
  assert.match(importViewSource, /className="h-7 rounded-full px-3 text-xs"/);
  assert.doesNotMatch(importViewSource, /pointer-events-none sticky bottom-3/);
});
