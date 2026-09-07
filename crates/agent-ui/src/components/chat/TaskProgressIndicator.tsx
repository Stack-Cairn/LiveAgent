import { Check } from "@liveagent/ui/components/IconSet";
import { useId, useState } from "react";
import type { TaskItem } from "../../contracts/task";
import type { TaskProgressSnapshot } from "../../lib/chat/taskProgress";
import { cn } from "../../lib/shared/utils";
import { createTooltipHandle, Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export type TaskProgressIndicatorLabels = {
  title: string;
  step: string;
  completedCount: string;
  running: string;
  pending: string;
  paused: string;
  completed: string;
  taskPaused: string;
  taskCompleted: string;
};

type DisplayState = "running" | "pending" | "paused" | "completed";

const ICON_SIZE = 14;
const RING_STROKE = 1.75;

function TaskStatusIcon({ state, className }: { state: DisplayState; className?: string }) {
  if (state === "completed") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-[14px] shrink-0 items-center justify-center rounded-full bg-[hsl(var(--chat-success))] text-white",
          className,
        )}
      >
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    );
  }

  const radius = (ICON_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      aria-hidden="true"
      className={cn("size-[14px] shrink-0", className)}
      height={ICON_SIZE}
      viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`}
      width={ICON_SIZE}
    >
      <circle
        className="stroke-border"
        cx={ICON_SIZE / 2}
        cy={ICON_SIZE / 2}
        fill="none"
        r={radius}
        strokeWidth={RING_STROKE}
      />
      {state === "pending" ? null : (
        <circle
          className={cn(
            "origin-center",
            state === "running"
              ? "animate-spin stroke-[hsl(var(--tool-list-accent))] motion-reduce:animate-none"
              : "stroke-amber-600 dark:stroke-amber-300",
          )}
          cx={ICON_SIZE / 2}
          cy={ICON_SIZE / 2}
          fill="none"
          r={radius}
          strokeDasharray={`${circumference * 0.3} ${circumference * 0.7}`}
          strokeLinecap="round"
          strokeWidth={RING_STROKE}
        />
      )}
    </svg>
  );
}

function getTaskDisplayState(task: TaskItem, isConversationRunning: boolean): DisplayState {
  if (task.status === "completed") return "completed";
  if (task.status === "pending") return "pending";
  if (!isConversationRunning) return "paused";
  return "running";
}

/**
 * line-clamp 只在视觉上裁掉多余行，scrollHeight 仍是完整文本的高度；两者出现差值
 * 就说明这一行被截断了。只有这种行才值得弹 tooltip，完整可见的短句悬停不打扰。
 */
function isTaskSubjectClamped(element: Element | undefined): boolean {
  if (!element) return false;
  return element.scrollHeight - element.clientHeight > 1;
}

export function TaskProgressIndicator({
  snapshot,
  isConversationRunning,
  labels,
}: {
  snapshot: TaskProgressSnapshot;
  isConversationRunning: boolean;
  labels: TaskProgressIndicatorLabels;
}) {
  const instanceId = useId();
  const panelId = `${instanceId}-tasks`;
  // 整个列表共用一个 tooltip 实例：每一行只是它的分离式触发器，payload 带上完整标题。
  const [subjectTooltip] = useState(() => createTooltipHandle<string>());
  const displayState: DisplayState =
    snapshot.state === "completed"
      ? "completed"
      : !isConversationRunning
        ? "paused"
        : snapshot.state === "in_progress"
          ? "running"
          : "pending";
  const summaryText = [labels.title, labels.step, labels.completedCount, labels[displayState]].join(
    " · ",
  );

  return (
    <div
      className="group/task-progress pointer-events-auto relative inline-flex max-w-full"
      data-task-progress-root=""
    >
      <span
        aria-label={summaryText}
        aria-valuemax={snapshot.totalCount}
        aria-valuemin={0}
        aria-valuenow={snapshot.completedCount}
        className="sr-only"
        role="progressbar"
      />

      <button
        aria-describedby={panelId}
        aria-label={summaryText}
        className="flex h-8 max-w-full items-center gap-2 rounded-full bg-background/92 px-3 text-[12px] text-muted-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_1px_2px_-1px_rgba(0,0,0,0.08),0_8px_24px_-16px_rgba(15,23,42,0.38)] outline-none backdrop-blur-xl backdrop-saturate-150 transition-[background-color,box-shadow] hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/55 motion-reduce:transition-none dark:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_8px_24px_-16px_rgba(0,0,0,0.72)]"
        data-task-progress-toggle=""
        type="button"
      >
        <TaskStatusIcon state={displayState} />
        <span className="truncate font-medium tabular-nums text-foreground/85">
          {displayState === "completed" ? labels.completed : labels.step}
        </span>
      </button>

      {/* 悬浮层脱离常规流：触发药丸之外不占据任何布局高度，指针移开即收起。
          pb-2 把触发器与卡片之间的空隙纳入悬浮区，避免移动途中丢失 hover。 */}
      <div
        className="pointer-events-none absolute bottom-full left-1/2 z-40 w-[min(320px,calc(100vw-3rem))] -translate-x-1/2 translate-y-1 pb-2 opacity-0 transition-[opacity,translate] duration-200 ease-out group-hover/task-progress:pointer-events-auto group-hover/task-progress:translate-y-0 group-hover/task-progress:opacity-100 group-focus-within/task-progress:pointer-events-auto group-focus-within/task-progress:translate-y-0 group-focus-within/task-progress:opacity-100 motion-reduce:transition-none"
        data-task-progress-panel=""
        id={panelId}
        role="tooltip"
      >
        <ul
          aria-label={labels.title}
          className="flex max-h-[min(300px,42vh)] flex-col gap-2.5 overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl bg-background/95 px-3 py-2.5 shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_2px_4px_-2px_rgba(0,0,0,0.08),0_16px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur-xl backdrop-saturate-150 [scrollbar-gutter:stable] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_16px_40px_-20px_rgba(0,0,0,0.8)]"
        >
          {snapshot.tasks.map((task) => {
            const taskDisplayState = getTaskDisplayState(task, isConversationRunning);
            const statusText =
              taskDisplayState === "completed"
                ? labels.taskCompleted
                : taskDisplayState === "paused"
                  ? labels.taskPaused
                  : labels[taskDisplayState];

            return (
              <li
                aria-current={task.status === "in_progress" ? "step" : undefined}
                className="flex items-start gap-2.5"
                data-task-status={task.status}
                key={task.id}
              >
                <TaskStatusIcon className="mt-[3px]" state={taskDisplayState} />
                {/* 标题最多两行，超长路径/URL 之类无空格串强制折行，绝不再把列表撑出横向滚动条。 */}
                <TooltipTrigger
                  closeOnClick={false}
                  delay={300}
                  handle={subjectTooltip}
                  payload={task.subject}
                  render={
                    <span
                      className={cn(
                        "line-clamp-2 min-w-0 flex-1 break-words text-pretty text-[12.5px] leading-5",
                        taskDisplayState === "completed"
                          ? "text-muted-foreground"
                          : taskDisplayState === "running"
                            ? "font-medium text-foreground"
                            : "text-foreground/70",
                      )}
                    />
                  }
                >
                  {task.subject}
                </TooltipTrigger>
                <span className="sr-only">{statusText}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <Tooltip
        disableHoverablePopup
        handle={subjectTooltip}
        onOpenChange={(open, details) => {
          if (!open || isTaskSubjectClamped(details.trigger)) return;
          details.cancel();
          // 指针从一条被截断的行直接滑到相邻的完整行时，hover 逻辑会把这次移动视作
          // "换触发器"而不主动关闭；这里既否决了新行的打开，就得顺手把旧弹层收掉。
          if (subjectTooltip.isOpen) queueMicrotask(() => subjectTooltip.close());
        }}
      >
        {({ payload }) => (
          <TooltipContent
            className="pointer-events-none max-w-[min(360px,calc(100vw-2rem))] break-words font-normal leading-[18px]"
            side="top"
          >
            {payload}
          </TooltipContent>
        )}
      </Tooltip>
    </div>
  );
}
