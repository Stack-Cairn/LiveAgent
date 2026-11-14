import {
  Blend,
  Bot,
  Brain,
  Cable,
  CalendarDays,
  Clock3,
  Cpu,
  FolderOpen,
  FolderTree,
  GitBranch,
  ImageIcon,
  MessageSquare,
  MessageSquareText,
  MonitorSmartphone,
  Moon,
  PanelLeft,
  PanelRightOpen,
  Pin,
  Settings,
  Square,
  SquarePen,
  Sun,
  Waypoints,
} from "../../components/IconSet";
import type { SidebarShortcutId } from "../settings/sidebarShortcuts";
import { getNextTheme } from "../settings/themeAndMemory";
import type { Theme } from "../settings/types";
import { formatPaletteActionShortcut } from "../shortcuts/shortcutCommands";
import type { ConversationViewId } from "../trajectory/conversationViewState";
import type { CommandPaletteAction } from "./commandPalette";

export type CommandPaletteSettingsSection = { id: string; labelKey: string };

/** Settings sections every host renders (labels live in the shared catalog). */
export const SHARED_COMMAND_PALETTE_SETTINGS_SECTIONS: readonly CommandPaletteSettingsSection[] = [
  { id: "system", labelKey: "settings.navSystem" },
  { id: "providers", labelKey: "settings.navProviders" },
  { id: "agents", labelKey: "settings.navAgents" },
  { id: "skills", labelKey: "settings.navSkills" },
  { id: "mcp", labelKey: "settings.navMcp" },
  { id: "memory", labelKey: "settings.navMemory" },
  { id: "systemTools", labelKey: "settings.navSystemTools" },
  { id: "webSearch", labelKey: "settings.navWebSearch" },
  { id: "stt", labelKey: "settings.navStt" },
  { id: "hooks", labelKey: "settings.navHooks" },
  { id: "cron", labelKey: "settings.navCron" },
  { id: "ssh", labelKey: "settings.navSsh" },
  { id: "remote", labelKey: "settings.navRemote" },
];

const RESOURCE_HUB_ITEMS: readonly {
  id: SidebarShortcutId;
  labelKey: string;
  icon: CommandPaletteAction["icon"];
}[] = [
  { id: "skills", labelKey: "settings.navSkills", icon: Blend },
  { id: "mcp", labelKey: "settings.navMcp", icon: Cable },
  { id: "cron", labelKey: "settings.navCron", icon: Clock3 },
  { id: "planning", labelKey: "settings.navPlanning", icon: CalendarDays },
  { id: "image-studio", labelKey: "settings.navImageStudio", icon: ImageIcon },
  { id: "memory", labelKey: "settings.navMemory", icon: Brain },
];

export type CommandPaletteModelOption = {
  value: string;
  label: string;
  providerName: string;
};

/**
 * Every field is optional: a host only passes the handlers it already has, and
 * only those actions are listed. Nothing here talks to a backend directly.
 */
export type BuildCommandPaletteActionsInput = {
  t: (key: string) => string;
  isMac: boolean;
  onNewConversation?: () => void;
  onOpenWorkspace?: () => void;
  onOpenSettings?: (section?: string) => void;
  settingsSections?: readonly CommandPaletteSettingsSection[];
  sidebar?: { open: boolean; onToggle: () => void };
  theme?: { current: Theme; onToggle: () => void };
  /** Right-hand project tools dock (terminal / file tree / Git review). */
  projectTools?: {
    open: boolean;
    onToggle: () => void;
    onOpenTool?: (tool: "fileTree" | "gitReview") => void;
  };
  resourceHubs?: {
    visible: Readonly<Partial<Record<SidebarShortcutId, boolean>>>;
    onOpen: (id: SidebarShortcutId) => void;
  };
  conversationView?: {
    active: ConversationViewId;
    onChange: (view: ConversationViewId) => void;
  };
  executionMode?: { isAgent: boolean; onSelect: (mode: "text" | "tools") => void };
  models?: {
    options: readonly CommandPaletteModelOption[];
    selectedValue?: string;
    onSelect: (value: string) => void;
  };
  onStopRun?: () => void;
  windowPin?: { pinned?: boolean; onToggle: () => void };
};

