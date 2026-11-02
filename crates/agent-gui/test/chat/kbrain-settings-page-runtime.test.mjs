import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const settings = {
  stt: { provider: "tencent_cloud" },
  system: {},
  customProviders: [],
  customSettings: { fontScale: { sidebar: 1, chat: 1, rightDock: 1, settings: 1 } },
};

for (const surface of ["desktop", "web"]) test(`SettingsPage ${surface} shows providers directly without an image service option`, async () => {
  const shared = (name) => fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));
  let section;
  let providerProps;
  const env = await createDomTestEnv({
    mocks: {
      [shared("SettingsShell.tsx")]: { SettingsShell: ({ registry }) => { section = registry.settingsSections.find((item) => item.id === "providers"); return section.render(); } },
      [shared("ProvidersSection.tsx")]: { ProvidersSection: (props) => { providerProps = props; return env.React.createElement("div", null, "original-provider-interface"); } },
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
      [shared("memory/MemoryPanel.tsx")]: { MemoryPanel: () => null },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/adapters/settingsExtension": {
        createSettingsExtension: () => ({ surface, iconClassName: "", slots: {}, sections: [] }),
      },
      "@liveagent/adapters/providerSettings": {
        ProviderSettingsExtension: () => null,
        ProviderCopyConfigButton: () => null,
      },
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/ui/button": { Button: (props) => env.React.createElement("button", props) },
      "@liveagent/ui/components/ui/input": { Input: (props) => env.React.createElement("input", props) },
    },
  });
  const calls = [];
  const documentValue = { mode: "kbrain", defaultModel: "m", defaultProvider: "p", providers: [], models: [] };
  const kbrain = {
    isKbrain: true,
    getConnection: () => ({ baseUrl: "http://runtime.invalid", token: "runtime-token" }),
    getSettings: async () => { calls.push("get"); return documentValue; },
    updateSettings: async (value) => { calls.push(value); return documentValue; },
  };
  const { SettingsPage } = env.loadModule("@liveagent/ui/pages/settings/SettingsPage.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  try {
    await env.act(async () => root.render(env.React.createElement(SettingsPage, {
      settings,
      setSettings: () => {},
      saveState: { status: "saved" },
      onBack: () => {},
      initialSection: "providers",
      sttSettingsService: {},
      settingsHost: { isKbrain: true, kbrain },
      imageClient: { getSettings: async () => { calls.push("image"); throw new Error("image settings must not load"); } },
      registerLeaveGuard: () => { calls.push("image-guard"); return () => {}; },
    })));
    await env.act(async () => Promise.resolve());
    assert.match(host.textContent, /original-provider-interface/);
    const tabs = [...host.querySelectorAll("button")].filter((button) => ["对话模型", "图像服务"].includes(button.textContent));
    assert.deepEqual(tabs, []);
    assert.equal(section.labelKey, "settings.navProviders");
    const zhCN = env.loadModule("@liveagent/ui/i18n/translations/zhCNSettings.ts");
    assert.equal(zhCN.ZH_CN_SETTINGS_TRANSLATIONS["settings.navProviders"], "供应商设置");
    assert.equal(providerProps.settings, settings);
    assert.equal(typeof providerProps.setSettings, "function");
    assert.deepEqual(calls, [], "the removed simplified backend editor must not load");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
