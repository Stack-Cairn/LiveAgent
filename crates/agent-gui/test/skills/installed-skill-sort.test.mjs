import { resolveStyleValues } from "../../../agent-ui/test-support/style-values.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { normalizeClassGroups } from "../../../agent-ui/test-support/source-class-groups.mjs";

const implementations = [
  {
    label: "共享 Skills Hub",
    loader: createTsModuleLoader(),
    sources: [
      "SkillsHubPage.tsx",
      "InstalledSkillCard.tsx",
      "InstalledSkillPreviewDrawer.tsx",
      "SkillsImportView.tsx",
      "SkillsStoreView.tsx",
    ].map(
      (file) => new URL(`../../../agent-ui/src/pages/skills-hub/${file}`, import.meta.url),
    ),
  },
];

function skill(name, installedAt = null) {
  return {
    name,
    description: name,
    skillFile: `${name}/SKILL.md`,
    baseDir: name,
    installedAt,
  };
}

for (const { label, loader, sources } of implementations) {
  const sorting = loader.loadModule("@liveagent/ui/lib/skills/installedSort.ts");

  test(`${label} keeps built-ins ahead of enabled and disabled skills`, () => {
    const items = [
      skill("z-disabled"),
      skill("z-enabled"),
      skill("skills-creator"),
      skill("skills-installer"),
      skill("a-disabled"),
    ];
    const selected = new Set(["z-enabled"]);

    assert.deepEqual(
      sorting
        .sortInstalledSkillItems(items, "name-asc", selected, (item) => item)
        .map((item) => item.name),
      ["skills-creator", "skills-installer", "z-enabled", "a-disabled", "z-disabled"],
    );
    assert.deepEqual(
      sorting
        .sortInstalledSkillItems(items, "name-desc", selected, (item) => item)
        .map((item) => item.name),
      ["skills-installer", "skills-creator", "z-enabled", "z-disabled", "a-disabled"],
    );
    assert.deepEqual(
      items.map((item) => item.name),
      ["z-disabled", "z-enabled", "skills-creator", "skills-installer", "a-disabled"],
      "sorting must not mutate the discovery result",
    );
  });

  test(`${label} sorts newest installs within enabled groups and leaves missing dates last`, () => {
    const items = [
      skill("disabled-missing"),
      skill("enabled-missing"),
      skill("skills-creator", 50),
      skill("disabled-old", 100),
      skill("enabled-old", 200),
      skill("skills-installer", 600),
      skill("disabled-new", 500),
    ];
    const selected = new Set(["enabled-missing", "enabled-old"]);

    assert.deepEqual(
      sorting
        .sortInstalledSkillItems(items, "installed-desc", selected, (item) => item)
        .map((item) => item.name),
      [
        "skills-installer",
        "skills-creator",
        "enabled-old",
        "enabled-missing",
        "disabled-new",
        "disabled-old",
        "disabled-missing",
      ],
    );
  });

  test(`${label} validates persisted installed sort values`, () => {
    assert.equal(sorting.isInstalledSkillSort("name-asc"), true);
    assert.equal(sorting.isInstalledSkillSort("name-desc"), true);
    assert.equal(sorting.isInstalledSkillSort("installed-desc"), true);
    assert.equal(sorting.isInstalledSkillSort("downloads"), false);
    assert.equal(sorting.isInstalledSkillSort(null), false);
  });

  test(`${label} uses Motion layout for installed-skill reordering`, () => {
    const source = normalizeClassGroups(
      resolveStyleValues(sources.map((file) => readFileSync(file, "utf8")).join("\n")),
    );

    assert.equal(sorting.INSTALLED_SORT_STORAGE_KEY, "skillsHub.installedSort");
    assert.match(source, /sortInstalledSkillItems\(filtered, installedSort, selected/);
    assert.match(source, /sortedFiltered\.map/);
    assert.match(source, /sortedFiltered[\s\S]*handleBulkInstalledCardClick/);
    assert.match(source, /<Select[\s\S]*value=\{installedSort\}/);
    assert.match(source, /<SelectItem[\s\S]*value=\{option\.value\}/);
    assert.match(source, /overflow-y-auto[^"]*\[overflow-anchor:none\]/);
    assert.match(source, /<LazyMotion features=\{domAnimation\}>/);
    assert.match(source, /<LayoutGroup id=\{`\$\{toastScope\}-installed-skills`\}>/);
    assert.match(source, /<m\.div/);
    assert.match(source, /layout=\{prefersReducedMotion \? false : "position"\}/);
    assert.match(source, /type: "spring"/);
    assert.match(source, /stiffness: 420/);
    assert.match(source, /damping: 36/);
    assert.doesNotMatch(source, /data-flip-key/);
    assert.doesNotMatch(source, /querySelectorAll<HTMLElement>\("\[data-flip-key\]"\)/);
    assert.doesNotMatch(source, /element\.style\.(translate|transition|willChange|zIndex)/);
    assert.doesNotMatch(source, /animate-hub-panel-enter/);
    assert.doesNotMatch(source, /notify-toast-enter[^"]*backdrop-blur/);
    assert.doesNotMatch(source, /fixed inset-0 z-50 flex justify-end/);
  });
}
