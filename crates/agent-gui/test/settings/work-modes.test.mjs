import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const workModes = loader.loadModule("src/lib/settings/workModes.ts");
const sync = loader.loadModule("src/lib/settings/sync.ts");
const i18n = loader.loadModule("src/i18n/config.ts");

const PROVIDER = {
  id: "provider-1",
  name: "Provider",
  type: "claude_code",
  baseUrl: "https://api.example.com/v1",
  apiKey: "key",
  models: ["model-a", "model-b"],
  activeModels: ["model-a", "model-b"],
};

function baseSettings(overrides = {}) {
  return settings.normalizeSettings({
    customProviders: [PROVIDER],
    selectedModel: { customProviderId: "provider-1", model: "model-a" },
    ...overrides,
  });
}

test("work mode definitions keep coding neutral and writing terminal-free", () => {
  assert.deepEqual(
    workModes.WORK_MODES.map((mode) => mode.id),
    ["coding", "writing", "design"],
  );

  const coding = workModes.getWorkModeDefinition("coding");
  assert.equal(coding.prompt, "");
  assert.deepEqual([...coding.excludedToolNames], []);
  assert.equal(coding.composerHintKey, undefined);

  const writing = workModes.getWorkModeDefinition("writing");
  assert.deepEqual([...writing.excludedToolNames], ["Bash", "ManagedProcess", "ReadTerminal"]);
  assert.ok(writing.prompt.includes('<work-mode name="writing">'));

  const design = workModes.getWorkModeDefinition("design");
  assert.deepEqual([...design.excludedToolNames], []);
  assert.ok(design.prompt.includes('<work-mode name="design">'));

  for (const mode of workModes.WORK_MODES) {
    assert.equal(mode.suggestions.length, 3, `${mode.id} ships three suggestion cards`);
  }
});

test("every work mode i18n key exists in both locales", () => {
  const keys = new Set();
  for (const mode of workModes.WORK_MODES) {
    keys.add(mode.labelKey);
    keys.add(mode.descriptionKey);
    keys.add(mode.greetingSubtitleKey);
    if (mode.composerHintKey) keys.add(mode.composerHintKey);
    for (const suggestion of mode.suggestions) {
      keys.add(suggestion.titleKey);
      keys.add(suggestion.promptKey);
    }
  }
  for (const locale of ["zh-CN", "en-US"]) {
    for (const key of keys) {
      assert.ok(
        typeof i18n.translations[locale][key] === "string" &&
          i18n.translations[locale][key].length > 0,
        `missing ${locale} translation for ${key}`,
      );
    }
  }
});

test("work mode settings normalize defaults and reject unknown ids", () => {
  const defaults = settings.normalizeSettings({});
  assert.deepEqual(defaults.customSettings.workMode, {
    activeModeId: "coding",
    modelByMode: {},
  });

  const normalized = settings.normalizeWorkModeSettings({
    activeModeId: "no-such-mode",
    modelByMode: {
      writing: { customProviderId: "provider-1", model: "model-b" },
      bogus: { customProviderId: "provider-1", model: "model-a" },
      design: { customProviderId: "", model: "" },
    },
  });
  assert.equal(normalized.activeModeId, "coding");
  assert.deepEqual(normalized.modelByMode, {
    writing: { customProviderId: "provider-1", model: "model-b" },
  });
});

test("switching work modes remembers and restores per-mode models", () => {
  const initial = baseSettings();
  assert.equal(initial.customSettings.workMode.activeModeId, "coding");

  // 无感切换：写作模式没记过模型 → 沿用当前模型；旧模式的模型被记住。
  const writing = settings.setActiveWorkMode(initial, "writing");
  assert.equal(writing.customSettings.workMode.activeModeId, "writing");
  assert.deepEqual(writing.selectedModel, { customProviderId: "provider-1", model: "model-a" });
  assert.deepEqual(writing.customSettings.workMode.modelByMode.coding, {
    customProviderId: "provider-1",
    model: "model-a",
  });

  // 写作模式内换模型：记忆写到 writing 名下。
  const writingWithModelB = settings.setSelectedModel(writing, {
    customProviderId: "provider-1",
    model: "model-b",
  });
  assert.deepEqual(writingWithModelB.customSettings.workMode.modelByMode.writing, {
    customProviderId: "provider-1",
    model: "model-b",
  });

  // 切回编程恢复 model-a；再切回写作恢复 model-b。
  const backToCoding = settings.setActiveWorkMode(writingWithModelB, "coding");
  assert.deepEqual(backToCoding.selectedModel, {
    customProviderId: "provider-1",
    model: "model-a",
  });
  const backToWriting = settings.setActiveWorkMode(backToCoding, "writing");
  assert.deepEqual(backToWriting.selectedModel, {
    customProviderId: "provider-1",
    model: "model-b",
  });

  // 同模式切换是 no-op（引用相等，不触发保存链）。
  assert.equal(settings.setActiveWorkMode(backToWriting, "writing"), backToWriting);
});

test("work mode state rides the gateway settings sync payload", () => {
  const switched = settings.setActiveWorkMode(baseSettings(), "design");
  const payload = sync.buildGatewaySettingsSyncPayload(switched);
  assert.equal(payload.customSettings.workMode.activeModeId, "design");
  assert.deepEqual(payload.customSettings.workMode.modelByMode.coding, {
    customProviderId: "provider-1",
    model: "model-a",
  });

  const receiver = settings.normalizeSettings({ customProviders: [PROVIDER] });
  const applied = sync.applyGatewaySettingsSyncPayload(receiver, payload);
  assert.equal(applied.customSettings.workMode.activeModeId, "design");
});
