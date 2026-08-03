import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const implementations = [
  {
    label: "GUI",
    page: new URL("../../src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
    composer: new URL("../../src/components/chat/MentionComposer.tsx", import.meta.url),
    composerBar: new URL(
      "../../src/pages/chat/components/ChatComposerBar.tsx",
      import.meta.url,
    ),
    manager: new URL("../../src/components/skills/SkillPresetManager.tsx", import.meta.url),
    i18n: new URL("../../src/i18n/config.ts", import.meta.url),
  },
  {
    label: "WebUI",
    page: new URL(
      "../../../agent-gateway/web/src/pages/skills-hub/SkillsHubPage.tsx",
      import.meta.url,
    ),
    composer: new URL(
      "../../../agent-gateway/web/src/components/chat/MentionComposer.tsx",
      import.meta.url,
    ),
    composerBar: new URL(
      "../../../agent-gateway/web/src/pages/chat/ChatComposerBar.tsx",
      import.meta.url,
    ),
    manager: new URL(
      "../../../agent-gateway/web/src/components/skills/SkillPresetManager.tsx",
      import.meta.url,
    ),
    i18n: new URL("../../../agent-gateway/web/src/i18n/config.ts", import.meta.url),
  },
];

for (const { label, page, composer, composerBar, manager, i18n } of implementations) {
  const source = readFileSync(page, "utf8");
  const composerSource = readFileSync(composer, "utf8");
  const composerBarSource = readFileSync(composerBar, "utf8");
  const managerSource = readFileSync(manager, "utf8");
  const translations = readFileSync(i18n, "utf8");

  test(`${label} keeps preset management inside its peer-level Hub tab`, () => {
    assert.match(source, /type SkillsHubView = "installed" \| "presets" \| "store" \| "import"/);
    assert.match(source, /value: "presets" as const,[\s\S]*settings\.skillsHubPresetsTab/);
    assert.match(source, /view === "presets" \? \([\s\S]*<SkillPresetManager/);
    assert.doesNotMatch(source, /renamingPresetId|activeCustomPreset/);
    assert.match(managerSource, /orderedPresets\.map/);
    assert.match(managerSource, /settings\.skillsPresetCreate/);
  });

  test(`${label} edits custom presets in a drawer with installed Skill filters`, () => {
    assert.match(managerSource, /createPortal\(/);
    assert.match(managerSource, /skill\.name\.toLowerCase\(\)\.includes\(normalizedQuery\)/);
    assert.match(managerSource, /categories\.includes\(category\)/);
    assert.match(managerSource, /return !selectedOnly \|\| draft\.skillNames\.has\(skill\.name\)/);
    assert.match(managerSource, /skills\.filter\(isUserSelectableSkill\)/);
    assert.match(managerSource, /settings\.skillsPresetDescriptionLabel/);
    assert.match(managerSource, /aria-pressed=\{active\}/);
    assert.match(managerSource, /CATEGORY_ICONS\[value\]/);
    assert.doesNotMatch(managerSource, /<select[\s\S]*settings\.skillsPresetCategoryLabel/);
    assert.match(managerSource, /role="switch"[\s\S]*aria-checked=\{checked\}/);
    assert.match(managerSource, /bg-emerald-500 ring-emerald-400\/45/);
    assert.match(managerSource, /line-clamp-2[\s\S]*skill\.description/);
    assert.match(managerSource, /const name = event\.currentTarget\.value/);
    assert.match(managerSource, /const description = event\.currentTarget\.value/);
    assert.doesNotMatch(managerSource, /setDraft\(\(current\) => \(\{[\s\S]{0,160}event\.currentTarget\.value/);
    assert.equal(translations.match(/"settings\.skillsPresetSearchPlaceholder":/g)?.length, 2);
  });

  test(`${label} unmounts the preset drawer after its closing animation`, () => {
    assert.match(managerSource, /const closingRef = useRef\(false\)/);
    assert.match(managerSource, /if \(closingRef\.current\) return/);
    assert.match(managerSource, /window\.setTimeout\(\(\) => onCloseRef\.current\(\), 200\)/);
    assert.match(managerSource, /const handleClose = useCallback\([\s\S]*?\}, \[\]\)/);
    assert.doesNotMatch(managerSource, /\}, \[closing, onClose\]\)/);
  });

  test(`${label} keeps Default read-only and routes membership changes to Installed`, () => {
    assert.match(managerSource, /const readOnly = isDefault/);
    assert.match(managerSource, /if \(readOnly\) return/);
    assert.match(managerSource, /settings\.skillsPresetDefaultDescription/);
    assert.match(managerSource, /onGoInstalled\(\)/);
    assert.match(source, /updateSkillPreset\(prev\.skills, DEFAULT_SKILL_PRESET_ID/);
  });

  test(`${label} adds newly installed store Skills to Default`, () => {
    const start = source.indexOf("  const enableInstalledSkillsFromJob = useCallback(");
    const end = source.indexOf("\n  useEffect(() => {", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const installUpdate = source.slice(start, end);
    assert.match(
      installUpdate,
      /resolveSkillPreset\(prev\.skills, DEFAULT_SKILL_PRESET_ID\)/,
    );
    assert.doesNotMatch(installUpdate, /activePreset\.id/);
  });

  test(`${label} configures conversation presets through the /skills command`, () => {
    assert.match(composerSource, /type: "skillsCommand"/);
    assert.match(composerSource, /normalizedMentionQuery === "skills"/);
    assert.match(composerSource, /skillsCommand\?\.onChange\(suggestion\.presetId, suggestion\.disabled\)/);
    assert.match(composerBarSource, /skillsCommand=\{/);
    assert.doesNotMatch(composerBarSource, /value=\{skillsDisabled \? "__disabled__"/);
  });
}
