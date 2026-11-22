import { SHORTCUT_COMMANDS } from "../shortcuts/shortcutCommands";

/**
 * Declarative index of individual settings, searched from the settings sidebar
 * and the command palette. Each entry points at one element rendered with
 * `data-settings-anchor="<anchor>"` inside its section, so a result can scroll
 * to the exact row and highlight it.
 *
 * Labels and descriptions reuse the i18n keys the settings rows render, so a
 * result reads exactly like the row it opens. Keywords are extra search terms
 * (English synonyms) that match in every locale.
 */
export type SettingsSearchEntry = {
  /** Settings section id (`SettingsSectionDefinition.id`). */
  section: string;
  /** Value of the target element's `data-settings-anchor`; unique across the index. */
  anchor: string;
  labelKey: string;
  descriptionKey?: string;
  keywords?: readonly string[];
};

/**
 * Rows and sections only one host renders (with i18n keys only that host
 * defines), passed in by the host next to the shared index.
 */
export type SettingsSearchExtension = {
  entries: readonly SettingsSearchEntry[];
  sectionLabelKeys: Readonly<Record<string, string>>;
  /** Shared rows this host does not render (e.g. shortcut commands it lacks). */
  hiddenAnchors?: readonly string[];
};

export const SETTINGS_ANCHOR_ATTRIBUTE = "data-settings-anchor";

/**
 * Labels of the shared settings sections (palette results show them). Hosts
 * add their own sections through `SettingsSearchExtension.sectionLabelKeys`.
 */
export const SETTINGS_SEARCH_SECTION_LABEL_KEYS: Readonly<Record<string, string>> = {
  system: "settings.navSystem",
  providers: "settings.navProviders",
  agents: "settings.navAgents",
  usage: "settings.navUsage",
  skills: "settings.navSkills",
  mcp: "settings.navMcp",
  plugins: "sandboxedUi.plugins.nav",
  planning: "settings.navPlanning",
  memory: "settings.navMemory",
  systemTools: "settings.navSystemTools",
  webSearch: "settings.navWebSearch",
  permissions: "settings.navPermissions",
  stt: "settings.navStt",
  hooks: "settings.navHooks",
  cron: "settings.navCron",
  ssh: "settings.navSsh",
  remote: "settings.navRemote",
  shortcuts: "settings.navShortcuts",
};

