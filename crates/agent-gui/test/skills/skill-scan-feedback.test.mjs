import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const scanSummary = loader.loadModule("@liveagent/ui/pages/skills-hub/skillScanSummary.ts");

function skill(name, overrides = {}) {
  return {
    name,
    description: `${name} description`,
    skillFile: `${name}/SKILL.md`,
    baseDir: name,
    ...overrides,
  };
}

test("Skill scan summaries distinguish added, updated, removed, and unchanged entries", () => {
  const previous = [skill("same"), skill("updated"), skill("removed")];
  const next = [skill("same"), skill("updated", { description: "new description" }), skill("added")];

  assert.deepEqual(scanSummary.summarizeSkillScan(previous, next), {
    total: 3,
    added: 1,
    updated: 1,
    removed: 1,
  });
  assert.deepEqual(scanSummary.summarizeSkillScan(next, next), {
    total: 3,
    added: 0,
    updated: 0,
    removed: 0,
  });
});

test("Skill discovery signatures are independent of discovery order", () => {
  const first = skill("first");
  const second = skill("second");

  assert.equal(
    scanSummary.buildSkillDiscoverySignature("/skills", [first, second]),
    scanSummary.buildSkillDiscoverySignature("/skills", [second, first]),
  );
});

test("manual Skill scans announce a persistent, dismissible result", () => {
  const source = readFileSync(
    new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /refresh\(\{ announce: true \}\)/);
  assert.match(source, /SCAN_FEEDBACK_DURATION_MS/);
  assert.match(source, /toast\[feedback.status\]/);
  assert.match(source, /duration: SCAN_FEEDBACK_DURATION_MS/);
  assert.match(source, /id: `\$\{toastScope\}-scan`/);
  assert.match(source, /summarizeSkillScan\(skillsSnapshotRef\.current, discovery\.skills\)/);
});

test("manual Skill scan button holds a completed state before returning to idle", () => {
  const source = readFileSync(
    new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /SCAN_BUTTON_COMPLETE_DURATION_MS = 2400/);
  assert.match(source, /setScanButtonComplete\(true\)/);
  assert.match(source, /showScanButtonComplete\(\)/);
  assert.match(source, /disabled=\{loading \|\| scanButtonComplete \|\| lockedByChatMode\}/);
  assert.match(source, /scanButtonComplete\s*\? t\("settings\.skillsScanComplete"\)/);
  assert.match(source, /text-\[hsl\(var\(--chat-success\)\)\]/);
});
