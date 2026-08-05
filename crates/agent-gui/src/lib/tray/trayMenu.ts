/**
 * 托盘菜单模型：把 settings/locale/侧栏快照/cron/网关状态组装成
 * Rust `TrayMenuModel`（services/tray.rs）并经 `app_tray_menu_sync` 推送。
 *
 * 约束：
 * - 文案单一真源在 `i18n/config.ts`：这里完成全部本地化，Rust 只显示。
 * - 每次全量推送 + JSON 签名去抖（照 `lib/settings/storage.ts` 的 hasChanged）。
 * - 列表在前端截断（最近 8 / 工作空间 8 / 运行中 10 / 定时任务 10）；
 *   Rust 侧另有防御性上限。标题消毒（& 转义/宽度截断）统一在 Rust。
 * - 非 Tauri 环境（vite dev / WebUI 无此模块）invoke 失败静默。
 */

import { invoke } from "@tauri-apps/api/core";
import { type Locale, t } from "../../i18n/config";
import type { CronTask } from "../automation/types";
import type { Theme, WorkspaceProject } from "../settings";
import { workspaceProjectPathKey } from "../settings";
import { readGlobalShortcutBindings } from "../shortcuts/globalShortcuts";
import type { SidebarConversation } from "../sidebar/types";
import type { TrayPrefs } from "./trayPrefs";

const TRAY_RECENT_LIMIT = 8;
const TRAY_WORKSPACE_LIMIT = 8;
const TRAY_RUNS_LIMIT = 10;
const TRAY_CRON_LIMIT = 10;

export type TrayMenuEntry = {
  id: string;
  label: string;
  checked?: boolean;
};

/** 与 Rust `services::tray::TrayMenuModel`（serde camelCase）字段一一对应。 */
export type TrayMenuModel = {
  labels: {
    show: string;
    newChat: string;
    pin: string;
    recent: string;
    recentViewAll: string;
    workspaces: string;
    runs: string;
    stopAll: string;
    cron: string;
    appearance: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    settings: string;
    checkUpdates: string;
    openDataDir: string;
    quit: string;
  };
  statusSuffix: string | null;
  recent: TrayMenuEntry[];
  recentTruncated: boolean;
  workspaces: TrayMenuEntry[];
  runs: TrayMenuEntry[];
  cron: TrayMenuEntry[];
  theme: Theme;
  showAccelerator: string | null;
  newChatAccelerator: string | null;
  tooltip: string | null;
  badgeText: string | null;
};

export type BuildTrayMenuModelInput = {
  locale: Locale;
  theme: Theme;
  conversations: readonly SidebarConversation[];
  runningConversationIds: ReadonlySet<string>;
  workspaceProjects: readonly WorkspaceProject[];
  activeWorkspaceProjectId: string | undefined;
  archivedWorkspaceProjectPaths: readonly string[];
  cronTasks: readonly CronTask[];
  prefs: TrayPrefs;
};

function withCount(template: string, count: number): string {
  return template.replace("{count}", String(count));
}

/** 快捷键回显：仅启用中的绑定；格式与 muda accelerator 解析兼容。 */
function enabledAccelerator(action: "summon" | "newChat"): string | null {
  const binding = readGlobalShortcutBindings()[action];
  if (!binding || binding.enabled === false) return null;
  const accelerator = binding.accelerator.trim();
  return accelerator ? accelerator : null;
}

function conversationLabel(
  conversation: SidebarConversation,
  index: number,
  locale: Locale,
  prefs: TrayPrefs,
): string {
  if (!prefs.showConversationTitles) {
    return withCount(t("tray.conversationPlaceholder", locale), index + 1);
  }
  const title = conversation.title.trim();
  return title ? title : t("tray.untitledConversation", locale);
}

