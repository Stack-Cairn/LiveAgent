import { invoke } from "@tauri-apps/api/core";
import { type Locale, normalizeLocale } from "../../i18n/config";

import {
  type AppSettings,
  type ChatRuntimeControls,
  type CloseWindowBehavior,
  getDefaultSettings,
  normalizeChatRuntimeControls,
  normalizeCloseWindowBehavior,
  normalizeFontFamily,
  normalizeFontScaleSettings,
  normalizeRightDockSettings,
  normalizeSelectedModel,
  normalizeSettings,
  normalizeSkillsSettings,
  normalizeTheme,
  normalizeUpdateSettings,
  resolveWorkspaceProjects,
  type SelectedModel,
  type SkillsSettings,
  type Theme,
} from "./index";
import { buildGatewaySettingsSyncPayload, buildGatewaySettingsSyncUpdatePayload } from "./sync";

const LOCAL_UI_SETTINGS_STORAGE_KEY = "liveagent.ui-settings.v1";

type PersistedSettingsResponse = {
  providers?: unknown | null;
  system?: unknown | null;
  mcp?: unknown | null;
  agents?: unknown | null;
  ssh?: unknown | null;
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
  closeWindowBehavior?: unknown;
};

export type SettingsSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

type SshPatchApplyResponse = {
  ssh?: unknown;
  conflict?: string | null;
};

export type PersistSettingsResult = {
  ssh?: AppSettings["ssh"];
  conflict?: string;
};

function readLocalUiSettings(): {
  skills: SkillsSettings;
  chatRuntimeControls: ChatRuntimeControls;
  customSettings: AppSettings["customSettings"];
  updates: AppSettings["updates"];
  selectedModel?: SelectedModel;
  theme: Theme;
  locale: Locale;
  closeWindowBehavior: CloseWindowBehavior;
} {
  const defaults = getDefaultSettings();

  function normalizeLocalCustomSettings(input: unknown): AppSettings["customSettings"] {
    const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const chatSidebar = (
      obj.chatSidebar && typeof obj.chatSidebar === "object" ? obj.chatSidebar : {}
    ) as Record<string, unknown>;
    return {
      conversationTitleModel: normalizeSelectedModel(obj.conversationTitleModel),
      chatSidebar: {
        projectsCollapsed: chatSidebar.projectsCollapsed === true,
        recentCollapsed: chatSidebar.recentCollapsed === true,
      },
      rightDock: normalizeRightDockSettings(obj.rightDock),
      // fontFamily was the single pre-split preference. Read it only to migrate
      // old local settings into the interface-specific field.
      interfaceFontFamily: normalizeFontFamily(obj.interfaceFontFamily ?? obj.fontFamily),
      chatFontFamily: normalizeFontFamily(obj.chatFontFamily),
      codeFontFamily: normalizeFontFamily(obj.codeFontFamily),
      fontScale: normalizeFontScaleSettings(obj.fontScale),
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
        closeWindowBehavior: defaults.closeWindowBehavior,
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
      closeWindowBehavior: normalizeCloseWindowBehavior(
        parsed?.closeWindowBehavior ?? defaults.closeWindowBehavior,
      ),
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
      closeWindowBehavior: defaults.closeWindowBehavior,
    };
  }
}

function writeLocalUiSettings(
  settings: Pick<
    AppSettings,
    | "skills"
    | "chatRuntimeControls"
    | "customSettings"
    | "updates"
    | "selectedModel"
    | "theme"
    | "locale"
    | "closeWindowBehavior"
  >,
) {
  const payload = {
    skills: settings.skills,
    chatRuntimeControls: settings.chatRuntimeControls,
    customSettings: settings.customSettings,
    updates: settings.updates,
    selectedModel: settings.selectedModel,
    theme: settings.theme,
    locale: settings.locale,
    closeWindowBehavior: settings.closeWindowBehavior,
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
    customProviders: (persisted?.providers ??
      defaults.customProviders) as AppSettings["customProviders"],
    mcp: (persisted?.mcp ?? defaults.mcp) as AppSettings["mcp"],
    agents: (persisted?.agents ?? defaults.agents) as AppSettings["agents"],
    ssh: (persisted?.ssh ?? defaults.ssh) as AppSettings["ssh"],
    remote: (persisted?.remote ?? defaults.remote) as AppSettings["remote"],
    memory: (persisted?.memory ?? defaults.memory) as AppSettings["memory"],
    skills: localUi.skills,
    chatRuntimeControls: localUi.chatRuntimeControls,
    customSettings: localUi.customSettings,
    updates: localUi.updates,
    selectedModel: localUi.selectedModel,
    theme: localUi.theme,
    locale: localUi.locale,
    closeWindowBehavior: localUi.closeWindowBehavior,
  });

  return {
    settings: {
      ...settings,
      system: resolveWorkspaceProjects(settings.system, defaultWorkdir),
    },
    defaultWorkdir,
  };
}

export async function loadPersistedSettings(): Promise<AppSettings> {
  return (await loadPersistedSettingsWithDefaults()).settings;
}

export async function persistSettings(
  prev: AppSettings,
  next: AppSettings,
): Promise<PersistSettingsResult> {
  const tasks: Promise<unknown>[] = [];
  const result: PersistSettingsResult = {};

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

  if (hasChanged(prev.ssh, next.ssh)) {
    const update = buildGatewaySettingsSyncUpdatePayload(prev, next, {
      includeProviderApiKeyUpdates: true,
    });
    tasks.push(
      invoke<SshPatchApplyResponse>("settings_apply_ssh_patch", {
        payload: {
          sshPatch: update.sshPatch ?? {},
          sshSecretUpdates: update.sshSecretUpdates,
        },
      } as any).then((response) => {
        if (response?.ssh) {
          result.ssh = normalizeSettings({ ssh: response.ssh as AppSettings["ssh"] }).ssh;
        }
        if (response?.conflict) {
          result.conflict = response.conflict;
        }
      }),
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
    hasChanged(prev.locale, next.locale) ||
    hasChanged(prev.closeWindowBehavior, next.closeWindowBehavior)
  ) {
    writeLocalUiSettings({
      skills: next.skills,
      chatRuntimeControls: next.chatRuntimeControls,
      customSettings: next.customSettings,
      updates: next.updates,
      selectedModel: next.selectedModel,
      theme: next.theme,
      locale: next.locale,
      closeWindowBehavior: next.closeWindowBehavior,
    });
  }

  await Promise.all(tasks);
  return result;
}

export async function publishGatewaySettingsSync(settings: AppSettings): Promise<void> {
  await invoke("gateway_publish_settings_sync", {
    payload: buildGatewaySettingsSyncPayload(settings),
  } as any);
}
