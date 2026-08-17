import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * 自动同步的触发范围：只有备份快照覆盖的四域（providers / mcp / system / skills）
 * 变更时才该标脏。其余域（主题、语言、SSH…）不在快照里，标脏只会造成无意义的
 * 远端上传。
 */

function createMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
}

async function withLocalStorage(task) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    value: createMemoryLocalStorage(),
  });
  try {
    return await task();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

/** 跑一次 persistSettings，返回本次触发的所有 IPC 命令名。 */
async function invokedCommands(mutate) {
  return await withLocalStorage(async () => {
    const commands = [];
    const loader = createTsModuleLoader({
      mocks: {
        "@tauri-apps/api/core": {
          invoke: async (command) => {
            commands.push(command);
            return {};
          },
        },
      },
    });
    const storage = loader.loadModule("src/lib/settings/storage.ts");
    const settings = loader.loadModule("src/lib/settings/index.ts");

    const prev = settings.getDefaultSettings();
    const next = mutate(structuredClone(prev));
    await storage.persistSettings(prev, next);
    return commands;
  });
}

test("provider changes mark the config dirty for auto sync", async () => {
  const commands = await invokedCommands((next) => {
    next.customProviders = [
      { id: "p1", name: "P1", baseUrl: "https://example.test", apiKey: "k", models: [] },
    ];
    return next;
  });

  assert.ok(commands.includes("settings_save_providers"), "供应商本身应被保存");
  assert.ok(commands.includes("settings_backup_mark_dirty"), "供应商变更应触发标脏");
});

test("skills changes mark the config dirty even though they never hit SQLite", async () => {
  const commands = await invokedCommands((next) => {
    next.skills = { ...next.skills, enabled: ["some-skill"] };
    return next;
  });

  // skills 只写 localStorage，后端侧的标脏看不到它 —— 必须由前端显式通知。
  assert.ok(commands.includes("settings_backup_mark_dirty"), "技能变更应触发标脏");
});

test("changes outside the backup scope do not mark the config dirty", async () => {
  const commands = await invokedCommands((next) => {
    next.theme = next.theme === "dark" ? "light" : "dark";
    next.locale = next.locale === "en" ? "zh-CN" : "en";
    return next;
  });

  assert.ok(
    !commands.includes("settings_backup_mark_dirty"),
    "主题/语言不在备份范围内，不应触发同步上传",
  );
});
