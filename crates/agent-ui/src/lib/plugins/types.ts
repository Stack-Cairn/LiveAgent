export type PluginRuntimeKind = "wasi-command" | "process" | "declarative";
export type PluginRuntimeScope = "application" | "workspace";
export type PluginLifecyclePhase = "installed" | "blocked" | "active" | "disabled" | "failed";
export type PluginTrustLevel = "integrity_verified" | "unsigned_developer" | "full_trust_process";

export type PluginPublisher = {
  id: string;
  name: string;
  keyId?: string;
};

export type PluginRuntime = {
  kind: PluginRuntimeKind;
  entry?: string;
  command?: string;
  args: string[];
  scope: PluginRuntimeScope;
  timeoutMs: number;
  fuel: number;
};

export type PluginPermissionRequest = {
  id: string;
  paths: string[];
  origins: string[];
  keys: string[];
};

export type PluginToolContribution = {
  id: string;
  modelName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  handler: string;
  readOnly: boolean;
};

export type PluginPromptSectionContribution = {
  id: string;
  content?: string;
  source?: string;
  position?: string;
  maxTokens?: number;
};

export type PluginHookEvent =
  | "agent_start"
  | "turn_start"
  | "message_start"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_end"
  | "turn_end"
  | "agent_end";

export type PluginHookContribution = {
  id: string;
  event: PluginHookEvent;
  observeOnly: boolean;
  handler: string;
  timeoutMs: number;
};

export type PluginSettingsContribution = {
  id: string;
  schema: Record<string, unknown>;
};

export type PluginContributions = {
  tools: PluginToolContribution[];
  promptSections: PluginPromptSectionContribution[];
  hooks: PluginHookContribution[];
  settings: PluginSettingsContribution[];
};

export type PluginInventoryItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: PluginPublisher;
  packageHash: string;
  generation: number;
  runtime: PluginRuntime;
  permissions: PluginPermissionRequest[];
  grantedPermissions: string[];
  contributes: PluginContributions;
  enabled: boolean;
  phase: PluginLifecyclePhase;
  trustLevel: PluginTrustLevel;
  blockedReason?: string;
  lastError?: string;
  installedAt: number;
  updatedAt: number;
  config: Record<string, unknown>;
  configRevision: number;
};

export type PluginSnapshotTool = {
  pluginId: string;
  pluginVersion: string;
  packageHash: string;
  generation: number;
  contribution: PluginToolContribution;
};

export type PluginSnapshotPromptSection = {
  pluginId: string;
  pluginVersion: string;
  packageHash: string;
  generation: number;
  id: string;
  content: string;
  position?: string;
  maxTokens?: number;
};

export type PluginSnapshotHook = {
  pluginId: string;
  pluginVersion: string;
  packageHash: string;
  generation: number;
  contribution: PluginHookContribution;
};

export type PluginTurnSnapshot = {
  revision: string;
  workspace: string;
  tools: PluginSnapshotTool[];
  promptSections: PluginSnapshotPromptSection[];
  hooks: PluginSnapshotHook[];
};

export type PluginInvocationResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError: boolean;
};

export type PluginInstallOptions = {
  allowUnsigned: boolean;
  allowFullTrust: boolean;
  grantedPermissions: string[];
};

export type PluginClient = {
  list: (workspace?: string) => Promise<PluginInventoryItem[]>;
  install: (sourcePath: string, options: PluginInstallOptions) => Promise<PluginInventoryItem>;
  setEnabled: (pluginId: string, enabled: boolean, workspace?: string) => Promise<number>;
  setGrants: (pluginId: string, permissions: string[]) => Promise<number>;
  uninstall: (pluginId: string) => Promise<void>;
  updateConfig: (input: {
    pluginId: string;
    workspace?: string;
    expectedRevision: number;
    config: Record<string, unknown>;
  }) => Promise<number>;
  isReadOnly?: boolean;
  canInstall?: boolean;
};
