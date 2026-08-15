import type { PluginInventoryItem } from "../../lib/plugins/types";

type TranslateFn = (key: string) => string;

/**
 * Plugin Hub 的展示派生集中在这里：卡片、详情弹层与筛选标签共用同一套阶段/信任
 * 判定，避免三处各写一份 `phase === "failed" || phase === "blocked"`。
 */

export type PluginPhaseTone = "success" | "destructive" | "muted";

export function pluginPhaseTone(phase: PluginInventoryItem["phase"]): PluginPhaseTone {
  if (phase === "active") return "success";
  if (phase === "blocked" || phase === "failed") return "destructive";
  return "muted";
}

/** 卡片与详情共用的一行故障说明；blocked 原因优先于历史 lastError。 */
export function pluginProblem(item: PluginInventoryItem): string | null {
  return item.blockedReason || item.lastError || null;
}

/**
 * 信任级别必须带文字。它是这个界面上最该被看见的安全事实——一个只画图标的
 * 徽章没法让人分辨「完整性已校验」和「继承本机全部权限的进程插件」。
 */
export function pluginTrustMeta(item: PluginInventoryItem, t: TranslateFn) {
  switch (item.trustLevel) {
    case "full_trust_process":
      return {
        label: t("pluginHub.trust.fullTrust"),
        description: t("pluginHub.trust.fullTrustHint"),
        variant: "destructive" as const,
        danger: true,
      };
    case "unsigned_developer":
      return {
        label: t("pluginHub.trust.unsigned"),
        description: t("pluginHub.trust.unsignedHint"),
        variant: "muted" as const,
        danger: false,
      };
    default:
      return {
        label: t("pluginHub.trust.verified"),
        description: t("pluginHub.trust.verifiedHint"),
        variant: "outline" as const,
        danger: false,
      };
  }
}

export type PluginContributionCounts = {
  tools: number;
  prompts: number;
  hooks: number;
  settings: number;
  total: number;
};

export function pluginContributionCounts(item: PluginInventoryItem): PluginContributionCounts {
  const tools = item.contributes.tools.length;
  const prompts = item.contributes.promptSections.length;
  const hooks = item.contributes.hooks.length;
  const settings = item.contributes.settings.length;
  return { tools, prompts, hooks, settings, total: tools + prompts + hooks };
}

export function pluginMissingPermissions(item: PluginInventoryItem): string[] {
  return item.permissions
    .map((permission) => permission.id)
    .filter((permission) => !item.grantedPermissions.includes(permission));
}

/** 卡片副标题：优先展示插件自述，退回发布者 + id，保证这一行永远不空。 */
export function pluginSubtitle(item: PluginInventoryItem): string {
  return item.description.trim() || `${item.publisher.name || item.publisher.id} · ${item.id}`;
}

export type PluginHubFilter = "all" | "enabled" | "attention";

/**
 * `attention` 收拢所有「装了但没在干活」的插件：被阻止、执行失败、或缺授权。
 * 用户来 Plugin Hub 十有八九是为了处理这一类，值得有独立入口。
 */
export function pluginNeedsAttention(item: PluginInventoryItem): boolean {
  return (
    item.phase === "blocked" ||
    item.phase === "failed" ||
    (item.enabled && pluginMissingPermissions(item).length > 0)
  );
}

export function matchesPluginFilter(item: PluginInventoryItem, filter: PluginHubFilter): boolean {
  if (filter === "enabled") return item.enabled;
  if (filter === "attention") return pluginNeedsAttention(item);
  return true;
}

export function matchesPluginQuery(item: PluginInventoryItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    item.name,
    item.id,
    item.description,
    item.publisher.name,
    item.publisher.id,
    item.runtime.kind,
    ...item.contributes.tools.map((tool) => tool.modelName),
  ].some((field) => field?.toLowerCase().includes(normalized));
}
