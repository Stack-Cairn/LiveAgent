import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { applyProviderModelDraft } = createTsModuleLoader().loadModule("@liveagent/ui/pages/settings/providerUtils.ts");
const model = { id: "example", contextWindow: 128000, maxOutputToken: 4096, limitsSource: "catalog", inputModalities: ["text", "image"], promptCacheHintMode: "auto" };

test("viewing and switching away from a model preserves catalog ownership and capabilities", () => {
  const result = applyProviderModelDraft([model], model, 128000, 4096);
  assert.equal(JSON.stringify(result), JSON.stringify([model]));
});

test("saving a pending model draft changes only its limits and preserves other models", () => {
  const other = { ...model, id: "other" };
  const result = applyProviderModelDraft([model, other], model, 64000, 8192);
  assert.equal(result[0].contextWindow, 64000);
  assert.equal(result[0].maxOutputToken, 8192);
  assert.equal(result[0].limitsSource, "user");
  assert.equal(result[0].inputModalities, model.inputModalities);
  assert.equal(result[0].promptCacheHintMode, "auto");
  assert.equal(result[1], other);
  assert.equal(model.contextWindow, 128000);
});

test("invalid draft blocks switching or saving without replacing the model", () => {
  assert.equal(applyProviderModelDraft([model], model, null, 4096), null);
  assert.equal(applyProviderModelDraft([model], model, 128000, null), null);
});
