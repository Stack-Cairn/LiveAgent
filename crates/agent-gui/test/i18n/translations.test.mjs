import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const i18n = loader.loadModule("src/i18n/config.ts");

test("supported locales, fallback, and system language detection are stable", () => {
  assert.equal(i18n.DEFAULT_LOCALE, "zh-CN");
  assert.deepEqual([...i18n.SUPPORTED_LOCALES], ["zh-CN", "en-US"]);
  assert.equal(i18n.normalizeLocale("en-US"), "en-US");
  assert.equal(i18n.normalizeLocale("fr-FR"), "zh-CN");
  assert.equal(i18n.detectSystemLocale(["en-GB"]), "en-US");
  assert.equal(i18n.detectSystemLocale(["fr-FR", "en-US"]), "en-US");
  assert.equal(i18n.detectSystemLocale(["zh-Hans-CN", "en-US"]), "zh-CN");
  assert.equal(i18n.detectSystemLocale(["fr-FR"]), "zh-CN");
});

test("all locales expose the same translation keys", () => {
  const localeKeys = Object.fromEntries(
    Object.entries(i18n.translations).map(([locale, messages]) => [
      locale,
      Object.keys(messages).sort(),
    ]),
  );
  const zhKeys = localeKeys["zh-CN"];
  const enKeys = localeKeys["en-US"];

  assert.deepEqual(
    zhKeys.filter((key) => !enKeys.includes(key)),
    [],
    "en-US is missing keys present in zh-CN",
  );
  assert.deepEqual(
    enKeys.filter((key) => !zhKeys.includes(key)),
    [],
    "zh-CN is missing keys present in en-US",
  );
});

test("translation lookup falls back to the key for unknown entries", () => {
  assert.equal(i18n.t("app.name", "en-US"), "LiveAgent");
  assert.equal(i18n.t("missing.key", "en-US"), "missing.key");
});

test("loading states and desktop settings fallbacks are localized", () => {
  assert.equal(i18n.t("chat.loadingConversation", "zh-CN"), "正在加载对话...");
  assert.equal(i18n.t("chat.loadingConversation", "en-US"), "Loading conversation...");
  assert.equal(
    i18n.t("app.settingsLoadFailed", "zh-CN"),
    "加载设置失败，已回退到默认配置。",
  );
  assert.equal(
    i18n.t("app.settingsLoadFailed", "en-US"),
    "Failed to load settings. Default settings have been restored.",
  );
  assert.equal(i18n.t("app.settingsSaveFailed", "en-US"), "Failed to save settings.");
  assert.equal(
    i18n.t("app.settingsReloadFailed", "en-US"),
    "Failed to reload settings. The previous settings are still displayed.",
  );
  assert.equal(
    i18n.t("app.gatewaySettingsSyncFailed", "en-US"),
    "Failed to sync WebUI settings.",
  );
  assert.equal(
    i18n.t("app.settingsSshSettingsChanged", "en-US"),
    "SSH settings were updated elsewhere. The latest settings have been loaded; submit your changes again.",
  );
  assert.ok(i18n.t("app.settingsSshSettingsChanged", "zh-CN"));
});

test("usage query labels exist in both locales", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    assert.ok(i18n.translations[locale]["settings.providerUsageQuery"]);
    assert.ok(i18n.translations[locale]["settings.providerUsageTest"]);
  }
});
