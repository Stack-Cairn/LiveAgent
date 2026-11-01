import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// LA-3b: the WebUI settings adapter reaches K-brain's permission rules through the Gateway
// (permission.rules.*) and hands the shared page the same shapes as the desktop adapter.
function load(client) {
  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../", import.meta.url)),
    mocks: {
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/components/IconSet": { MonitorSmartphone: () => null },
      "@liveagent/ui/lib/resourceHost": { configureResourceHostCapabilities() {}, nativeResourceHostCapabilities: {} },
    },
  });
  return loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
}

test("the WebUI adapter lists, adds and deletes rules through the Gateway", async () => {
  const calls = [];
  const client = {
    permissionRules: async (action, input) => {
      calls.push([action, input]);
      if (action === "list") return { project_root: "D:\\w", rules: [{ id: "r_1", rule: "Bash(ls:*)", effect: "allow", scope: "project", created_at: "2026-11-01T00:00:00Z", source_session: "s1" }] };
      if (action === "add") return { id: "r_2", rule: input.rule, effect: input.effect, scope: input.scope };
      return { ok: true };
    },
  };
  const kbrain = load(client);
  assert.equal(typeof kbrain.listPermissionRules, "function", "the page is registered on the WebUI");
  assert.deepEqual(await kbrain.listPermissionRules({ workspace: "D:\\w" }), {
    projectRoot: "D:\\w",
    rules: [{ id: "r_1", rule: "Bash(ls:*)", effect: "allow", scope: "project", createdAt: "2026-11-01T00:00:00Z", sourceSession: "s1" }],
  });
  assert.deepEqual(calls.at(-1), ["list", { workspace: "D:\\w" }]);
  await kbrain.listPermissionRules({});
  assert.deepEqual(calls.at(-1), ["list", {}]);
  assert.deepEqual(await kbrain.addPermissionRule({ rule: "Bash(rm:*)", effect: "deny", scope: "user" }), { id: "r_2", rule: "Bash(rm:*)", effect: "deny", scope: "user" });
  assert.deepEqual(calls.at(-1), ["add", { rule: "Bash(rm:*)", effect: "deny", scope: "user" }]);
  await kbrain.deletePermissionRule({ id: "r_1", scope: "project", workspace: "D:\\w" });
  assert.deepEqual(calls.at(-1), ["delete", { id: "r_1", scope: "project", workspace: "D:\\w" }]);
});

test("a refusal from K-brain or an old desktop reaches the page as its message", async () => {
  const kbrain = load({
    permissionRules: async () => { throw new Error("desktop app does not support permission rules; update LiveAgent on the desktop"); },
  });
  await assert.rejects(kbrain.listPermissionRules({}), /update LiveAgent on the desktop/);
});
