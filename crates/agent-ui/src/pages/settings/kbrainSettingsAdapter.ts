import type { WorkspaceFolderTrustClient } from "@liveagent/ui/contracts/workspaceFolderTrust";
import type { KBrainHealth } from "@liveagent/ui/lib/kbrain/health";
import type { PluginsClient } from "@liveagent/ui/lib/plugins/types";
import type { KBrainWebSearchSettings } from "@liveagent/ui/lib/providers/webSearchFallback";
import type { UsageStatsAnswer, UsageStatsQuery } from "@liveagent/ui/lib/usage/usageStats";
export type KBrainSettingsProvider = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  /** Read-only (capability web_search_fallback): the provider's API searches natively. */
  nativeWebSearchSupported?: boolean;
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
  /**
   * Read-only, from backends with `capabilities.ai_review_per_run`: the composer's permission
   * mode decides when to review and auto review falls back to the session's model, so hosts
   * hide the global setting. provider/model then only override the reviewer. Never sent back.
   */
  perRun?: boolean;
};

/** K-brain memory master switch; absent on backends without `capabilities.memory_switch`. */
export type KBrainMemoryConfig = { enabled: boolean };

/**
 * K-brain's memory organizer schedule (whole hours, 1–168); absent on backends without
 * `capabilities.memory_organizer_settings`. K-brain applies a change at once.
 */
export type KBrainMemoryOrganizerConfig = { enabled: boolean; intervalHours: number };

export type KBrainSettingsDocument = {
  aiApproval?: AIApprovalConfig;
  computer?: KBrainComputerConfig;
  memory?: KBrainMemoryConfig;
  memoryOrganizer?: KBrainMemoryOrganizerConfig;
  /**
   * The web search fallback service; absent on backends without
   * `capabilities.web_search_fallback`. Never carries the API key. Read it with
   * readWebSearchSettings, which checks the shape.
   */
  webSearch?: KBrainWebSearchSettings;
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

export type PermissionRuleScope = "session" | "project" | "user";
export type PermissionRuleEffect = "allow" | "deny";

/** One remembered rule from K-brain `/v1/permissions/rules`. */
export type PermissionRule = {
  id: string;
  rule: string;
  effect: PermissionRuleEffect;
  scope: PermissionRuleScope;
  createdAt?: string;
  sourceSession?: string;
};

export type PermissionRuleList = { projectRoot?: string; rules: PermissionRule[] };

/** A rule to add; `workspace` names the project for project scope. */
export type PermissionRuleInput = {
  rule: string;
  effect: PermissionRuleEffect;
  scope: "project" | "user";
  workspace?: string;
};

export type PermissionRuleRef = { id: string; scope: PermissionRuleScope; workspace?: string };

export type KBrainSettingsAdapter = {
  isKbrain: true;
  runtimeConnection: () => KBrainRuntimeConnection | null;
  getConnection: () => KBrainRuntimeConnection | null;
  getSettings: () => Promise<KBrainSettingsDocument>;
  updateSettings: (update: unknown) => Promise<KBrainSettingsDocument>;
  getComputerStatus?: () => Promise<KBrainComputerStatus>;
  /** `/v1/health` capabilities; hosts that cannot reach it rely on the settings document. */
  getCapabilities?: () => Promise<Record<string, unknown>>;
  /** Parsed `/v1/health` handshake for diagnostics; only hosts talking to K-brain directly provide it. */
  getHealth?: () => Promise<KBrainHealth>;
  /**
   * K-brain permission rules (`capabilities.permission_rules`). Lists all-project rules and,
   * with `workspace`, that project's rules. Hosts that cannot reach the rules API leave
   * these out and Settings hides the page.
   */
  listPermissionRules?: (query: { workspace?: string }) => Promise<PermissionRuleList>;
  addPermissionRule?: (input: PermissionRuleInput) => Promise<PermissionRule>;
  deletePermissionRule?: (ref: PermissionRuleRef) => Promise<void>;
  /**
   * Read-only cross-session token usage (`GET /v1/usage/stats`). Answers
   * `{ available: false }` when K-brain lacks `capabilities.usage_stats`. Hosts that
   * cannot reach it leave this out and Settings hides the page.
   */
  getUsageStats?: (query: UsageStatsQuery) => Promise<UsageStatsAnswer>;
  /**
   * K-brain plugins (`capabilities.plugins`). Only hosts that talk to K-brain directly
   * provide it; Settings shows the Plugins page when the capability is advertised.
   */
  plugins?: PluginsClient;
  /** Folder trust, offered on the Plugins page when the project folder is not trusted. */
  folderTrust?: WorkspaceFolderTrustClient;
};

export type SettingsHostAdapter = {
  isKbrain: boolean;
  runtimeConnection?: () => KBrainRuntimeConnection | null;
  kbrain?: KBrainSettingsAdapter;
};
