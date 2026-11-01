import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-3a: Settings lists 权限 only when the host can reach the K-brain rules API (the desktop
// adapter today; the WebUI gets it in LA-3b). Both locales carry the page's text.

const settings = {
  stt: { provider: "tencent_cloud" },
  system: { workspaceProjects: [], hiddenWorkspaceProjectPaths: [], archivedWorkspaceProjectPaths: [] },
  customProviders: [],
  customSettings: { fontScale: { sidebar: 1, chat: 1, rightDock: 1, settings: 1 } },
};

async function sectionIds(kbrain) {
  const shared = (name) => fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));
  let sections = [];
  const env = await createDomTestEnv({
    mocks: {
      [shared("SettingsShell.tsx")]: { SettingsShell: ({ registry }) => { sections = registry.settingsSections; return null; } },
      [shared("PermissionRulesSection.tsx")]: { PermissionRulesSection: () => null },
      [shared("ProvidersSection.tsx")]: { ProvidersSection: () => null },
      [shared("SystemSettingsForm.tsx")]: { SystemSettingsForm: () => null },
      [shared("AgentsSection.tsx")]: { AgentsSection: () => null },
      [shared("ResourceHubSection.tsx")]: { ResourceHubSection: () => null },
      [shared("SystemToolsSection.tsx")]: { SystemToolsSection: () => null },
      [shared("CuaDriverSection.tsx")]: { CuaDriverSection: () => null },
      [shared("RemoteSection.tsx")]: { RemoteSection: () => null },
      [shared("SshSection.tsx")]: { SshSection: () => null },
      [shared("SttSection.tsx")]: { SttSection: () => null },
      [shared("HooksSection.tsx")]: { HooksSection: () => null },
      [shared("CronSection.tsx")]: { CronSection: () => null },
      [shared("AIApprovalSection.tsx")]: { AIApprovalSection: () => null },
      [shared("CalendarSection.tsx")]: { CalendarSection: () => null },
      [shared("memory/MemoryPanel.tsx")]: { MemoryPanel: () => null },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/adapters/settingsExtension": {
        createSettingsExtension: () => ({ surface: "desktop", iconClassName: "", slots: {}, sections: [] }),
      },
      "@liveagent/adapters/providerSettings": { ProviderSettingsExtension: () => null, ProviderCopyConfigButton: () => null },
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/ui/button": { Button: (props) => env.React.createElement("button", props) },
      "@liveagent/ui/components/ui/input": { Input: (props) => env.React.createElement("input", props) },
    },
  });
  const { SettingsPage } = env.loadModule("@liveagent/ui/pages/settings/SettingsPage.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  try {
    await env.act(async () => root.render(env.React.createElement(SettingsPage, {
      settings, setSettings: () => {}, saveState: { status: "saved" }, onBack: () => {},
      initialSection: "system", sttSettingsService: {},
      settingsHost: { isKbrain: true, kbrain },
    })));
    return sections.map((section) => `${section.id}:${section.groupKey}:${section.labelKey}`);
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

const base = { isKbrain: true, getConnection: () => null, getSettings: async () => ({}), updateSettings: async () => ({}) };

test("the permissions page is listed only for hosts with the rules API", async () => {
  const withRules = await sectionIds({ ...base, listPermissionRules: async () => ({ rules: [] }), addPermissionRule: async () => ({}), deletePermissionRule: async () => {} });
  assert.equal(withRules.includes("permissions:settings.groupIntelligence:settings.navPermissions"), true);
  const without = await sectionIds(base);
  assert.equal(without.some((id) => id.startsWith("permissions:")), false);
});

test("both locales carry the same permission page keys", () => {
  const loader = createTsModuleLoader();
  const zh = loader.loadModule("../agent-ui/src/i18n/translations/zhCNSettings.ts").ZH_CN_SETTINGS_TRANSLATIONS;
  const en = loader.loadModule("../agent-ui/src/i18n/translations/enUSSettings.ts").EN_US_SETTINGS_TRANSLATIONS;
  const keys = (table) => Object.keys(table).filter((key) => key === "settings.navPermissions" || key.startsWith("settings.permissions.")).sort();
  assert.deepEqual(keys(zh), keys(en));
  assert.equal(keys(zh).length >= 20, true);
  assert.equal(zh["settings.navPermissions"], "权限");
});
