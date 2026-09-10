/** Navigation visibility only; these switches never disable the underlying resources. */
export const SIDEBAR_SHORTCUTS = [
  { id: "skills", labelKey: "settings.navSkills" },
  { id: "mcp", labelKey: "settings.navMcp" },
  { id: "cron", labelKey: "settings.navCron" },
  { id: "memory", labelKey: "settings.navMemory" },
] as const;

export type SidebarShortcutId = (typeof SIDEBAR_SHORTCUTS)[number]["id"];
export type SidebarShortcuts = Record<SidebarShortcutId, boolean>;

export function normalizeSidebarShortcuts(input: unknown): SidebarShortcuts {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    skills: value.skills !== false,
    mcp: value.mcp !== false,
    cron: value.cron !== false,
    memory: value.memory !== false,
  };
}
