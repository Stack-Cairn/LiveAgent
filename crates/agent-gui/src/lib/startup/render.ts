import { startupText } from "../../i18n/startupTranslations";
import type { HistoryMigrationProgress } from "../kbrain/historyMigration";
import {
  applyMigrationProgress,
  createStartupProgress,
  migrationCounts,
  type StartupPhase,
} from "./progress";

/**
 * No progress for this long offers the ways out (skip into the app, restart and retry). Shorter
 * than the migration's per-request limit, so a backend that stops answering surfaces the escapes
 * before a chain of timed-out steps can keep the screen up.
 */
export const STARTUP_STALL_MS = 15_000;

export type StartupEscapes = {
  /** Restart the local service and run startup again. */
  retry: () => void;
  /** Open the app now; unfinished migration keeps running in the background. */
  skip: () => void;
};

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
  const language = startupLanguage();
  const say = (key: Parameters<typeof startupText>[1], values?: Record<string, string | number>) =>
    startupText(language, key, values);
  let state = createStartupProgress();
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastPaint = 0;
  const retry = shell?.querySelector<HTMLButtonElement>("[data-boot-retry]");
  const skip = shell?.querySelector<HTMLButtonElement>("[data-boot-skip]");
  let escapes: StartupEscapes | undefined;
  let escaped = false;
  // One click ends this screen's attempt; later clicks (or a second button) do nothing.
  const once = (action: () => void) => () => {
    if (escaped || disposed) return;
    escaped = true;
    if (retry) retry.disabled = true;
    if (skip) skip.disabled = true;
    action();
  };
  const showEscapes = (retryLabel: string, onRetry?: () => void) => {
    if (escaped) return;
    if (retry && onRetry) {
      text("retry", retryLabel);
      retry.hidden = false;
      retry.onclick = once(onRetry);
    }
    if (skip && escapes) {
      skip.hidden = false;
      skip.onclick = once(escapes.skip);
    }
  };
  const operations = {
    waiting: say("operation.waiting"),
    reading: say("operation.reading"),
    processing: say("operation.processing"),
    importing: say("operation.importing"),
    settled: say("operation.settled"),
    done: say("operation.done"),
    error: say("operation.error"),
  };
  const paint = () => {
    if (disposed) return;
    lastPaint = Date.now();
    const c = migrationCounts(state);
    text("title", say(`title.${state.phase}`));
    if (state.phase !== "error")
      text(
        "detail",
        state.phase === "migrating"
          ? say("detail.migrating")
          : state.phase === "opening"
            ? say("detail.opening")
            : say("detail.preparing"),
      );
    text(
      "counts",
      c.processed || c.deferred
        ? say("counts", { ...c, issues: c.failed + c.partial }) +
            (c.deferred ? say("counts.deferred", { deferred: c.deferred }) : "")
        : "",
    );
    for (const key of ["legacy", "pi"] as const) {
      const source = state.sources[key];
      const seconds = Math.max(0, Math.floor((Date.now() - source.operationStartedAt) / 1000));
      const duration = ["reading", "processing", "importing"].includes(source.operation)
        ? say("stepDuration", { seconds })
        : "";
      text(
        key,
        state.phase === "migrating" || state.phase === "checking"
          ? `${say(`source.${key}`)} · ${operations[source.operation]}${duration}`
          : "",
      );
    }
    text(
      "elapsed",
      say("elapsed", { seconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)) }),
    );
    const stalled =
      state.phase !== "error" && Date.now() - state.lastProgressAt >= STARTUP_STALL_MS;
    text("waiting", stalled ? (escapes ? say("waiting.escapes") : say("waiting.plain")) : "");
    if (stalled && escapes) {
      showEscapes(say("restartRetry"), escapes.retry);
    }
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
    if (skip) skip.onclick = null;
  };
  shell?.setAttribute("aria-label", say("ariaLabel"));
  text("retry", say("retry"));
  text("skip", say("skip"));
  if (retry) {
    retry.hidden = true;
    retry.disabled = false;
  }
  if (skip) {
    skip.hidden = true;
    skip.disabled = false;
  }
  paint();
  return {
    phase(phase: StartupPhase) {
      if (disposed) return;
      state = { ...state, phase, lastProgressAt: Date.now() };
      paint();
    },
    /** Enables the stalled-step actions; they appear once no progress arrived for a while. */
    offerEscapes(next: StartupEscapes) {
      if (disposed) return;
      escapes = next;
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
      text("detail", say("detail.failed"));
      text("waiting", "");
      showEscapes(say("retry"), () => {
        dispose();
        shell?.removeAttribute("data-boot-failed");
        shell?.setAttribute("aria-busy", "true");
        if (retry) retry.hidden = true;
        if (skip) skip.hidden = true;
        onRetry();
      });
      paint();
      clearInterval(timer);
      if (pending !== undefined) clearTimeout(pending);
    },
    dispose,
  };
}
