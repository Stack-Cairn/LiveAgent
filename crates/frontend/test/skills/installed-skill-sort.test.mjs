import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const sorting = loader.loadModule("src/lib/skills/installedSort.ts");

function skill(name, installedAt = null) {
  return {
    name,
    description: name,
    skillFile: `${name}/SKILL.md`,
    baseDir: name,
    installedAt,
  };
}

test("keeps built-ins ahead of enabled and disabled skills", () => {
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

test("sorts newest installs within enabled groups and leaves missing dates last", () => {
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

test("validates persisted installed sort values", () => {
  assert.equal(sorting.isInstalledSkillSort("name-asc"), true);
  assert.equal(sorting.isInstalledSkillSort("name-desc"), true);
  assert.equal(sorting.isInstalledSkillSort("installed-desc"), true);
  assert.equal(sorting.isInstalledSkillSort("downloads"), false);
  assert.equal(sorting.isInstalledSkillSort(null), false);
});
