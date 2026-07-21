import type { SystemToolRuntimeScope } from "./systemToolOptions";

/**
 * Display-only catalog of the built-in tools registered by the agent runtime.
 * This file is mirrored byte-for-byte between agent-gui and agent-gateway/web
 * (see scripts/mirror-manifest.json), so it must stay pure data: no runtime
 * bundle imports (the WebUI tree does not have them). It is intentionally
 * separate from SYSTEM_TOOL_OPTIONS, which doubles as the persistence
 * whitelist for selectedSystemTools.
 */

export type BuiltinToolCategoryId =
  | "fs"
  | "process"
  | "intelligence"
  | "automation"
  | "connectivity";

export type ToolCatalogIconId =
  | "fileText"
  | "image"
  | "filePen"
  | "pencil"
  | "trash"
  | "list"
  | "folderTree"
  | "search"
  | "terminal"
  | "radio"
  | "scrollText"
  | "skill"
  | "brain"
  | "bot"
  | "messageSquare"
  | "clock"
  | "mcp"
  | "globe"
  | "server"
  | "plug"
  | "wrench"
  | "checklist"
  | "circleHelp";

export type BuiltinToolCatalogEntry = {
  /** Catalog id (snake_case). Used for React keys and i18n key derivation. */
  id: string;
  /** Runtime registration name shown as the tool identifier. */
  toolName: string;
  icon: ToolCatalogIconId;
  categoryId: BuiltinToolCategoryId;
  isReadOnly: boolean;
  runtimeScopes: readonly SystemToolRuntimeScope[];
  /** Registered only when its feature is enabled/associated (shown as a hint). */
  conditional?: boolean;
};

export type BuiltinToolCategory = {
  id: BuiltinToolCategoryId;
  icon: ToolCatalogIconId;
  labelKey: string;
};

export const BUILTIN_TOOL_CATEGORIES: readonly BuiltinToolCategory[] = [
  { id: "fs", icon: "folderTree", labelKey: "settings.builtinToolCategory.fs" },
  { id: "process", icon: "terminal", labelKey: "settings.builtinToolCategory.process" },
  { id: "intelligence", icon: "brain", labelKey: "settings.builtinToolCategory.intelligence" },
  { id: "automation", icon: "clock", labelKey: "settings.builtinToolCategory.automation" },
  { id: "connectivity", icon: "plug", labelKey: "settings.builtinToolCategory.connectivity" },
];

const CHAT_AND_CRON: readonly SystemToolRuntimeScope[] = ["chat", "cron_auto_prompt"];
const CHAT_ONLY: readonly SystemToolRuntimeScope[] = ["chat"];

export const BUILTIN_TOOL_CATALOG: readonly BuiltinToolCatalogEntry[] = [
  /* ── File system ── */
  {
    id: "read",
    toolName: "Read",
    icon: "fileText",
    categoryId: "fs",
    isReadOnly: true,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "image",
    toolName: "Image",
    icon: "image",
    categoryId: "fs",
    isReadOnly: true,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "write",
    toolName: "Write",
    icon: "filePen",
    categoryId: "fs",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "edit",
    toolName: "Edit",
    icon: "pencil",
    categoryId: "fs",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "delete",
    toolName: "Delete",
    icon: "trash",
    categoryId: "fs",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "list",
    toolName: "List",
    icon: "list",
    categoryId: "fs",
    isReadOnly: true,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "glob",
    toolName: "Glob",
    icon: "folderTree",
    categoryId: "fs",
    isReadOnly: true,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "grep",
    toolName: "Grep",
    icon: "search",
    categoryId: "fs",
    isReadOnly: true,
    runtimeScopes: CHAT_AND_CRON,
  },
  /* ── Terminal & processes ── */
  {
    id: "bash",
    toolName: "Bash",
    icon: "terminal",
    categoryId: "process",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "managed_process",
    toolName: "ManagedProcess",
    icon: "radio",
    categoryId: "process",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "read_terminal",
    toolName: "ReadTerminal",
    icon: "scrollText",
    categoryId: "process",
    isReadOnly: true,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  /* ── Intelligence & memory ── */
  {
    id: "skills_manager",
    toolName: "SkillsManager",
    icon: "skill",
    categoryId: "intelligence",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
    conditional: true,
  },
  {
    id: "memory_manager",
    toolName: "MemoryManager",
    icon: "brain",
    categoryId: "intelligence",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "agent",
    toolName: "Agent",
    icon: "bot",
    categoryId: "intelligence",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "send_message",
    toolName: "SendMessage",
    icon: "messageSquare",
    categoryId: "intelligence",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "todo_write",
    toolName: "TodoWrite",
    icon: "checklist",
    categoryId: "intelligence",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "ask_user_question",
    toolName: "AskUserQuestion",
    icon: "circleHelp",
    categoryId: "intelligence",
    isReadOnly: true,
    runtimeScopes: CHAT_ONLY,
  },
  /* ── Automation ── */
  {
    id: "cron_task_manager",
    toolName: "CronTaskManager",
    icon: "clock",
    categoryId: "automation",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
  },
  /* ── Connectivity & integrations ── */
  {
    id: "mcp_manager",
    toolName: "McpManager",
    icon: "mcp",
    categoryId: "connectivity",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
  },
  {
    id: "tunnel_manager",
    toolName: "TunnelManager",
    icon: "globe",
    categoryId: "connectivity",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "ssh_manager",
    toolName: "SSHManager",
    icon: "server",
    categoryId: "connectivity",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
];

export type CustomToolPresentation = {
  icon: ToolCatalogIconId;
  isReadOnly: boolean;
  nameKey: string;
  descKey: string;
  detailKey: string;
};

/**
 * Presentation metadata for selectable custom system tools. The runtime
 * definitions in customSystemTools.ts stay untouched (their exports are
 * asserted by tests); entries missing here fall back to the option's raw
 * label/description.
 */
export const CUSTOM_TOOL_PRESENTATION: Record<string, CustomToolPresentation> = {
  http_get_test: {
    icon: "globe",
    isReadOnly: true,
    nameKey: "settings.customTool.http_get_test.name",
    descKey: "settings.customTool.http_get_test.desc",
    detailKey: "settings.customTool.http_get_test.detail",
  },
};
