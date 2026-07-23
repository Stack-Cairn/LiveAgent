import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

test("custom provider modelOrder is optional for old data", () => {
  const provider = settings.normalizeCustomProvider({
    id: "legacy",
    type: "codex",
    models: ["gpt-4.1", "gpt-5"],
  });
  assert.equal(provider.modelOrder, undefined);
});

test("custom provider modelOrder removes stale ids and appends newly fetched models", () => {
  const provider = settings.normalizeCustomProvider({
    id: "ordered",
    type: "codex",
    models: ["gpt-4.1", "gpt-5", "o3"],
    modelOrder: ["o3", "missing", "gpt-4.1", "o3"],
  });
  assert.deepEqual(provider.modelOrder, ["o3", "gpt-4.1", "gpt-5"]);
});
