import { invoke } from "@tauri-apps/api/core";
import { normalizeLocale, type Locale } from "../../i18n/config";

import {
  getDefaultSettings,
  normalizeSelectedModel,
  normalizeSettings,
  normalizeChatRuntimeControls,
  type ChatRuntimeControls,
  normalizeSkillsSettings,
  normalizeUpdateSettings,
  normalizeTheme,
  type AppSettings,
  type SelectedModel,
  type SkillsSettings,
  type Theme,
} from "./index";
import { buildGatewaySettingsSyncPayload } from "./sync";

const LOCAL_UI_SETTINGS_STORAGE_KEY = "liveagent.ui-settings.v1";

type PersistedSettingsResponse = {
  providers?: unknown | null;
  system?: unknown | null;
  mcp?: unknown | null;
  agents?: unknown | null;
  hooks?: unknown | null;
  cron?: unknown | null;
  remote?: unknown | null;
  memory?: unknown | null;
  defaultWorkdir?: unknown | null;
};

type LocalUiSettings = {
  skills?: unknown;
  chatRuntimeControls?: unknown;
  customSettings?: unknown;
  updates?: unknown;
  selectedModel?: unknown;
  theme?: unknown;
  locale?: unknown;
};

export type SettingsSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

function readLocalUiSettings(): {
  skills: SkillsSettings;
  chatRuntimeControls: ChatRuntimeControls;
  customSettings: AppSettings["customSettings"];
  updates: AppSettings["updates"];
  selectedModel?: SelectedModel;
  theme: Theme;
  locale: Locale;
} {
  const defaults = getDefaultSettings();

  function normalizeLocalCustomSettings(input: unknown): AppSettings["customSettings"] {
    const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    return {
      conversationTitleModel: normalizeSelectedModel(obj.conversationTitleModel),
    };
  }

  try {
    const raw = localStorage.getItem(LOCAL_UI_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        skills: defaults.skills,
        chatRuntimeControls: defaults.chatRuntimeControls,
        customSettings: defaults.customSettings,
        updates: defaults.updates,
        selectedModel: defaults.selectedModel,
        theme: defaults.theme,
        locale: defaults.locale,
      };
    }

    const parsed = JSON.parse(raw) as LocalUiSettings | null;
    return {
      skills: normalizeSkillsSettings(parsed?.skills ?? defaults.skills),
      chatRuntimeControls: normalizeChatRuntimeControls(
        parsed?.chatRuntimeControls ?? defaults.chatRuntimeControls,
      ),
      customSettings: normalizeLocalCustomSettings(
        parsed?.customSettings ?? defaults.customSettings,
      ),
      updates: normalizeUpdateSettings(parsed?.updates ?? defaults.updates),
      selectedModel: normalizeSelectedModel(parsed?.selectedModel),
      theme: normalizeTheme(parsed?.theme ?? defaults.theme),
      locale: normalizeLocale(parsed?.locale ?? defaults.locale),
    };
  } catch {
    return {
      skills: defaults.skills,
      chatRuntimeControls: defaults.chatRuntimeControls,
      customSettings: defaults.customSettings,
      updates: defaults.updates,
      selectedModel: defaults.selectedModel,
      theme: defaults.theme,
      locale: defaults.locale,
    };
  }
}

