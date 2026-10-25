export type KBrainSettingsProvider = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  activeModels: string[];
  models: KBrainSettingsModel[];
};

export type KBrainSettingsModel = {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
};

export type AIApprovalConfig = {
  mode: "off" | "risk_only" | "auto";
  provider?: string;
  model?: string;
};

/** K-brain memory master switch; absent on backends without `capabilities.memory_switch`. */
export type KBrainMemoryConfig = { enabled: boolean };

export type KBrainSettingsDocument = {
  aiApproval?: AIApprovalConfig;
  computer?: KBrainComputerConfig;
  memory?: KBrainMemoryConfig;
  mode: "kbrain";
  defaultModel: string;
  defaultProvider: string;
  providers: KBrainSettingsProvider[];
  models: KBrainSettingsModel[];
};

export type KBrainComputerConfig = {
  enabled?: boolean;
  backend?: string;
  command?: string[];
  approvalPolicy?: "ask" | "allow" | "deny";
  allow?: string[];
  deny?: string[];
  defaultDeny?: boolean;
};

export type KBrainComputerStatus = {
  executionOwner: "kbrain";
  backend: string;
  enabled: boolean;
  installed: boolean;
  platform: string;
  driverVersion?: string;
  message?: string;
  permissionsVerified?: boolean;
};

export type KBrainRuntimeConnection = {
  baseUrl: string;
  token: string;
};

export type KBrainSettingsAdapter = {
  isKbrain: true;
  runtimeConnection: () => KBrainRuntimeConnection | null;
  getConnection: () => KBrainRuntimeConnection | null;
  getSettings: () => Promise<KBrainSettingsDocument>;
  updateSettings: (update: unknown) => Promise<KBrainSettingsDocument>;
  getComputerStatus?: () => Promise<KBrainComputerStatus>;
  /** `/v1/health` capabilities; hosts that cannot reach it rely on the settings document. */
  getCapabilities?: () => Promise<Record<string, unknown>>;
};

export type SettingsHostAdapter = {
  isKbrain: boolean;
  runtimeConnection?: () => KBrainRuntimeConnection | null;
  kbrain?: KBrainSettingsAdapter;
};
