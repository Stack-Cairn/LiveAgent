// customSettings 有两个归一化实现：lib/settings 的 normalizeCustomSettings（权威、
// 需要 providers）和 storage.ts 里 readLocalUiSettings 内部那份手写的本地读取器
// （providers 还没加载，只能原样带过）。后者逐字段枚举，任何新字段忘了列进去就会
// 在下次启动时静默消失——「设置了子代理模型，重开又变回跟随主会话」就是这么来的。
//
// 这里从公开入口做真实的「保存 → 重新加载」往返，并结构化地断言每个键都活着，
// 这样下一个往 customSettings 加字段的人会被测试拦住，而不是靠手动复现发现。

import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const PROVIDERS = [
  {
    id: "codex-main",
    name: "Codex Main",
    type: "codex",
    baseUrl: "https://codex.example.test/v1",
    apiKey: "key",
    models: [
      { id: "gpt-5", contextWindow: 400000, maxOutputToken: 128000 },
      { id: "gpt-5.1", contextWindow: 400000, maxOutputToken: 128000 },
    ],
    activeModels: ["gpt-5", "gpt-5.1"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
  {
    id: "claude-cheap",
    name: "Claude Cheap",
    type: "claude_code",
    baseUrl: "https://anthropic.example.test",
    apiKey: "key",
    models: [{ id: "claude-haiku-4-5", contextWindow: 200000, maxOutputToken: 64000 }],
    activeModels: ["claude-haiku-4-5"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
];

function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
  return store;
}

function loadModules() {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        // 本地 UI 域不落 SQLite；后端只需要回一份最小快照。
        invoke: async (command) =>
          command === "settings_load_all" ? { providers: PROVIDERS, defaultWorkdir: "" } : undefined,
      },
    },
  });
  return {
    storage: loader.loadModule("src/lib/settings/storage.ts"),
    settings: loader.loadModule("src/lib/settings/index.ts"),
  };
}

/** 保存 next 后重新加载，返回加载回来的 settings。 */
async function roundTrip(storage, settings, mutate) {
  const base = settings.normalizeSettings({ customProviders: PROVIDERS });
  const next = mutate(base);
  await storage.persistSettings(base, next);
  const loaded = await storage.loadPersistedSettingsWithDefaults();
  return loaded.settings;
}

test("a pinned subagent model and reasoning survive a save/reload cycle", async () => {
  installLocalStorage();
  const { storage, settings } = loadModules();

  const reloaded = await roundTrip(storage, settings, (prev) =>
    settings.updateCustomSettings(prev, {
      subagentModel: { customProviderId: "claude-cheap", model: "claude-haiku-4-5" },
      subagentReasoning: "low",
    }),
  );

  assert.deepEqual(reloaded.customSettings.subagentModel, {
    customProviderId: "claude-cheap",
    model: "claude-haiku-4-5",
  });
  assert.equal(reloaded.customSettings.subagentReasoning, "low");
});

test("clearing the pin back to follow-parent also survives a reload", async () => {
  installLocalStorage();
  const { storage, settings } = loadModules();

  const pinned = settings.updateCustomSettings(
    settings.normalizeSettings({ customProviders: PROVIDERS }),
    { subagentModel: { customProviderId: "codex-main", model: "gpt-5" } },
  );
  const cleared = settings.updateCustomSettings(pinned, {
    subagentModel: undefined,
    subagentReasoning: undefined,
  });
  await storage.persistSettings(pinned, cleared);
  const reloaded = (await storage.loadPersistedSettingsWithDefaults()).settings;

  assert.equal(reloaded.customSettings.subagentModel, undefined);
  assert.equal(reloaded.customSettings.subagentReasoning, undefined);
});

test("an invalid stored reasoning level is dropped on load, not turned into a real level", async () => {
  installLocalStorage();
  const { storage, settings } = loadModules();

  // 本地读取器原样带过档位，由 providers 就位后的归一化裁决；这里确认它裁的是
  // 「丢弃」而不是钳到某个用户没选过的档位。
  const reloaded = await roundTrip(storage, settings, (prev) => ({
    ...prev,
    customSettings: {
      ...prev.customSettings,
      subagentModel: { customProviderId: "codex-main", model: "gpt-5" },
      subagentReasoning: "not-a-level",
    },
  }));

  assert.deepEqual(reloaded.customSettings.subagentModel, {
    customProviderId: "codex-main",
    model: "gpt-5",
  });
  assert.equal(reloaded.customSettings.subagentReasoning, undefined);
});

test("every customSettings key survives the local read path", async () => {
  installLocalStorage();
  const { storage, settings } = loadModules();

  // 结构化守卫：往 customSettings 加字段却忘了在 storage.ts 的本地读取器里带过，
  // 这条会红。逐键断言比人工复现可靠。
  const authored = settings.updateCustomSettings(
    settings.normalizeSettings({ customProviders: PROVIDERS }),
    {
      conversationTitleModel: { customProviderId: "codex-main", model: "gpt-5" },
      commitMessageModel: { customProviderId: "codex-main", model: "gpt-5.1" },
      subagentModel: { customProviderId: "claude-cheap", model: "claude-haiku-4-5" },
      subagentReasoning: "medium",
      chatSidebar: { projectsCollapsed: true, recentCollapsed: true },
      interfaceFontFamily: "Cang Er Yu Yang Ti",
      chatFontFamily: "Cang Er Yu Yang Ti",
      codeFontFamily: "Maple Mono",
      fontScale: { sidebar: 1.1, chat: 1.2, rightDock: 0.9 },
    },
  );
  await storage.persistSettings(
    settings.normalizeSettings({ customProviders: PROVIDERS }),
    authored,
  );
  const reloaded = (await storage.loadPersistedSettingsWithDefaults()).settings;

  const missing = Object.keys(authored.customSettings).filter((key) => {
    const before = JSON.stringify(authored.customSettings[key]);
    const after = JSON.stringify(reloaded.customSettings[key]);
    return before !== after;
  });
  assert.deepEqual(
    missing,
    [],
    `these customSettings keys did not survive the local read path: ${missing.join(", ")}`,
  );
});
