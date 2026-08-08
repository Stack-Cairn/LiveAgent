import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url);
const source = readFileSync(page, "utf8");
const localeFiles = [
  new URL("../../src/i18n/config.ts", import.meta.url),
  new URL("../../../agent-gateway/web/src/i18n/config.ts", import.meta.url),
];

test("the shared Skills Hub defers the initial installed list behind a loading state", () => {
    assert.match(source, /const deferredSkills = useDeferredValue\(skills, EMPTY_SKILLS\)/);
    assert.match(source, /const installedContentPending = deferredSkills !== skills/);
    assert.match(
      source,
      /skills\.length > 0 && !hasPresentedInstalledSkills && installedContentPending/,
    );
    assert.match(source, /<SkillsContentLoadingState[\s\S]*settings\.skillsHubPreparing/);
    assert.match(source, /aria-busy=\{loading \|\| showInitialInstalledContentLoading\}/);
});

test("the shared Skills Hub derives installed Skills from the deferred snapshot", () => {
    assert.match(
      source,
      /(?:if \(!text\) return deferredSkills|const matchedSkills = !text\s*\? deferredSkills)/,
    );
    assert.match(source, /(?:return|:) deferredSkills\.filter/);
    assert.doesNotMatch(source, /if \(!text\) return skills/);
});

test("the shared Skills Hub avoids discovery signatures during shell render", () => {
    assert.match(source, /const discoverySignatureRef = useRef<string \| null>\(null\)/);
    assert.doesNotMatch(
      source,
      /const discoverySignatureRef = useRef\(\s*buildSkillDiscoverySignature/,
    );
});

test("both hosts provide localized deferred-content loading copy", () => {
  for (const i18n of localeFiles) {
    const translations = readFileSync(i18n, "utf8");
    assert.equal(translations.match(/"settings\.skillsHubPreparing":/g)?.length, 2);
    assert.equal(translations.match(/"settings\.skillsHubPreparingDesc":/g)?.length, 2);
  }
});
