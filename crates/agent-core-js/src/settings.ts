export type AppSettings = any;
export type ProviderId = string;
export type SelectedModel = any;
export type ExecutionMode = string;
export type ChatRuntimeControls = any;

export function isAgentDevMode(mode: any): boolean {
  return false;
}

export function isAgentExecutionMode(mode: any): boolean {
  return false;
}

export function workspaceProjectPathKey(path: string): string {
  return path;
}

export function updateMemorySettings(prev: AppSettings, updates: any): AppSettings {
  return prev;
}

export function updateSkills(prev: AppSettings, updates: any): AppSettings {
  return prev;
}

export function getSshProjectHostIds(ssh: any, key: string): string[] {
  return [];
}
