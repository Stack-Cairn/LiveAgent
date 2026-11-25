/**
 * Startup and migration screen copy. The screen paints before the app's i18n provider loads,
 * so it reads this table directly; `{name}` placeholders are filled by `startupText`.
 */
const zh = {
  "operation.waiting": "等待检查",
  "operation.reading": "正在读取旧数据",
  "operation.processing": "正在整理会话",
  "operation.importing": "正在导入会话",
  "operation.settled": "已处理当前会话",
  "operation.done": "检查与迁移结束",
  "operation.error": "读取未完成，请进入应用后查看",
  "title.connecting": "正在连接本地服务",
  "title.checking": "正在检查旧版数据",
  "title.migrating": "正在迁移旧版会话",
  "title.opening": "正在准备主界面",
  "title.error": "启动未完成",
  "detail.migrating": "首次升级需要整理历史数据，数据较多时可能需要一些时间。",
  "detail.opening": "即将打开工作区…",
  "detail.preparing": "正在准备启动环境…",
  "detail.failed": "本地服务或数据准备未能完成，请重试。若仍失败，请查看诊断日志。",
  counts:
    "已处理 {processed} 条 · 本次迁移 {imported} · 已迁移 {alreadyImported} · 跳过 {skipped} · 问题 {issues}",
  "counts.deferred": " · 稍后处理 {deferred}（仍在写入）",
  stepDuration: " · 当前步骤 {seconds} 秒",
  "source.legacy": "旧版会话",
  "source.pi": "其他历史会话",
  elapsed: "已等待 {seconds} 秒",
  "waiting.escapes":
    "当前步骤耗时较长。可以跳过直接进入应用，未完成的迁移会在后台继续；也可以重启本地服务后重试。",
  "waiting.plain": "当前步骤耗时较长，仍在等待处理结果。",
  restartRetry: "重启本地服务并重试",
  ariaLabel: "LiveAgent 启动进度",
  retry: "重试",
  skip: "跳过，进入应用",
};

type StartupTextKey = keyof typeof zh;

const en: Record<StartupTextKey, string> = {
  "operation.waiting": "Waiting",
  "operation.reading": "Reading old data",
  "operation.processing": "Preparing a conversation",
  "operation.importing": "Importing a conversation",
  "operation.settled": "Conversation processed",
  "operation.done": "Finished",
  "operation.error": "Could not finish reading; check in the app",
  "title.connecting": "Connecting to local service",
  "title.checking": "Checking old data",
  "title.migrating": "Migrating old conversations",
  "title.opening": "Opening your workspace",
  "title.error": "Could not start LiveAgent",
  "detail.migrating":
    "The first upgrade needs to prepare your history. Large histories can take a while.",
  "detail.opening": "Your workspace will open shortly…",
  "detail.preparing": "Preparing your startup environment…",
  "detail.failed":
    "The local service or data preparation could not finish. Retry, or check diagnostic logs if it persists.",
  counts:
    "Processed {processed} · Imported {imported} · Previously imported {alreadyImported} · Skipped {skipped} · Issues {issues}",
  "counts.deferred": " · Later {deferred} (still being written)",
  stepDuration: " · Current step {seconds}s",
  "source.legacy": "Legacy history",
  "source.pi": "Other history",
  elapsed: "Elapsed {seconds}s",
  "waiting.escapes":
    "This step is taking a while. Skip to open LiveAgent now while the migration continues in the background, or restart the local service and retry.",
  "waiting.plain": "This step is taking a while. Still waiting for its result.",
  restartRetry: "Restart local service and retry",
  ariaLabel: "LiveAgent startup progress",
  retry: "Retry",
  skip: "Skip and open LiveAgent",
};

export function startupText(
  language: "zh" | "en",
  key: StartupTextKey,
  values: Record<string, string | number> = {},
) {
  return (language === "en" ? en : zh)[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
