import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const source = ["SkillsHubPage.tsx", "InstalledSkillsView.tsx"]
  .map((file) =>
    readFileSync(
      new URL(`../../../agent-ui/src/pages/skills-hub/${file}`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");
const guiLoader = createTsModuleLoader();
const webRoot = fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url));
const hostTranslations = [
  ["GUI", guiLoader.loadModule("src/i18n/config.ts").translations],
  [
    "WebUI",
    createTsModuleLoader({ rootDir: webRoot }).loadModule("src/i18n/config.ts").translations,
  ],
];

test("the shared Skills Hub preserves the initial list and defers subsequent updates", () => {
    assert.match(source, /const deferredSkills = useDeferredValue\(skills\)/);
    assert.match(source, /const installedContentPending = deferredSkills !== skills/);
    assert.match(
      source,
      /skills\.length > 0 && !hasPresentedInstalledSkills && installedContentPending/,
    );
    assert.match(source, /<SkillsContentLoadingState[\s\S]*settings\.skillsHubPreparing/);
    assert.match(source, /aria-busy=\{loading \|\| initialContentPending\}/);
});

test("the shared Skills Hub derives installed Skills from the deferred snapshot", () => {
    assert.match(
      source,
      /rankFuzzySearchResults\(deferredSkills, deferredFilter/,
    );
    assert.doesNotMatch(source, /rankFuzzySearchResults\(skills, deferredFilter/);
});

test("the shared Skills Hub avoids discovery signatures during shell render", () => {
    assert.match(source, /const discoverySignatureRef = useRef<string \| null>\(null\)/);
    assert.doesNotMatch(
      source,
      /const discoverySignatureRef = useRef\(\s*buildSkillDiscoverySignature/,
    );
});

test("both hosts provide localized deferred-content loading copy", () => {
  for (const [host, translations] of hostTranslations) {
    for (const locale of ["zh-CN", "en-US"]) {
      assert.equal(
        typeof translations[locale]["settings.skillsHubPreparing"],
        "string",
        `${host} ${locale} must define settings.skillsHubPreparing`,
      );
      assert.equal(
        typeof translations[locale]["settings.skillsHubPreparingDesc"],
        "string",
        `${host} ${locale} must define settings.skillsHubPreparingDesc`,
      );
    }
  }
});