function format(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

export function buildCommandPaletteActions(
  input: BuildCommandPaletteActionsInput,
): CommandPaletteAction[] {
  const { t } = input;
  const actions: CommandPaletteAction[] = [];

  if (input.onNewConversation) {
    actions.push({
      id: "new-conversation",
      group: "suggested",
      label: t("chat.newConversation"),
      keywords: ["new chat", "create", "conversation"],
      icon: SquarePen,
      run: input.onNewConversation,
    });
  }
  if (input.onOpenSettings) {
    const openSettings = input.onOpenSettings;
    actions.push({
      id: "open-settings",
      group: "suggested",
      label: t("chat.commandPalette.openSettings"),
      keywords: ["settings", "preferences", "options"],
      icon: Settings,
      run: () => openSettings(),
    });
  }
  if (input.onStopRun) {
    actions.push({
      id: "stop-run",
      group: "suggested",
      label: t("chat.commandPalette.stopRun"),
      keywords: ["stop", "cancel", "abort"],
      icon: Square,
      run: input.onStopRun,
    });
  }
  if (input.onOpenWorkspace) {
    actions.push({
      id: "open-workspace",
      group: "suggested",
      label: t("chat.workspaceCreate"),
      keywords: ["workspace", "project", "folder", "open", "clone"],
      icon: FolderOpen,
      run: input.onOpenWorkspace,
    });
  }

  if (input.resourceHubs) {
    const { visible, onOpen } = input.resourceHubs;
    for (const hub of RESOURCE_HUB_ITEMS) {
      if (visible[hub.id] === false) continue;
      actions.push({
        id: `hub:${hub.id}`,
        group: "navigation",
        label: t(hub.labelKey),
        keywords: ["go to", "open", hub.id],
        icon: hub.icon,
        run: () => onOpen(hub.id),
      });
    }
  }

  if (input.sidebar) {
    const { open, onToggle } = input.sidebar;
    actions.push({
      id: "toggle-sidebar",
      group: "view",
      label: open ? t("sidebar.closeSidebar") : t("tooltip.openSidebar"),
      keywords: ["toggle sidebar", "hide", "show", "panel"],
      icon: PanelLeft,
      run: onToggle,
    });
  }
  if (input.projectTools) {
    const { open, onToggle, onOpenTool } = input.projectTools;
    actions.push({
      id: "toggle-project-tools",
      group: "view",
      label: open ? t("projectTools.collapsePanel") : t("projectTools.expandPanel"),
      keywords: ["toggle", "terminal", "project tools", "dock", "panel"],
      icon: PanelRightOpen,
      run: onToggle,
    });
    if (onOpenTool) {
      const openTool = t("chat.commandPalette.openTool");
      actions.push(
        {
          id: "open-file-tree",
          group: "view",
          label: format(openTool, { name: t("projectTools.fileTreeTitle") }),
          keywords: ["files", "explorer", "file tree"],
          icon: FolderTree,
          run: () => onOpenTool("fileTree"),
        },
        {
          id: "open-git-review",
          group: "view",
          label: format(openTool, { name: t("projectTools.gitReviewTitle") }),
          keywords: ["git", "diff", "changes", "review", "commit"],
          icon: GitBranch,
          run: () => onOpenTool("gitReview"),
        },
      );
    }
  }
  if (input.conversationView) {
    const { active, onChange } = input.conversationView;
    const next: ConversationViewId = active === "conversation" ? "trajectory" : "conversation";
    actions.push({
      id: "switch-conversation-view",
      group: "view",
      label: format(t("chat.commandPalette.showView"), {
        name: t(`trajectory.tab.${next}`),
      }),
      keywords: ["view", "trajectory", "conversation", "timeline"],
      icon: next === "trajectory" ? Waypoints : MessageSquareText,
      run: () => onChange(next),
    });
  }
  if (input.theme) {
    const next = getNextTheme(input.theme.current);
    actions.push({
      id: "toggle-theme",
      group: "view",
      label:
        next === "light"
          ? t("tooltip.switchToLight")
          : next === "dark"
            ? t("tooltip.switchToDark")
            : t("tooltip.switchToAuto"),
      keywords: ["theme", "appearance", "dark", "light", "auto"],
      icon: next === "light" ? Sun : next === "dark" ? Moon : MonitorSmartphone,
      run: input.theme.onToggle,
    });
  }
  if (input.windowPin) {
    actions.push({
      id: "toggle-window-pin",
      group: "view",
      label: t("chat.commandPalette.toggleWindowPin"),
      keywords: ["pin", "always on top", "float", "window"],
      icon: Pin,
      active: input.windowPin.pinned,
      run: input.windowPin.onToggle,
    });
  }

  if (input.onOpenSettings) {
    const openSettings = input.onOpenSettings;
    const sectionTemplate = t("chat.commandPalette.openSettingsSection");
    for (const section of input.settingsSections ?? SHARED_COMMAND_PALETTE_SETTINGS_SECTIONS) {
      actions.push({
        id: `settings:${section.id}`,
        group: "settings",
        label: format(sectionTemplate, { section: t(section.labelKey) }),
        keywords: ["settings", section.id],
        icon: Settings,
        // Sections are reachable by typing; the home screen keeps one entry.
        searchOnly: true,
        run: () => openSettings(section.id),
      });
    }
  }

  if (input.executionMode) {
    const { isAgent, onSelect } = input.executionMode;
    actions.push({
      id: "switch-execution-mode",
      group: "models",
      label: isAgent
        ? t("chat.commandPalette.switchToChatMode")
        : t("chat.commandPalette.switchToAgentMode"),
      keywords: ["mode", "agent", "chat", "tools", "text"],
      icon: isAgent ? MessageSquare : Bot,
      run: () => onSelect(isAgent ? "text" : "tools"),
    });
  }
  if (input.models) {
    const { options, selectedValue, onSelect } = input.models;
    const modelTemplate = t("chat.commandPalette.switchModel");
    for (const option of options) {
      actions.push({
        id: `model:${option.value}`,
        group: "models",
        label: format(modelTemplate, { model: `${option.providerName} / ${option.label}` }),
        keywords: ["model", "switch model", option.value],
        icon: Cpu,
        active: option.value === selectedValue,
        searchOnly: true,
        run: () => onSelect(option.value),
      });
    }
  }

  return withCommandShortcuts(actions, input.isMac);
}

/** Fills each row's shortcut hint from the shortcut table (user overrides included). */
export function withCommandShortcuts(
  actions: CommandPaletteAction[],
  isMac: boolean,
): CommandPaletteAction[] {
  return actions.map((action) => {
    if (action.shortcut) return action;
    const shortcut = formatPaletteActionShortcut(action.id, isMac);
    return shortcut ? { ...action, shortcut } : action;
  });
}
