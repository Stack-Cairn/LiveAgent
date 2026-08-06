import { Popover } from "@base-ui/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ListChecks,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
  X,
} from "../../../components/icons";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { useLocale } from "../../../i18n";
import {
  type ConversationGoal,
  DEFAULT_GOAL_API_ERROR_PAUSE_THRESHOLD,
  formatGoalDuration,
  formatGoalTokens,
  getGoalElapsedSeconds,
  goalStatusLabel,
  MAX_GOAL_OBJECTIVE_CHARS,
} from "../../../lib/chat/goal";
import { cn } from "../../../lib/shared/utils";
import type { TodoItem } from "../../../lib/tools/builtinTypes";
import { TodoListView } from "./assistant-bubble/TodoListView";

function statusTone(status: ConversationGoal["status"]) {
  switch (status) {
    case "active":
      return "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300";
    case "paused":
      return "border-amber-500/35 bg-amber-500/6 text-amber-800 dark:text-amber-200";
    case "blocked":
    case "usageLimited":
      return "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300";
    default:
      return "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
  }
}

export function GoalProgressPanel(props: {
  goal: ConversationGoal | null | undefined;
  isRunning: boolean;
  todos: TodoItem[];
  onEdit: (objective: string) => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  className?: string;
}) {
  const { goal, isRunning, todos, onEdit, onPause, onResume, onClear, className } = props;
  const { t } = useLocale();
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [isEditing, setIsEditing] = useState(false);
  const [objectiveDraft, setObjectiveDraft] = useState(goal?.objective ?? "");
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isEditing) setObjectiveDraft(goal?.objective ?? "");
  }, [goal?.objective, isEditing]);

  useEffect(() => {
    if (goal?.status !== "active" || !isRunning) return undefined;

    const tick = () => setClockNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [goal?.status, isRunning]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  if (!goal) return null;

  const completedTodos = todos.filter((todo) => todo.status === "completed").length;
  // An active goal can be idle after a turn or an app restart. Keep it active
  // as unfinished work, but expose the same explicit resume affordance.
  const canResume =
    !isRunning &&
    (goal.status === "active" || ["paused", "blocked", "usageLimited"].includes(goal.status));
  const canPause = goal.status === "active" && isRunning;
  const hasErrorState = goal.consecutiveApiErrorCount > 0;
  const elapsedSeconds =
    goal.status === "active" && isRunning
      ? getGoalElapsedSeconds(goal, clockNow)
      : Math.max(0, Math.floor(goal.timeUsedSeconds));

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const openPopover = () => {
    clearCloseTimer();
    setIsPopoverOpen(true);
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setIsPopoverOpen(false);
    }, 160);
  };

  const beginEdit = () => {
    setObjectiveDraft(goal.objective);
    setIsEditing(true);
    openPopover();
  };

  const cancelEdit = () => {
    setObjectiveDraft(goal.objective);
    setIsEditing(false);
  };

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const objective = objectiveDraft.trim();
    if (!objective) return;
    if (objective !== goal.objective) onEdit(objective);
    setIsEditing(false);
  };

  return (
    <Popover.Root
      open={isPopoverOpen}
      onOpenChange={(open) => {
        clearCloseTimer();
        setIsPopoverOpen(open);
      }}
    >
      <div className={cn("flex min-w-0 items-center gap-1", className)}>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={beginEdit}
            aria-label={t("chat.goal.edit")}
            title={t("chat.goal.edit")}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {canPause ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={onPause}
              aria-label={t("chat.goal.pause")}
              title={t("chat.goal.pause")}
            >
              <Pause className="h-3.5 w-3.5" />
            </Button>
          ) : canResume ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
              onClick={onResume}
              aria-label={t("chat.goal.resume")}
              title={t("chat.goal.resume")}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onClear}
            aria-label={t("chat.goal.delete")}
            title={t("chat.goal.delete")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <Popover.Trigger
          render={
            <button
              type="button"
              onPointerEnter={openPopover}
              onPointerLeave={scheduleClose}
              aria-label={t("chat.goal.panel")}
              aria-expanded={isPopoverOpen}
              className={cn(
                "group flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-black/[0.055] bg-white/70 px-3 py-1.5 text-left shadow-[0_8px_24px_-18px_rgba(15,23,42,0.3),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl backdrop-saturate-[165%] transition-[background-color,border-color,box-shadow] hover:border-black/[0.09] hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_8px_24px_-18px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.08)] dark:hover:border-white/[0.16] dark:hover:bg-white/[0.09]",
                isPopoverOpen &&
                  "border-black/[0.1] bg-white/90 shadow-[0_12px_30px_-18px_rgba(15,23,42,0.38),inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.16] dark:bg-white/[0.09]",
              )}
            />
          }
        >
          <Target className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-300" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
            {goal.objective}
          </span>
          <span
            className={cn(
              "hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none sm:inline-flex",
              statusTone(goal.status),
            )}
          >
            {goalStatusLabel(goal.status)}
          </span>
          {todos.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5" />
              {completedTodos}/{todos.length}
            </span>
          ) : null}
          <span className="hidden shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted-foreground md:inline-flex">
            <Clock3 className="h-3.5 w-3.5" />
            {formatGoalDuration(elapsedSeconds)}
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              isPopoverOpen && "rotate-180",
            )}
          />
        </Popover.Trigger>
      </div>

      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-[9999]"
        >
          <Popover.Popup
            onPointerEnter={openPopover}
            onPointerLeave={scheduleClose}
            aria-label={t("chat.goal.panel")}
            className="w-[min(26rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border/70 bg-popover/95 text-popover-foreground shadow-[0_18px_48px_-20px_rgba(15,23,42,0.48)] outline-none backdrop-blur-2xl dark:shadow-[0_18px_48px_-20px_rgba(0,0,0,0.8)]"
          >
            <div className="border-b border-border/50 px-3.5 pb-3 pt-3">
              <div className="flex items-start gap-2">
                <Target className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {t("chat.goal.title")}
                    </span>
                    <span
                      className={cn(
                        "rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                        statusTone(goal.status),
                      )}
                    >
                      {goalStatusLabel(goal.status)}
                    </span>
                  </div>
                  {isEditing ? (
                    <form className="mt-2 space-y-1.5" onSubmit={submitEdit}>
                      <Textarea
                        value={objectiveDraft}
                        onChange={(event) => setObjectiveDraft(event.target.value)}
                        placeholder={t("chat.goal.editPlaceholder")}
                        maxLength={MAX_GOAL_OBJECTIVE_CHARS}
                        rows={3}
                        autoFocus
                        className="min-h-16 w-full resize-y px-2 py-1.5 text-xs leading-4"
                      />
                      <div className="flex justify-end gap-1">
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-emerald-600 hover:text-emerald-700 dark:text-emerald-300"
                          disabled={!objectiveDraft.trim()}
                          aria-label={t("chat.goal.save")}
                          title={t("chat.goal.save")}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={cancelEdit}
                          aria-label={t("chat.goal.cancelEdit")}
                          title={t("chat.goal.cancelEdit")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <p className="mt-1.5 break-words text-sm leading-5 text-foreground/90">
                      {goal.objective}
                    </p>
                  )}
                </div>
              </div>

              {hasErrorState ? (
                <p className="mt-2 break-words text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                  {t("chat.goal.providerErrors")
                    .replace("{count}", String(goal.consecutiveApiErrorCount))
                    .replace("{threshold}", String(DEFAULT_GOAL_API_ERROR_PAUSE_THRESHOLD))}
                  {goal.lastApiError ? `: ${goal.lastApiError}` : ""}
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2 border-b border-border/50 px-3.5 py-3 sm:grid-cols-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                  {t("chat.goal.runningTime")}
                </div>
                <div className="mt-0.5 truncate text-xs font-medium tabular-nums">
                  {formatGoalDuration(elapsedSeconds)}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                  {t("chat.goal.totalTokens")}
                </div>
                <div className="mt-0.5 truncate text-xs font-medium tabular-nums">
                  {formatGoalTokens(goal.tokensUsed)}
                  {goal.tokenBudget ? `/${formatGoalTokens(goal.tokenBudget)}` : ""}
                </div>
              </div>
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <div className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                  {t("chat.goal.steps")}
                </div>
                <div className="mt-0.5 truncate text-xs font-medium tabular-nums">
                  {completedTodos}/{todos.length}
                  {completedTodos === todos.length && todos.length > 0 ? (
                    <CheckCircle2 className="ml-1 inline h-3.5 w-3.5 align-[-2px] text-emerald-600 dark:text-emerald-300" />
                  ) : null}
                </div>
              </div>
            </div>

            {todos.length > 0 ? (
              <div className="border-b border-border/50 px-3.5 py-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <ListChecks className="h-3.5 w-3.5" />
                  <span>{t("chat.tool.todoTitle")}</span>
                  {completedTodos === todos.length ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
                  ) : null}
                </div>
                <div className="max-h-44 overflow-y-auto pr-1">
                  <TodoListView todos={todos} />
                </div>
              </div>
            ) : (
              <div className="border-b border-border/50 px-3.5 py-3 text-xs text-muted-foreground">
                {t("chat.tool.todoEmpty")}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
