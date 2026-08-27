import type { SystemToolRuntimeScope } from "./systemToolOptions";

/**
 * Agent runtime 内置工具的纯展示目录。该共享模块必须保持纯数据，不得导入
 * WebUI 不具备的桌面 runtime bundle。
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
  /**
   * 无显式配置时的审批缺省。绝大多数内置工具缺省 allow(字段缺省);与
   * agent-gui resolveToolPolicy 的缺省分支保持一致——设置页据此展示真实
   * 缺省值,并在用户选中缺省值时删除显式键(选非缺省值则显式写入)。
   */
  defaultPolicy?: "ask" | "deny";
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
    id: "process_wait",
    toolName: "ProcessWait",
    icon: "terminal",
    categoryId: "process",
    isReadOnly: true,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "process_stop",
    toolName: "ProcessStop",
    icon: "terminal",
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
    id: "task_create",
    toolName: "TaskCreate",
    icon: "checklist",
    categoryId: "intelligence",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "task_update",
    toolName: "TaskUpdate",
    icon: "checklist",
    categoryId: "intelligence",
    isReadOnly: false,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "task_list",
    toolName: "TaskList",
    icon: "checklist",
    categoryId: "intelligence",
    isReadOnly: true,
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
  {
    id: "exit_plan_mode",
    toolName: "ExitPlanMode",
    icon: "checklist",
    categoryId: "intelligence",
    isReadOnly: true,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
  },
  {
    id: "tool_search",
    toolName: "ToolSearch",
    icon: "search",
    categoryId: "connectivity",
    isReadOnly: true,
    runtimeScopes: CHAT_ONLY,
    conditional: true,
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
    id: "browser",
    toolName: "Browser",
    icon: "globe",
    categoryId: "connectivity",
    isReadOnly: false,
    runtimeScopes: CHAT_AND_CRON,
    conditional: true,
    // 与 resolveToolPolicy 的 group:browser 缺省 ask 分支同步。
    defaultPolicy: "ask",
  },
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