const STATIC_ENTRIES: readonly SettingsSearchEntry[] = [
  // System
  {
    section: "system",
    anchor: "execution-mode",
    labelKey: "settings.defaultExecutionMode",
    keywords: ["agent", "chat", "tools", "mode"],
  },
  {
    section: "system",
    anchor: "appearance",
    labelKey: "settings.appearance",
    descriptionKey: "settings.appearanceDesc",
    keywords: ["theme", "dark", "light", "color scheme"],
  },
  {
    section: "system",
    anchor: "language",
    labelKey: "settings.language",
    descriptionKey: "settings.languageDesc",
    keywords: ["locale", "language", "english", "chinese"],
  },
  {
    section: "system",
    anchor: "time-zone",
    labelKey: "settings.defaultTimeZone",
    descriptionKey: "settings.defaultTimeZoneDesc",
    keywords: ["timezone", "clock", "date"],
  },
  {
    section: "system",
    anchor: "expand-process",
    labelKey: "settings.expandProcessByDefault",
    descriptionKey: "settings.expandProcessByDefaultDesc",
    keywords: ["thinking", "tool calls", "collapse", "expand"],
  },
  {
    section: "system",
    anchor: "html-previews",
    labelKey: "settings.htmlPreviews",
    descriptionKey: "settings.htmlPreviewsDesc",
    keywords: ["html", "preview", "sandbox", "page"],
  },
  {
    section: "system",
    anchor: "sidebar-shortcuts",
    labelKey: "settings.sidebarShortcuts",
    keywords: ["sidebar", "skills", "mcp", "cron", "planning"],
  },
  {
    section: "system",
    anchor: "system-proxy",
    labelKey: "settings.systemProxy",
    keywords: ["proxy", "http", "socks", "network"],
  },
  {
    section: "system",
    anchor: "font-family",
    labelKey: "settings.fontFamily",
    keywords: ["font", "typeface", "monospace"],
  },
  {
    section: "system",
    anchor: "font-size",
    labelKey: "settings.fontSize",
    keywords: ["font size", "text size", "scale"],
  },
  // Providers
  {
    section: "providers",
    anchor: "add-provider",
    labelKey: "settings.addProvider",
    keywords: ["api key", "model", "endpoint", "base url"],
  },
  {
    // Opens the dialog with title models, prompt clarification, the context
    // indicator and error retry rules.
    section: "providers",
    anchor: "provider-preferences",
    labelKey: "settings.providerGlobalPreferences",
    descriptionKey: "settings.openCustomSettings",
    keywords: ["title model", "prompt clarify", "context display", "retry", "advanced"],
  },
  // Agents
  {
    section: "agents",
    anchor: "agents-global",
    labelKey: "settings.agentsGlobalTab",
    descriptionKey: "settings.agentsGlobalConfigHint",
    keywords: ["prompt", "system prompt", "instructions"],
  },
  {
    section: "agents",
    anchor: "agents-projects",
    labelKey: "settings.agentsProjectsTab",
    descriptionKey: "chat.projectPromptStrategyHint",
    keywords: ["project", "prompt", "instructions"],
  },
  // Usage
  {
    section: "usage",
    anchor: "usage-stats",
    labelKey: "settings.usage.title",
    keywords: ["tokens", "cost", "statistics"],
  },
  // Skills / MCP
  {
    section: "skills",
    anchor: "skills-hub",
    labelKey: "settings.skillsHubTitle",
    descriptionKey: "settings.skillsHubSubtitle",
    keywords: ["skill", "install", "store"],
  },
  // Plugins
  {
    section: "plugins",
    anchor: "plugins",
    labelKey: "sandboxedUi.plugins.title",
    descriptionKey: "sandboxedUi.plugins.description",
    keywords: ["plugin", "extension", "panel", "install"],
  },
  {
    section: "mcp",
    anchor: "mcp-servers",
    labelKey: "settings.search.entry.mcpServers",
    descriptionKey: "mcpHub.subtitle",
    keywords: ["mcp", "server", "tools", "model context protocol"],
  },
  // Planning
  {
    section: "planning",
    anchor: "planner-sidebar",
    labelKey: "planner.settings.showInSidebar",
    descriptionKey: "planner.settings.showInSidebarHint",
    keywords: ["calendar", "planner", "sidebar"],
  },
  {
    section: "planning",
    anchor: "planner-week-start",
    labelKey: "planner.display.weekStart",
    keywords: ["calendar", "week", "monday", "sunday"],
  },
  {
    section: "planning",
    anchor: "planner-week-numbers",
    labelKey: "planner.display.weekNumbers",
    keywords: ["calendar", "week number"],
  },
  {
    section: "planning",
    anchor: "planner-work-hours",
    labelKey: "planner.settings.workHours",
    keywords: ["calendar", "work hours", "office"],
  },
  {
    section: "planning",
    anchor: "planner-subscriptions",
    labelKey: "planner.subscription.title",
    descriptionKey: "planner.subscription.hint",
    keywords: ["calendar", "ics", "subscribe", "feed"],
  },
  // Memory
  {
    section: "memory",
    anchor: "memory-switch",
    labelKey: "settings.memorySwitchTitle",
    keywords: ["memory", "remember", "recall"],
  },
  // System tools
  {
    section: "systemTools",
    anchor: "ai-approval-mode",
    labelKey: "settings.aiApproval.mode",
    keywords: ["approval", "permission", "auto approve", "review"],
  },
  {
    section: "systemTools",
    anchor: "ai-approval-model",
    labelKey: "settings.aiApproval.model",
    descriptionKey: "settings.aiApproval.modelHint",
    keywords: ["approval", "reviewer", "model"],
  },
  // Web search
  {
    section: "webSearch",
    anchor: "web-search-provider",
    labelKey: "settings.webSearch.provider",
    descriptionKey: "settings.webSearch.providerHint",
    keywords: ["search", "web", "engine"],
  },
  {
    section: "webSearch",
    anchor: "web-search-api-key",
    labelKey: "settings.webSearch.apiKey",
    keywords: ["search", "key", "token"],
  },
  {
    section: "webSearch",
    anchor: "web-search-max-results",
    labelKey: "settings.webSearch.maxResults",
    descriptionKey: "settings.webSearch.maxResultsHint",
    keywords: ["search", "results", "limit"],
  },
  // Permissions
  {
    section: "permissions",
    anchor: "permission-rules",
    labelKey: "settings.permissions.title",
    descriptionKey: "settings.permissions.description",
    keywords: ["allow", "deny", "rules", "permission"],
  },
  // Speech to text
  {
    section: "stt",
    anchor: "stt-enable",
    labelKey: "settings.stt.enable",
    keywords: ["voice", "speech", "dictation", "microphone"],
  },
  {
    section: "stt",
    anchor: "stt-service",
    labelKey: "settings.stt.sectionService",
    keywords: ["voice", "speech", "provider"],
  },
  // Hooks / cron / ssh
  {
    section: "hooks",
    anchor: "hooks-lifecycle",
    labelKey: "settings.search.entry.hooks",
    descriptionKey: "settings.hooksDesc",
    keywords: ["hook", "script", "webhook", "lifecycle"],
  },
  {
    section: "cron",
    anchor: "cron-tasks",
    labelKey: "settings.search.entry.cronTasks",
    descriptionKey: "settings.cronDesc",
    keywords: ["cron", "schedule", "timer", "recurring"],
  },
  {
    section: "ssh",
    anchor: "ssh-hosts",
    labelKey: "settings.search.entry.sshHosts",
    descriptionKey: "settings.sshDesc",
    keywords: ["ssh", "remote host", "server", "key"],
  },
  // Remote access
  {
    section: "remote",
    anchor: "remote-gateway",
    labelKey: "settings.remoteTitle",
    descriptionKey: "settings.remoteDesc",
    keywords: ["remote", "gateway", "web ui", "phone"],
  },
  {
    section: "remote",
    anchor: "remote-managed-local",
    labelKey: "settings.remoteManagedLocal",
    descriptionKey: "settings.remoteManagedLocalHint",
    keywords: ["remote", "gateway", "local"],
  },
  {
    section: "remote",
    anchor: "remote-options",
    labelKey: "settings.remoteOptionsTitle",
    descriptionKey: "settings.remoteOptionsHint",
    keywords: ["remote", "terminal", "git", "tunnel", "reconnect"],
  },
  // Shortcuts (individual commands are generated below)
  {
    section: "shortcuts",
    anchor: "shortcuts-in-app",
    labelKey: "shortcuts.inAppTitle",
    keywords: ["shortcut", "keybinding", "hotkey", "keyboard"],
  },
];

