import type { HistoryMigrationProgress } from "../kbrain/historyMigration";
import {
  applyMigrationProgress,
  createStartupProgress,
  migrationCounts,
  type StartupPhase,
} from "./progress";

export function startupLanguage(): "zh" | "en" {
  try {
    const locale = JSON.parse(localStorage.getItem("liveagent.ui-settings.v1") ?? "null")?.locale;
    return locale === "en-US" || locale === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function createStartupRenderer(doc: Document = document) {
  const shell = doc.querySelector<HTMLElement>("[data-static-boot-shell]");
  const text = (key: string, value: string) => {
    const el = shell?.querySelector<HTMLElement>(`[data-boot-${key}]`);
    if (el && el.textContent !== value) el.textContent = value;
  };
  const en = startupLanguage() === "en";
  const choose = (zh: string, english: string) => (en ? english : zh);
  let state = createStartupProgress();
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastPaint = 0;
  const retry = shell?.querySelector<HTMLButtonElement>("[data-boot-retry]");
  const operations = {
    waiting: choose("等待检查", "Waiting"),
    reading: choose("正在读取旧数据", "Reading old data"),
    processing: choose("正在整理会话", "Preparing a conversation"),
    importing: choose("正在导入会话", "Importing a conversation"),
    settled: choose("已处理当前会话", "Conversation processed"),
    done: choose("检查与迁移结束", "Finished"),
    error: choose("读取未完成，请进入应用后查看", "Could not finish reading; check in the app"),
  };
  const paint = () => {
    if (disposed) return;
    lastPaint = Date.now();
    const c = migrationCounts(state);
    const titles = {
      connecting: choose("正在连接本地服务", "Connecting to local service"),
      checking: choose("正在检查旧版数据", "Checking old data"),
      migrating: choose("正在迁移旧版会话", "Migrating old conversations"),
      opening: choose("正在准备主界面", "Opening your workspace"),
      error: choose("启动未完成", "Could not start LiveAgent"),
    };
    text("title", titles[state.phase]);
    if (state.phase !== "error")
      text(
        "detail",
        state.phase === "migrating"
          ? choose(
              "首次升级需要整理历史数据，数据较多时可能需要一些时间。",
              "The first upgrade needs to prepare your history. Large histories can take a while.",
            )
          : state.phase === "opening"
            ? choose("即将打开工作区…", "Your workspace will open shortly…")
            : choose("正在准备启动环境…", "Preparing your startup environment…"),
      );
    text(
      "counts",
      c.processed
        ? choose(
            `已处理 ${c.processed} 条 · 本次迁移 ${c.imported} · 已迁移 ${c.alreadyImported} · 跳过 ${c.skipped} · 问题 ${c.failed + c.partial}`,
            `Processed ${c.processed} · Imported ${c.imported} · Previously imported ${c.alreadyImported} · Skipped ${c.skipped} · Issues ${c.failed + c.partial}`,
          )
        : "",
    );
    for (const key of ["legacy", "pi"] as const) {
      const source = state.sources[key];
      const seconds = Math.max(0, Math.floor((Date.now() - source.operationStartedAt) / 1000));
      const duration = ["reading", "processing", "importing"].includes(source.operation)
        ? choose(` · 当前步骤 ${seconds} 秒`, ` · Current step ${seconds}s`)
        : "";
      text(
        key,
        state.phase === "migrating" || state.phase === "checking"
          ? `${key === "legacy" ? choose("旧版会话", "Legacy history") : choose("其他历史会话", "Other history")} · ${operations[source.operation]}${duration}`
          : "",
      );
    }
    text(
      "elapsed",
      choose(
        `已等待 ${Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))} 秒`,
        `Elapsed ${Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))}s`,
      ),
    );
    text(
      "waiting",
      state.phase !== "error" && Date.now() - state.lastProgressAt >= 30_000
        ? choose(
            "当前步骤耗时较长，仍在等待处理结果。",
            "This step is taking a while. Still waiting for its result.",
          )
        : "",
    );
  };
  const schedule = () => {
    if (disposed || pending !== undefined) return;
    pending = setTimeout(
      () => {
        pending = undefined;
        paint();
      },
      Math.max(0, 150 - (Date.now() - lastPaint)),
    );
  };
  const timer = setInterval(paint, 1000);
  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    if (pending !== undefined) clearTimeout(pending);
    if (retry) retry.onclick = null;
  };
  shell?.setAttribute("aria-label", choose("LiveAgent 启动进度", "LiveAgent startup progress"));
  text("retry", choose("重试", "Retry"));
  paint();
  return {
    phase(phase: StartupPhase) {
      if (disposed) return;
      state = { ...state, phase, lastProgressAt: Date.now() };
      paint();
    },
    progress(event: HistoryMigrationProgress) {
      if (disposed) return;
      state = applyMigrationProgress(state, event);
      if (event.operation === "done" || event.operation === "error") paint();
      else schedule();
    },
    fail(onRetry: () => void) {
      if (disposed) return;
      state = { ...state, phase: "error" };
      shell?.setAttribute("aria-busy", "false");
      shell?.setAttribute("data-boot-failed", "");
      text(
        "detail",
        choose(
          "本地服务或数据准备未能完成，请重试。若仍失败，请查看诊断日志。",
          "The local service or data preparation could not finish. Retry, or check diagnostic logs if it persists.",
        ),
      );
      if (retry) {
        retry.hidden = false;
        retry.onclick = () => {
          dispose();
          shell?.removeAttribute("data-boot-failed");
          shell?.setAttribute("aria-busy", "true");
          retry.hidden = true;
          onRetry();
        };
      }
      paint();
      clearInterval(timer);
      if (pending !== undefined) clearTimeout(pending);
    },
    dispose,
  };
}
