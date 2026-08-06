import { callBackend } from "../backendClient";

import {
  type AppSettings,
  getDefaultSettings,
  normalizeSettings,
  resolveWorkspaceProjects,
} from "./index";

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
  const persisted = await callBackend<PersistedSettingsResponse>("settings_load_all");
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
    skills: defaults.skills,
    chatRuntimeControls: defaults.chatRuntimeControls,
    customSettings: defaults.customSettings,
    updates: defaults.updates,
    selectedModel: defaults.selectedModel,
    theme: defaults.theme,
    locale: defaults.locale,
    closeWindowBehavior: defaults.closeWindowBehavior,
  });

  return {
    settings: {
      ...settings,
      system: resolveWorkspaceProjects(settings.system, defaultWorkdir),
    },
    defaultWorkdir,
  };
}
