const now = Date.now();
const rec = (id: string, category: string, title: string, body: string, ago: number, extra: Record<string, unknown> = {}) => ({
  id, category, title, body, severity: category.includes("failed") ? "error" : "info", target: null, sourceKey: null, groupKey: null,
  createdAt: now - ago, updatedAt: now - ago, coalescedCount: 0, deliveredOs: true, osError: null, suppressedReason: null,
  readAt: null, actions: [], localized: null, extra: {}, ...extra });
const items = [
  rec("n1", "planning.event", "LiveAgent · 活动提醒", "产品设计评审会 14:00–15:00", 60_000, { target: { kind: "planningEvent", eventId: "e1" }, actions: [{ id: "snooze", minutes: [5, 15, 60] }, { id: "acknowledge" }] }),
  rec("n2", "cron.run_failed", "定时任务失败：每日数据同步", "stderr: connection refused", 25 * 60_000, { severity: "error", coalescedCount: 2, target: { kind: "cronRun", taskId: "sync", runId: "r1" }, actions: [{ id: "runNow" }] }),
  rec("n3", "planning.task_due", "LiveAgent · 任务截止", "提交 9 月差旅报销", 3 * 3600_000, { suppressedReason: "quiet_hours", deliveredOs: false, target: { kind: "planningTodo", todoId: "t1" } }),
  rec("n4", "agent.message", "LiveAgent · Agent", "代码审查已完成，发现 3 处需要修改的问题。", 26 * 3600_000, { readAt: now - 3600_000, target: { kind: "conversation", conversationId: "c1" } }),
];
const categories = [
  ["planning.event", "planning", "system"], ["planning.task_due", "planning", "system"], ["planning.reminder", "planning", "system"],
  ["cron.run_failed", "cron", "system"], ["cron.run_timeout", "cron", "system"], ["cron.run_succeeded", "cron", "off"], ["cron.run_skipped", "cron", "off"],
  ["agent.message", "agent", "system"], ["system.info", "system", "inApp"],
].map(([id, group, mode]) => ({ id, group, defaultMode: mode, mode, userConfigurable: true, mayBypassQuietHours: false, dedupWindowMs: 0, rateLimit: null }));
const settings = { version: 1, categories: Object.fromEntries(categories.map((c) => [c.id, c.mode])), quietHours: { enabled: true, start: "22:00", end: "07:00" }, retention: { maxItems: 500, maxAgeDays: 30 }, inAppToast: true };
const permission = { state: "unknown", platform: "macos", canOpenSettings: true, devMode: true, disabledByEnv: false };
export const backend = {
  scope: () => "desktop",
  async call(action: string) {
    if (action === "list") return { items, hasMore: false, unreadCount: items.filter((i) => !i.readAt).length, seq: 1 };
    if (action === "settings.get") return { settings, categories, permission };
    if (action.startsWith("permission")) return permission;
    return { seq: 1, unreadCount: 3 };
  },
  subscribe() { return () => {}; },
};
