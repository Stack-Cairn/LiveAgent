export type AppSettings = any;
export type ProviderId = string;
export type SelectedModel = any;
export type ExecutionMode = string;
export type ChatRuntimeControls = any;
export type ProviderModelConfig = any;
export type CustomProvider = any;
export type CodexRequestFormat = any;
export type ReasoningLevel = any;

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

export function findProviderModelConfig(provider: any, model: any): any {
  return null;
}

export function getProviderModelDefaults(provider: any, model: any): any {
  return {};
}

export function getChatRuntimeReasoningLevelsForProvider(provider: any): any {
  return [];
}

export function normalizeChatRuntimeControlsForProvider(provider: any, controls: any): any {
  return controls;
}

export type McpSettingsOp = any;
export type SshHostConfig = any;

export function selectEnabledMcpServers(_config: any): any {
  return [];
}
