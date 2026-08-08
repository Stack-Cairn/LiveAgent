import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSources = [
  {
    label: "共享 Skills Hub",
    source: readFileSync(
      new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
      "utf8",
    ),
  },
];

function installFunctionSource(source) {
  const start = source.indexOf("  async function installStoreSkill(");
  const end = source.indexOf("\n  async function deleteSkill(", start);
  assert.notEqual(start, -1, "installStoreSkill must exist");
  assert.notEqual(end, -1, "installStoreSkill must end before deleteSkill");
  return source.slice(start, end);
}

for (const { label, source } of pageSources) {
  test(`${label} shows pending install feedback before owner resolution`, () => {
    const installSource = installFunctionSource(source);
    const pendingClaim = installSource.indexOf(
      "pendingInstallTokensRef.current.set(initialStoreKey, pendingToken);",
    );
    const ownerResolution = installSource.indexOf("await resolveClawHubSkillOwner(skill);");

    assert.notEqual(pendingClaim, -1);
    assert.notEqual(ownerResolution, -1);
    assert.ok(pendingClaim < ownerResolution, "pending state must be claimed before the first await");
    assert.match(
      installSource,
      /pendingInstallTokensRef\.current\.has\(initialStoreKey\)/,
    );
    assert.match(installSource, /finally \{[\s\S]*token !== pendingToken[\s\S]*delete\(storeKey\)/);
  });

  test(`${label} renders pending progress in cards and the preview drawer`, () => {
    assert.match(source, /pendingInstallKeys=\{pendingInstallKeys\}/);
    assert.match(source, /installing: pending \|\| Boolean\(job && !terminalJob\)/);
    assert.match(source, /\{installing && !done \? \(/);
    assert.match(source, /installState\.installing && !installState\.done/);
    assert.match(source, /aria-busy=\{installing\}/);
    assert.match(source, /aria-busy=\{installState\.installing\}/);
  });
}
