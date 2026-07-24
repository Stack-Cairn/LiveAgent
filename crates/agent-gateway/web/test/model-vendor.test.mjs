import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const modelVendor = loader.loadModule("src/lib/providers/modelVendor.ts");

test("findNewModelIds detects every model added by one refresh and removes duplicates", () => {
  assert.deepEqual(
    modelVendor.findNewModelIds(
      [{ id: "gpt-a" }],
      [{ id: "gpt-a" }, { id: "claude-z" }, { id: "gpt-z" }, { id: "claude-z" }],
    ),
    ["claude-z", "gpt-z"],
  );
});

test("WebUI model order snapshots stay stable and append new rows before settling", () => {
  const models = [{ id: "claude-z" }, { id: "gpt-a" }, { id: "gemini-z" }];
  const snapshot = modelVendor.createModelOrderSnapshot(models, undefined, new Set(["gpt-a"]));

  assert.deepEqual(snapshot, ["gpt-a", "claude-z", "gemini-z"]);
  assert.deepEqual(
    modelVendor
      .applyModelOrderSnapshot([...models, { id: "gpt-z" }], snapshot)
      .map((model) => model.id),
    ["gpt-a", "claude-z", "gemini-z", "gpt-z"],
  );

  assert.deepEqual(
    modelVendor.createModelOrderSnapshot(
      [...models, { id: "gpt-z" }],
      undefined,
      new Set(["gpt-a", "gpt-z"]),
    ),
    ["gpt-z", "gpt-a", "claude-z", "gemini-z"],
  );
});
