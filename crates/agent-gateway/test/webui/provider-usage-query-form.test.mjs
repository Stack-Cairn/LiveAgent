import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const forms = loader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");

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

test("WebUI usage query draft preserves configured redacted secrets when saved", () => {
  const draft = forms.createUsageQueryDraft(usageQuery, true);

  assert.notEqual(draft.apiKey, "");
  assert.notEqual(draft.accessToken, "");
  assert.notEqual(draft.secretAccessKey, "");
  assert.deepEqual(forms.serializeUsageQueryDraft(draft, true), usageQuery);
});

test("WebUI usage query serialization clamps the timeout", () => {
  const serialized = forms.serializeUsageQueryDraft({ ...usageQuery, timeoutSecs: 500 }, false);
  assert.equal(serialized.timeoutSecs, 30);
});

test("WebUI mode switch keeps per-mode scripts independent", () => {
  const generalPreset = forms.USAGE_QUERY_PRESET_SCRIPTS.general;
  const filled = forms.applyUsageQueryModePreset({ ...usageQuery, script: "" }, "general");
  assert.equal(filled.script, generalPreset);

  // newapi 里的编辑切到 general 再切回后原样恢复。
  const edited = forms.setUsageQueryScript(
    { ...usageQuery, mode: "newapi", script: "" },
    "(my newapi script)",
  );
  const onGeneral = forms.applyUsageQueryModePreset(edited, "general");
  assert.equal(onGeneral.script, generalPreset);
  const back = forms.applyUsageQueryModePreset(onGeneral, "newapi");
  assert.equal(back.script, "(my newapi script)");
});

test("WebUI usage test action accepts only a persisted provider id", () => {
  assert.equal(forms.getPersistedUsageQueryProviderId(undefined), null);
  assert.equal(forms.getPersistedUsageQueryProviderId({ id: "" }), null);
  assert.equal(forms.getPersistedUsageQueryProviderId({ id: "provider-a" }), "provider-a");
});

test("WebUI custom usage query needs confirmation before its first enabled save", () => {
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
});