function writeLocalUiSettings(settings: Pick<AppSettings, "skills" | "chatRuntimeControls" | "customSettings" | "updates" | "selectedModel" | "theme" | "locale">) {
  const payload = {
    skills: settings.skills,
    chatRuntimeControls: settings.chatRuntimeControls,
    customSettings: settings.customSettings,
    updates: settings.updates,
    selectedModel: settings.selectedModel,
    theme: settings.theme,
    locale: settings.locale,
  };
  localStorage.setItem(LOCAL_UI_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
}

function stableStringify(value: unknown) {
  return JSON.stringify(value);
}

function hasChanged(prev: unknown, next: unknown) {
  return stableStringify(prev) !== stableStringify(next);
}

function normalizeDefaultWorkdir(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function applyDefaultWorkdirToSystem(system: unknown, defaultWorkdir: string): unknown {
  if (!defaultWorkdir) return system;
  const obj =
    system && typeof system === "object" && !Array.isArray(system)
      ? { ...(system as Record<string, unknown>) }
      : {};
  const workdir = typeof obj.workdir === "string" ? obj.workdir.trim() : "";
  if (!workdir) {
    obj.workdir = defaultWorkdir;
  }
  return obj;
}

export type PersistedSettingsLoadResult = {
  settings: AppSettings;
  defaultWorkdir: string;
};

export async function loadPersistedSettingsWithDefaults(): Promise<PersistedSettingsLoadResult> {
  const defaults = getDefaultSettings();
  const localUi = readLocalUiSettings();
  const persisted = await invoke<PersistedSettingsResponse>("settings_load_all");
  const defaultWorkdir = normalizeDefaultWorkdir(persisted?.defaultWorkdir);

  const settings = normalizeSettings({
    system: applyDefaultWorkdirToSystem(
      persisted?.system ?? defaults.system,
      defaultWorkdir,
    ) as AppSettings["system"],
    customProviders: (persisted?.providers ?? defaults.customProviders) as AppSettings["customProviders"],
    mcp: (persisted?.mcp ?? defaults.mcp) as AppSettings["mcp"],
    agents: (persisted?.agents ?? defaults.agents) as AppSettings["agents"],
    hooks: (persisted?.hooks ?? defaults.hooks) as AppSettings["hooks"],
    cron: (persisted?.cron ?? defaults.cron) as AppSettings["cron"],
    remote: (persisted?.remote ?? defaults.remote) as AppSettings["remote"],
    memory: (persisted?.memory ?? defaults.memory) as AppSettings["memory"],
    skills: localUi.skills,
    chatRuntimeControls: localUi.chatRuntimeControls,
    customSettings: localUi.customSettings,
    updates: localUi.updates,
    selectedModel: localUi.selectedModel,
    theme: localUi.theme,
    locale: localUi.locale,
  });

  return { settings, defaultWorkdir };
}

export async function loadPersistedSettings(): Promise<AppSettings> {
  return (await loadPersistedSettingsWithDefaults()).settings;
}

export async function persistSettings(prev: AppSettings, next: AppSettings): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (hasChanged(prev.customProviders, next.customProviders)) {
    tasks.push(
      invoke("settings_save_providers", {
        payload: next.customProviders,
      } as any),
    );
  }

  if (hasChanged(prev.system, next.system)) {
    tasks.push(
      invoke("settings_save_system", {
        payload: next.system,
      } as any),
    );
  }

  if (hasChanged(prev.mcp, next.mcp)) {
    tasks.push(
      invoke("settings_save_mcp", {
        payload: next.mcp,
      } as any),
    );
  }

  if (hasChanged(prev.agents, next.agents)) {
    tasks.push(
      invoke("settings_save_agents", {
        payload: next.agents,
      } as any),
    );
  }

  if (hasChanged(prev.hooks, next.hooks)) {
    tasks.push(
      invoke("settings_save_hooks", {
        payload: next.hooks,
      } as any),
    );
  }

  if (hasChanged(prev.cron, next.cron)) {
    tasks.push(
      invoke("settings_save_cron", {
        payload: next.cron,
      } as any),
    );
  }

  if (hasChanged(prev.remote, next.remote)) {
    tasks.push(
      invoke("settings_save_remote", {
        payload: next.remote,
      } as any),
    );
  }

  if (hasChanged(prev.memory, next.memory)) {
    tasks.push(
      invoke("settings_save_memory", {
        payload: next.memory,
      } as any),
    );
  }

  if (
    hasChanged(prev.skills, next.skills) ||
    hasChanged(prev.chatRuntimeControls, next.chatRuntimeControls) ||
    hasChanged(prev.customSettings, next.customSettings) ||
    hasChanged(prev.updates, next.updates) ||
    hasChanged(prev.selectedModel ?? null, next.selectedModel ?? null) ||
    hasChanged(prev.theme, next.theme) ||
    hasChanged(prev.locale, next.locale)
  ) {
    writeLocalUiSettings({
      skills: next.skills,
      chatRuntimeControls: next.chatRuntimeControls,
      customSettings: next.customSettings,
      updates: next.updates,
      selectedModel: next.selectedModel,
      theme: next.theme,
      locale: next.locale,
    });
  }

  await Promise.all(tasks);
}

export async function publishGatewaySettingsSync(settings: AppSettings): Promise<void> {
  await invoke("gateway_publish_settings_sync", {
    payload: buildGatewaySettingsSyncPayload(settings),
  } as any);
}
