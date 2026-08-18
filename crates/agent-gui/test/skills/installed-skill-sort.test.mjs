import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

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
      "useFlipGrid.ts",
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

  test(`${label} wires visual order, selection order, persistence, and reduced-motion FLIP`, () => {
    const source = sources.map((file) => readFileSync(file, "utf8")).join("\n");

    assert.match(source, /skillsHub\.installedSort/);
    assert.match(source, /sortInstalledSkillItems\(filtered, installedSort, selected/);
    assert.match(source, /sortedFiltered\.map/);
    assert.match(source, /sortedFiltered[\s\S]*handleBulkInstalledCardClick/);
    assert.match(source, /ref=\{installedGridRef\}/);
    assert.equal(source.match(/data-flip-key=\{key\}/g)?.length, 2);
    assert.match(source, /prefers-reduced-motion: reduce/);
    assert.match(source, /<Select[\s\S]*value=\{installedSort\}/);
    assert.match(source, /<SelectItem[\s\S]*value=\{option\.value\}/);
    assert.match(source, /followElement\?\.scrollIntoView\(\{/);
    assert.match(source, /block: "nearest"/);
    assert.match(source, /behavior: reducedMotion \? "auto" : "smooth"/);
    assert.match(source, /left: rect\.left - gridRect\.left/);
    assert.match(source, /top: rect\.top - gridRect\.top/);
    assert.match(source, /const previousOrderRef = useRef<string\[\]>\(\[\]\)/);
    assert.match(source, /const orderChanged =/);
    assert.match(source, /!orderChanged/);
    assert.match(
      source,
      /requestInstalledSkillFlip\("single", \[name\], on \? \[name\] : \[\]\)/,
    );
    assert.match(
      source,
      /requestInstalledSkillFlip\("batch", changedNames, target \? changedNames : \[\]\)/,
    );
    assert.match(source, /const followKeys = followNames\.map/);
    assert.match(source, /requestInstalledFlip\(mode, keys, followKeys\)/);
    assert.match(
      source,
      /const followNames = changedNames\.filter\([\s\S]*restoreSet\.has\(name\) && !current\.has\(name\)/,
    );
    assert.match(source, /requestInstalledSkillFlip\("batch", changedNames, followNames\)/);
    assert.match(source, /overflow-y-auto[^"]*\[overflow-anchor:none\]/);
    assert.match(source, /requestInstalledFlip\("wave", \[\], followKey \? \[followKey\] : \[\]\)/);
    assert.match(source, /const FLIP_HERO_DURATION_MS = 380/);
    assert.match(source, /const FLIP_BATCH_HERO_DELAY_MS = 90/);
    assert.match(source, /const FLIP_BATCH_STAGGER_LIMIT = 8/);
    assert.match(source, /cubic-bezier\(0\.34, 1\.3, 0\.64, 1\)/);
    assert.match(source, /const FLIP_WAVE_DURATION_MS = 280/);
    assert.match(source, /const FLIP_WAVE_DELAY_MS = 30/);
    assert.match(source, /const FLIP_WAVE_MAX_DELAY_MS = 400/);
    assert.match(source, /if \(mode === "batch"\)/);
    assert.match(source, /const heroPhaseDuration =/);
    assert.match(source, /phaseTimerRef\.current = window\.setTimeout/);
    assert.match(source, /window\.clearTimeout\(phaseTimerRef\.current\)/);
    assert.match(source, /startWave\(\)/);
    assert.match(source, /element\.style\.willChange = "translate"/);
    assert.match(source, /element\.style\.willChange = ""/);
    assert.match(source, /element\.style\.zIndex = "30"/);
    assert.match(source, /element\.style\.zIndex = ""/);
    assert.match(source, /clearAnimation\(\);[\s\S]*const grid = gridRef\.current/);
    assert.match(source, /element\.style\.translate/);
    assert.match(
      source,
      /<SelectTrigger[\s\S]*h-8 w-auto max-w-\[11rem\][^"]*bg-transparent/,
    );
    assert.match(source, /<Input[\s\S]*h-11 rounded-full[^"]*bg-background/);
    assert.match(source, /from "@liveagent\/ui\/components\/ui\/select"/);
    assert.match(
      source,
      /hub-panel-enter flex min-h-11 items-center justify-between gap-3 max-sm:flex-col/,
    );
    assert.match(
      source,
      /max-w-full[^"]*overflow-x-auto[^"]*\[scrollbar-width:none\] \[&::-webkit-scrollbar\]:hidden/,
    );
    assert.match(source, /max-sm:max-w-\[8rem\]/);
    assert.match(source, /hub-panel-enter relative mb-5/);
    assert.equal(source.match(/2xl:grid-cols-5/g)?.length, 5);
    assert.match(source, /pb-\[calc\(10rem\+env\(safe-area-inset-bottom\)\)\] sm:pb-24/);
    assert.equal(
      source.match(/max-sm:bottom-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/g)?.length,
      2,
    );
    assert.match(source, /max-sm:bottom-\[calc\(0\.25rem\+env\(safe-area-inset-bottom\)\)\]/);
    assert.equal(source.match(/<SheetPopup/g)?.length, 2);
    assert.equal(source.match(/variant="inset"/g)?.length, 2);
    assert.equal(source.match(/<SheetPanel/g)?.length, 2);
    assert.match(source, /from "@liveagent\/ui\/components\/ui\/sheet"/);
    assert.doesNotMatch(source, /createPortal/);
    assert.equal(
      source.match(/hub-panel-enter pointer-events-auto[^"]*bg-background\/95/g)?.length,
      3,
    );
    assert.match(
      source,
      /notify-toast-enter[^"]*border-amber-500\/30[^"]*bg-background/,
    );
    assert.doesNotMatch(source, /<select[^>]*backdrop-blur/);
    assert.doesNotMatch(source, /<input[^>]*backdrop-blur/);
    assert.doesNotMatch(source, /hub-skill-card[^"]*backdrop-blur/);
    assert.doesNotMatch(source, /skill-card-enter group flex h-full[^"]*backdrop-blur/);
    assert.doesNotMatch(source, /hub-panel-enter pointer-events-auto[^"]*backdrop-blur/);
    assert.doesNotMatch(source, /notify-toast-enter[^"]*backdrop-blur/);
    assert.doesNotMatch(source, /fixed inset-0 z-50 flex justify-end/);
  });
}
