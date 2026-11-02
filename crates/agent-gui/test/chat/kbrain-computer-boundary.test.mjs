import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("conversation runner never registers or executes frontend browser/computer tools", () => {
  const source = readFileSync(new URL("../../src/pages/chat/turns/runKBrainConversationTurn.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createBrowserTools|executeToolCall|client_tools|onClientToolRequest|createDesktopClientTools/);
  assert.doesNotMatch(source, /getConfiguredKBrainConnection|baseUrl:\s*runtimeConnection|token:\s*runtimeConnection/);
  const { kBrainOwnedDesktopCommand } = createTsModuleLoader().loadModule("src/lib/host.ts");
  for (const command of ["cua_driver_probe", "cua_driver_install", "cua_driver_list_installed_apps", "browser_navigate"]) assert.equal(kBrainOwnedDesktopCommand(command), true);
});

test("computer settings render backend state and persist only through the backend adapter", async () => {
  const updates = [];
  let document = { computer: { enabled: false, backend: "cua", command: [], approvalPolicy: "ask", deny: ["preserved"] } };
  const adapter = {
    getSettings: async () => document,
    getComputerStatus: async () => ({ executionOwner: "kbrain", installed: false, platform: "fixture", backend: "cua", enabled: false }),
    updateSettings: async (update) => { updates.push(update); document = update; return document; },
  };
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/app/shims/tauriCore": { invoke: () => assert.fail("frontend native command") },
  } });
  const { KBrainComputerSection } = env.loadModule(fileURLToPath(new URL("../../../agent-ui/src/pages/settings/KBrainComputerSection.tsx", import.meta.url)));
  const host = documentNode(); const root = env.createRoot(host);
  try {
    await env.act(async () => root.render(env.React.createElement(KBrainComputerSection, { kbrain: adapter })));
    assert.match(host.textContent, /fixture/);
    await env.act(async () => host.querySelector('input[type="checkbox"]').click());
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "settings.save");
    await env.act(async () => save.click());
    assert.equal(updates.length, 1);
    assert.equal(updates[0].computer.enabled, true);
    assert.deepEqual(updates[0].computer.deny, ["preserved"]);
    assert.match(host.textContent, /settings.saved/);
  } finally { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); }
});

const locale = { t: (key) => key };
function documentNode() { return globalThis.document.body.appendChild(globalThis.document.createElement("div")); }
