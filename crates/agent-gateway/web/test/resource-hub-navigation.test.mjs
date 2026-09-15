import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const { createGatewayConversationActions } = loader.loadModule("src/app/gatewayConversationActions.ts");

for (const resource of ["skills", "mcp", "memory", "cron"]) {
  test(`${resource} opens in the content area while preserving the desktop sidebar and composer draft`, () => {
    const calls = [];
    const actions = createGatewayConversationActions({
      setRightDockOpen: (open) => calls.push(["rightDock", open]),
      setSidebarOpen: () => assert.fail("Desktop sidebar must stay open"),
      cacheVisibleComposerDraft: () => calls.push(["cacheDraft"]),
      setActiveView: (view) => calls.push(["view", view]),
      setSettingsOpen: () => assert.fail("Resource navigation must not open settings"),
      clearCachedComposerDraft: () => assert.fail("Draft must be retained"),
    });
    actions.handleSidebarOpenResourceHub(resource);
    assert.deepEqual(calls, [["rightDock", false], ["cacheDraft"], ["view", `${resource}-hub`]]);
  });
}
