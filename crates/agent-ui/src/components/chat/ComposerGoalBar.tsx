import { Check, Goal, Pause, Play, SquarePen, Trash2, X } from "@liveagent/ui/components/IconSet";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

/** 目标栏展示的会话目标；status 取 K-brain goal 状态里会持续显示的几种。 */
export type ComposerGoalBarState = {
  goal: string;
  status: "active" | "continuing" | "paused";
  round: number;
  maxRounds: number;
  reason?: string;
  /** 设定或最近一次恢复的时间（毫秒），用于显示已运行时长。 */
  startedAt?: number;
};

export type ComposerGoalBarActions = {
  onPause: () => unknown;
  onResume: () => unknown;
  onUpdate: (goal: string) => unknown;
  onClear: () => unknown;
};

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useElapsed(startedAt: number | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  return startedAt === undefined ? null : formatElapsed(now - startedAt);
}

const iconButton = cn(
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
  "hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  "disabled:pointer-events-none disabled:opacity-40",
);

/**
 * 输入框上方的目标栏（/goal）。目标达成或清除前一直显示；可暂停、恢复、修改目标
 * 正文，取消目标前弹确认。样式与指令队列面板一致，两者在同一容器里上下排列。
 */
export function ComposerGoalBar({
  state,
  actions,
  disabled,
}: {
  state: ComposerGoalBarState;
  actions: ComposerGoalBarActions;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(state.goal);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const running = state.status !== "paused";
  const elapsed = useElapsed(state.startedAt, running);

  useEffect(() => {
    if (!editing) setDraft(state.goal);
  }, [editing, state.goal]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const run = async (action: () => unknown) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const submitEdit = () => {
    const next = draft.trim();
    if (!next || next === state.goal) {
      setEditing(false);
      return;
    }
    void run(async () => {
      await actions.onUpdate(next);
      setEditing(false);
    });
  };
  const onEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 多行编辑：Enter 换行，Ctrl/Cmd+Enter 保存。
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submitEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    }
  };
  const clear = () =>
    void run(async () => {
      const confirmed = await confirm({
        title: t("chat.goalBar.clearTitle"),
        description: t("chat.goalBar.clearDescription"),
        detail: state.goal,
        confirmLabel: t("chat.goalBar.clearConfirm"),
        cancelLabel: t("chat.goalBar.clearCancel"),
        preferCancel: true,
      });
      if (confirmed) await actions.onClear();
    });

  const label = running
    ? t("chat.goalBar.active")
    : state.reason === "awaiting_input"
      ? t("chat.goalBar.awaitingInput")
      : t("chat.goalBar.paused");
  const progress =
    state.round > 0
      ? t("chat.goalBar.round")
          .replace("{round}", String(state.round))
          .replace("{max}", String(state.maxRounds))
      : null;
  const locked = disabled || busy;

  return (
    <div
      data-composer-goal-bar={state.status}
      className={cn(
        // 比输入框窄一圈，落在其圆角以内，也少挡转录区的文字。
        "mx-auto w-inset-2p25rem rounded-t-lg border border-b-0 border-black/[0.055] bg-white/70",
        "px-2 py-1",
        "shadow-ui-clarifypanel-22 backdrop-blur-2xl backdrop-saturate-[165%]",
        "dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-ui-clarifypanel-23",
      )}
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5 text-xs">
        <Goal
          className={cn(
            "size-3.5 shrink-0",
            running ? "text-foreground/80" : "text-muted-foreground",
          )}
        />
        {/* 最窄 Pane 里按钮放不下时，状态标签先截断（悬停看全文），
            目标正文至少留 40px，按钮始终在栏内。 */}
        <span className="min-w-0 truncate font-medium text-foreground/90" title={label}>
          {label}
        </span>
        {editing ? (
          <span className="min-w-10 flex-1 truncate text-muted-foreground/70">
            {t("chat.goalBar.editHint")}
          </span>
        ) : (
          <span className="min-w-10 flex-1 truncate text-muted-foreground" title={state.goal}>
            {state.goal}
            {elapsed || progress ? (
              <span className="text-muted-foreground/70">
                {" · "}
                {[progress, elapsed].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {editing ? (
            <>
              <button
                type="button"
                className={iconButton}
                disabled={locked}
                onClick={submitEdit}
                title={t("chat.goalBar.save")}
                aria-label={t("chat.goalBar.save")}
              >
                <Check className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButton}
                disabled={locked}
                onClick={() => setEditing(false)}
                title={t("chat.goalBar.cancelEdit")}
                aria-label={t("chat.goalBar.cancelEdit")}
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : (
            <>
              {/* 与排队指令的操作顺序一致：编辑、执行（暂停/继续）、删除。 */}
              <button
                type="button"
                className={iconButton}
                disabled={locked}
                onClick={() => setEditing(true)}
                title={t("chat.goalBar.edit")}
                aria-label={t("chat.goalBar.edit")}
              >
                <SquarePen className="size-3.5" />
              </button>
              <button
                type="button"
                className={iconButton}
                disabled={locked}
                onClick={() => void run(running ? actions.onPause : actions.onResume)}
                title={running ? t("chat.goalBar.pause") : t("chat.goalBar.resume")}
                aria-label={running ? t("chat.goalBar.pause") : t("chat.goalBar.resume")}
              >
                {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              </button>
              <button
                type="button"
                className={iconButton}
                disabled={locked}
                onClick={clear}
                title={t("chat.goalBar.clear")}
                aria-label={t("chat.goalBar.clear")}
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          ref={inputRef}
          value={draft}
          disabled={locked}
          rows={4}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onEditKeyDown}
          aria-label={t("chat.goalBar.edit")}
          className={cn(
            "mb-1 block max-h-60 min-h-20 w-full resize-y rounded-md border border-border/70",
            "bg-background/70 px-2 py-1.5 text-xs leading-5 text-foreground outline-none",
            "focus-visible:ring-1 focus-visible:ring-ring",
          )}
        />
      ) : null}
      {dialog}
    </div>
  );
}