/** Anchor of one in-app shortcut row in the shortcuts section. */
export function shortcutCommandSettingsAnchor(commandId: string): string {
  return `shortcut-${commandId}`;
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  ...STATIC_ENTRIES,
  ...SHORTCUT_COMMANDS.map(
    (command): SettingsSearchEntry => ({
      section: "shortcuts",
      anchor: shortcutCommandSettingsAnchor(command.id),
      labelKey: command.labelKey,
      keywords: ["shortcut", "keybinding", "hotkey"],
    }),
  ),
];

export type SettingsSearchResult = {
  entry: SettingsSearchEntry;
  label: string;
  description: string;
  sectionLabel: string;
  score: number;
};

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Token search: every query token must match the label, description, section
 * label or a keyword. Label hits rank above description / keyword hits, and a
 * label that starts with the query ranks first.
 */
export function searchSettingsIndex(
  query: string,
  options: {
    t: (key: string) => string;
    /** Section ids the shell renders; entries of other sections are skipped. */
    sections: readonly { id: string; labelKey: string }[];
    /** Defaults to the shared index; hosts append their own entries. */
    entries?: readonly SettingsSearchEntry[];
    limit?: number;
  },
): SettingsSearchResult[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(" ");
  const sectionLabels = new Map(options.sections.map((section) => [section.id, section.labelKey]));
  const results: SettingsSearchResult[] = [];
  for (const entry of options.entries ?? SETTINGS_SEARCH_INDEX) {
    const sectionLabelKey = sectionLabels.get(entry.section);
    if (!sectionLabelKey) continue;
    const label = options.t(entry.labelKey);
    const description = entry.descriptionKey ? options.t(entry.descriptionKey) : "";
    const sectionLabel = options.t(sectionLabelKey);
    const haystackLabel = normalize(label);
    const haystackRest = normalize(
      [description, sectionLabel, entry.section, ...(entry.keywords ?? [])].join(" "),
    );
    let score = 0;
    let matched = true;
    for (const token of tokens) {
      if (haystackLabel.includes(token)) score += 10;
      else if (haystackRest.includes(token)) score += 3;
      else {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (haystackLabel.startsWith(normalizedQuery)) score += 20;
    else if (haystackLabel.includes(normalizedQuery)) score += 8;
    results.push({ entry, label, description, sectionLabel, score });
  }
  results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return typeof options.limit === "number" ? results.slice(0, options.limit) : results;
}

/** The shared index plus a host's own rows, minus the shared rows it hides. */
export function settingsSearchEntriesFor(
  host: SettingsSearchExtension | undefined,
): readonly SettingsSearchEntry[] {
  if (!host) return SETTINGS_SEARCH_INDEX;
  const hidden = new Set(host.hiddenAnchors ?? []);
  const shared =
    hidden.size > 0
      ? SETTINGS_SEARCH_INDEX.filter((entry) => !hidden.has(entry.anchor))
      : SETTINGS_SEARCH_INDEX;
  return [...shared, ...host.entries];
}