export function buildTrayMenuModel(input: BuildTrayMenuModelInput): TrayMenuModel {
  const { locale, prefs } = input;

  // 最近对话：selectConversations 已置顶优先排序，直接截前 N（跳过本地草稿行）。
  const persisted = input.conversations.filter((conversation) => !conversation.isPending);
  const recent = persisted.slice(0, TRAY_RECENT_LIMIT).map((conversation, index) => ({
    id: conversation.id,
    label: conversationLabel(conversation, index, locale, prefs),
  }));
  const recentTruncated = persisted.length > TRAY_RECENT_LIMIT;

  // 工作空间：归档项不进托盘（激活语义会出档，托盘不提供这种隐式操作）。
  const archivedKeys = new Set(
    input.archivedWorkspaceProjectPaths.map((path) => workspaceProjectPathKey(path)),
  );
  const workspaces = input.workspaceProjects
    .filter((project) => !archivedKeys.has(workspaceProjectPathKey(project.path)))
    .slice(0, TRAY_WORKSPACE_LIMIT)
    .map((project) => ({
      id: project.id,
      label: project.name,
      checked: project.id === input.activeWorkspaceProjectId,
    }));

  // 运行中：sidebar 快照的 running 集合（已合并本地 + 远程运行）。
  const runningIds = input.runningConversationIds;
  const runs: TrayMenuEntry[] = [];
  let runIndex = 0;
  for (const conversation of persisted) {
    if (runs.length >= TRAY_RUNS_LIMIT) break;
    if (!runningIds.has(conversation.id)) continue;
    runs.push({
      id: conversation.id,
      label: conversationLabel(conversation, runIndex, locale, prefs),
    });
    runIndex += 1;
  }
  const runningCount = runningIds.size;

  // 定时任务：全部列出并带启用勾选（点击=开关，不是执行）。
  const cron = input.cronTasks.slice(0, TRAY_CRON_LIMIT).map((task) => ({
    id: task.id,
    label: task.name.trim() || t("tray.untitledCronTask", locale),
    checked: task.enabled,
  }));

  const tooltipParts = [
    "LiveAgent",
    runningCount > 0 ? withCount(t("tray.tooltipRunning", locale), runningCount) : null,
  ].filter((part): part is string => Boolean(part));

  return {
    labels: {
      show: t("tray.show", locale),
      newChat: t("tray.newChat", locale),
      pin: t("tray.pin", locale),
      recent: t("tray.recent", locale),
      recentViewAll: t("tray.recentViewAll", locale),
      workspaces: t("tray.workspaces", locale),
      runs:
        runningCount > 0
          ? withCount(t("tray.runsActive", locale), runningCount)
          : t("tray.runsIdle", locale),
      stopAll: t("tray.stopAll", locale),
      cron: t("tray.cron", locale),
      appearance: `${t("tray.appearance", locale)} · ${t(
        input.theme === "light"
          ? "tray.themeLight"
          : input.theme === "dark"
            ? "tray.themeDark"
            : "tray.themeSystem",
        locale,
      )}`,
      themeLight: t("tray.themeLight", locale),
      themeDark: t("tray.themeDark", locale),
      themeSystem: t("tray.themeSystem", locale),
      settings: t("tray.settings", locale),
      checkUpdates: t("tray.checkUpdates", locale),
      openDataDir: t("tray.openDataDir", locale),
      quit: t("tray.quit", locale),
    },
    statusSuffix: null,
    recent,
    recentTruncated,
    workspaces,
    runs,
    cron,
    theme: input.theme,
    showAccelerator: enabledAccelerator("summon"),
    newChatAccelerator: enabledAccelerator("newChat"),
    tooltip: tooltipParts.join(" · "),
    badgeText: prefs.showRunningBadge && runningCount > 0 ? String(runningCount) : null,
  };
}

let lastSyncedSignature: string | null = null;

/** 签名去抖的全量推送；非 Tauri 环境静默。 */
export async function syncTrayMenu(model: TrayMenuModel): Promise<void> {
  const signature = JSON.stringify(model);
  if (signature === lastSyncedSignature) {
    return;
  }
  try {
    await invoke("app_tray_menu_sync", { model } as never);
    lastSyncedSignature = signature;
  } catch {
    // 非 Tauri 环境或旧桌面壳：忽略。
  }
}
