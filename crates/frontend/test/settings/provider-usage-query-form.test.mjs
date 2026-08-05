import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const forms = loader.loadModule("src/pages/settings/providerUtils.ts");

const usageQuery = {
  enabled: true,
  mode: "newapi",
  script: "",
  scripts: {},
  baseUrl: "https://usage.example.test",
  apiKey: "",
  apiKeyConfigured: true,
  accessToken: "",
  accessTokenConfigured: true,
  userId: "user-1",
  accessKeyId: "key-1",
  secretAccessKey: "",
  secretAccessKeyConfigured: true,
  codingPlanProvider: "",
  teamOrganizationId: "",
  teamProjectId: "",
  timeoutSecs: 10,
};

test("usage query draft preserves configured redacted secrets when saved", () => {
  assert.equal(typeof forms.createUsageQueryDraft, "function");
  assert.equal(typeof forms.serializeUsageQueryDraft, "function");

  const draft = forms.createUsageQueryDraft(usageQuery, true);
  assert.notEqual(draft.apiKey, "");
  assert.notEqual(draft.accessToken, "");
  assert.notEqual(draft.secretAccessKey, "");

  assert.deepEqual(forms.serializeUsageQueryDraft(draft, true), usageQuery);
});

test("usage query serialization clamps the timeout", () => {
  const serialized = forms.serializeUsageQueryDraft({ ...usageQuery, timeoutSecs: 500 }, false);
  assert.equal(serialized.timeoutSecs, 30);

  assert.equal(forms.clampUsageQueryTimeoutSecs(Number.NaN), 10);
  assert.equal(forms.clampUsageQueryTimeoutSecs(1), 2);
});

test("usage test action accepts only a persisted provider id", () => {
  assert.equal(typeof forms.getPersistedUsageQueryProviderId, "function");
  assert.equal(forms.getPersistedUsageQueryProviderId(undefined), null);
  assert.equal(forms.getPersistedUsageQueryProviderId({ id: "" }), null);
  assert.equal(forms.getPersistedUsageQueryProviderId({ id: "provider-a" }), "provider-a");
});

test("custom usage query needs confirmation before its first enabled save", () => {
  assert.equal(typeof forms.requiresCustomUsageQueryConfirmation, "function");
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, mode: "custom" }, false),
    true,
  );
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, mode: "custom" }, true),
    false,
  );
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, mode: "custom", enabled: true }, true),
    false,
  );
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, enabled: false, mode: "custom" }, false),
    false,
  );
});

test("each query mode keeps its own script and empty modes show their preset", () => {
  const customPreset = forms.USAGE_QUERY_PRESET_SCRIPTS.custom;
  const generalPreset = forms.USAGE_QUERY_PRESET_SCRIPTS.general;
  const newapiPreset = forms.USAGE_QUERY_PRESET_SCRIPTS.newapi;
  // 一比一复刻 cc-switch:custom 空骨架、general 带 UA + isValid、newapi 带 UA。
  assert.ok(customPreset.includes('url: ""'));
  assert.ok(generalPreset.includes("{{baseUrl}}/user/balance"));
  assert.ok(generalPreset.includes('"User-Agent": "LiveAgent/1.0"'));
  assert.ok(generalPreset.includes("isValid: response.is_active || true"));
  assert.ok(newapiPreset.includes("{{baseUrl}}/api/user/self"));
  assert.ok(newapiPreset.includes('"User-Agent": "LiveAgent/1.0"'));

  // 没填写过的模式显示各自的模板预设(custom 为空骨架)。
  const filled = forms.applyUsageQueryModePreset({ ...usageQuery, script: "" }, "general");
  assert.equal(filled.mode, "general");
  assert.equal(filled.script, generalPreset);
  const skeleton = forms.applyUsageQueryModePreset({ ...usageQuery, script: "" }, "custom");
  assert.equal(skeleton.script, customPreset);

  // 各模式脚本独立:newapi 里的编辑在切走再切回后原样恢复。
  const editedNewapi = forms.setUsageQueryScript(
    { ...usageQuery, mode: "newapi", script: newapiPreset },
    "(my newapi script)",
  );
  assert.equal(editedNewapi.scripts.newapi, "(my newapi script)");
  const onGeneral = forms.applyUsageQueryModePreset(editedNewapi, "general");
  assert.equal(onGeneral.script, generalPreset);
  const editedGeneral = forms.setUsageQueryScript(onGeneral, "(my general script)");
  const backToNewapi = forms.applyUsageQueryModePreset(editedGeneral, "newapi");
  assert.equal(backToNewapi.script, "(my newapi script)");
  assert.equal(backToNewapi.scripts.general, "(my general script)");

  // 非脚本模式不动编辑器内容;再切回脚本模式时从槽位恢复。
  const onBalance = forms.applyUsageQueryModePreset(backToNewapi, "balance");
  assert.equal(onBalance.mode, "balance");
  assert.equal(onBalance.script, "(my newapi script)");
  const restored = forms.applyUsageQueryModePreset(onBalance, "general");
  assert.equal(restored.script, "(my general script)");
});

test("serialization folds the editor content into the per-mode script slot", () => {
  const serialized = forms.serializeUsageQueryDraft(
    {
      ...usageQuery,
      mode: "custom",
      script: "  (custom body)  ",
      scripts: { general: "(general body)", newapi: "   " },
    },
    false,
  );
  assert.equal(serialized.script, "(custom body)");
  assert.deepEqual(serialized.scripts, {
    custom: "(custom body)",
    general: "(general body)",
  });
});

test("preset scripts stay in sync with the Rust builtin presets", async () => {
  // KEEP IN SYNC 锚点:与 backend/src/services/provider_usage.rs 的
  // GENERAL_SCRIPT/NEWAPI_SCRIPT 逐字符一致。custom 骨架仅前端填充
  // (Rust 对空 custom 脚本直接报错,无兜底),不参与比对。
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const rustSource = await readFile(
    fileURLToPath(new URL("../../../backend/src/services/provider_usage.rs", import.meta.url)),
    "utf8",
  );
  for (const preset of [
    forms.USAGE_QUERY_PRESET_SCRIPTS.general,
    forms.USAGE_QUERY_PRESET_SCRIPTS.newapi,
  ]) {
    assert.ok(
      rustSource.includes(`r#"${preset}"#`),
      "preset script must match the Rust builtin byte-for-byte",
    );
  }
});
