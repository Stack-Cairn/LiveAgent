import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const state = loader.loadModule("src/lib/chat/conversationSkillsState.ts");

test("a local conversation Skills override survives stale history and clears on its echo", () => {
  const initial = { selections: new Map(), dirtyIds: new Set() };
  const overridden = state.applyConversationSkillsOverride(initial, "conversation-1", {
    skillPresetId: "focused",
    skillsDisabled: true,
  });
  const stale = state.applyPersistedConversationSkills(overridden, "conversation-1", {
    skillPresetId: "default",
    skillsDisabled: false,
  });
  assert.strictEqual(stale, overridden);
  assert.deepEqual(stale.selections.get("conversation-1"), {
    skillPresetId: "focused",
    skillsDisabled: true,
  });

  const echoed = state.applyPersistedConversationSkills(stale, "conversation-1", {
    skillPresetId: "focused",
    skillsDisabled: true,
  });
  assert.equal(echoed.dirtyIds.has("conversation-1"), false);
});

test("draft binding rekeys both the Skills selection and dirty marker", () => {
  const overridden = state.applyConversationSkillsOverride(
    { selections: new Map(), dirtyIds: new Set() },
    "local-draft",
    { skillPresetId: "focused", skillsDisabled: false },
  );
  const rebound = state.rekeyConversationSkills(overridden, "local-draft", "conversation-1");
  assert.equal(rebound.selections.has("local-draft"), false);
  assert.equal(rebound.dirtyIds.has("local-draft"), false);
  assert.deepEqual(rebound.selections.get("conversation-1"), {
    skillPresetId: "focused",
    skillsDisabled: false,
  });
  assert.equal(rebound.dirtyIds.has("conversation-1"), true);
});
