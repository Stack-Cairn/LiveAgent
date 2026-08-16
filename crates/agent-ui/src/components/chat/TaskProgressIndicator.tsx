import { CheckCircle2, Circle, Loader2 } from "@liveagent/ui/components/IconSet";
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { TaskProgressSnapshot } from "../../lib/chat/taskProgress";
import { cn } from "../../lib/shared/utils";

const POINTER_CLOSE_DELAY_MS = 140;

export type TaskProgressIndicatorLabels = {
  title: string;
  step: string;
  completedCount: string;
  running: string;
  pending: string;
  paused: string;
  completed: string;
};

export function TaskProgressIndicator({
  snapshot,
  isConversationRunning,
  labels,
}: {
  snapshot: TaskProgressSnapshot;
  isConversationRunning: boolean;
  labels: TaskProgressIndicatorLabels;
}) {
  const panelId = useId();
  const rootRef = useRef<HTMLFieldSetElement | null>(null);
  const pointerCloseTimerRef = useRef<number | null>(null);
  const focusCloseTimerRef = useRef<number | null>(null);
  const lastPointerTypeRef = useRef<string | null>(null);
  const [pointerOpen, setPointerOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const isOpen = pointerOpen || focusOpen || touchOpen;
  const displayState =
    snapshot.state === "completed"
      ? "completed"
      : isConversationRunning
        ? snapshot.state === "in_progress"
          ? "running"
          : "pending"
        : "paused";
  const stateText = labels[displayState];
  const summaryText = [labels.title, labels.step, labels.completedCount, stateText].join(" · ");

  useEffect(
    () => () => {
      if (pointerCloseTimerRef.current !== null) {
        window.clearTimeout(pointerCloseTimerRef.current);
      }
      if (focusCloseTimerRef.current !== null) {
        window.clearTimeout(focusCloseTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!touchOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setTouchOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [touchOpen]);

  const clearCloseTimer = (timerRef: typeof pointerCloseTimerRef) => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const handlePointerEnter = (event: ReactPointerEvent<HTMLFieldSetElement>) => {
    if (event.pointerType === "touch") return;
    clearCloseTimer(pointerCloseTimerRef);
    setPointerOpen(true);
  };
  const handlePointerLeave = (event: ReactPointerEvent<HTMLFieldSetElement>) => {
    if (event.pointerType === "touch") return;
    clearCloseTimer(pointerCloseTimerRef);
    pointerCloseTimerRef.current = window.setTimeout(() => {
      pointerCloseTimerRef.current = null;
      setPointerOpen(false);
    }, POINTER_CLOSE_DELAY_MS);
  };
  const handleFocusCapture = (event: ReactFocusEvent<HTMLFieldSetElement>) => {
    clearCloseTimer(focusCloseTimerRef);
    setFocusOpen(event.target instanceof HTMLElement && event.target.matches(":focus-visible"));
  };
  const handleBlurCapture = (event: ReactFocusEvent<HTMLFieldSetElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    clearCloseTimer(focusCloseTimerRef);
    focusCloseTimerRef.current = window.setTimeout(() => {
      focusCloseTimerRef.current = null;
      setFocusOpen(false);
    }, POINTER_CLOSE_DELAY_MS);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFieldSetElement>) => {
    lastPointerTypeRef.current = null;
    if (event.key !== "Escape") return;
    clearCloseTimer(pointerCloseTimerRef);
    clearCloseTimer(focusCloseTimerRef);
    setPointerOpen(false);
    setFocusOpen(false);
    setTouchOpen(false);
  };
  const statusClassName =
    displayState === "completed"
      ? "text-[hsl(var(--chat-success))]"
      : displayState === "running"
        ? "text-[hsl(var(--tool-list-accent))]"
        : displayState === "paused"
          ? "text-amber-600 dark:text-amber-300"
          : "text-muted-foreground";

  return (
    <fieldset
      ref={rootRef}
      aria-label={labels.title}
      className="relative z-40 mx-auto mb-4 flex w-fit max-w-full justify-center border-0 p-0"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-label={summaryText}
        onPointerDown={(event) => {
          lastPointerTypeRef.current = event.pointerType;
        }}
        onClick={() => {
          if (lastPointerTypeRef.current === "touch") setTouchOpen((open) => !open);
        }}
        className="flex h-10 max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full bg-background/88 px-3.5 text-[13px] text-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.08),0_8px_24px_-14px_rgba(15,23,42,0.38)] backdrop-blur-xl backdrop-saturate-150 transition-[scale,box-shadow,background-color] duration-150 ease-out hover:bg-background/95 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.10),0_2px_4px_-1px_rgba(0,0,0,0.10),0_10px_28px_-14px_rgba(15,23,42,0.46)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_8px_24px_-14px_rgba(0,0,0,0.72)]"
      >
        <span
          role="progressbar"
          aria-label={labels.completedCount}
          aria-valuemin={0}
          aria-valuemax={snapshot.totalCount}
          aria-valuenow={snapshot.completedCount}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
        >
          {displayState === "completed" ? (
            <CheckCircle2 className="h-4 w-4 text-[hsl(var(--chat-success))]" />
          ) : displayState === "running" ? (
            <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--tool-list-accent))] motion-reduce:animate-none" />
          ) : displayState === "paused" ? (
            <Loader2 className="h-4 w-4 text-amber-600 dark:text-amber-300" />
          ) : (
            <Circle className="h-4 w-4 text-muted-foreground/65" />
          )}
        </span>
        <span className="truncate font-medium tabular-nums">{labels.step}</span>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground/45">
          ·
        </span>
        <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
          {labels.completedCount}
        </span>
      </button>

      <section
        id={panelId}
        aria-label={labels.title}
        aria-hidden={!isOpen}
        className={cn(
          "pointer-events-none absolute bottom-full left-1/2 z-50 w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 translate-y-1 pb-2 opacity-0 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
          isOpen && "pointer-events-auto translate-y-0 opacity-100",
        )}
      >
        <div className="rounded-2xl bg-popover/96 p-2 text-popover-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_8px_-2px_rgba(0,0,0,0.12),0_18px_48px_-20px_rgba(15,23,42,0.52)] backdrop-blur-2xl backdrop-saturate-150 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_18px_48px_-20px_rgba(0,0,0,0.86)]">
          <div className="flex items-start justify-between gap-3 px-2 pb-2 pt-1.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{labels.title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {labels.step} · {labels.completedCount}
              </div>
            </div>
            <span className={cn("shrink-0 pt-0.5 text-xs font-medium", statusClassName)}>
              {stateText}
            </span>
          </div>
          <ul className="max-h-[min(320px,40vh)] space-y-0.5 overflow-y-auto overscroll-contain">
            {snapshot.tasks.map((task) => {
              return (
                <li
                  key={task.id}
                  data-task-status={task.status}
                  aria-current={task.status === "in_progress" ? "step" : undefined}
                  className={cn(
                    "grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-5 transition-colors duration-200 ease-out motion-reduce:transition-none",
                    task.status === "in_progress" && "bg-muted/45",
                  )}
                >
                  <span
                    key={`${task.status}:${isConversationRunning ? "running" : "paused"}`}
                    className="mt-0.5 inline-flex h-4 w-4 animate-in items-center justify-center fade-in-0 zoom-in-75 duration-200 motion-reduce:animate-none"
                  >
                    {task.status === "completed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--chat-success))]" />
                    ) : task.status === "in_progress" ? (
                      <Loader2
                        className={cn(
                          "h-3.5 w-3.5 motion-reduce:animate-none",
                          isConversationRunning
                            ? "animate-spin text-[hsl(var(--tool-list-accent))]"
                            : "text-amber-600 dark:text-amber-300",
                        )}
                      />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 break-words text-pretty",
                      task.status === "completed"
                        ? "text-muted-foreground line-through"
                        : task.status === "in_progress"
                          ? "font-medium text-foreground"
                          : "text-foreground/78",
                    )}
                  >
                    {task.subject}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </fieldset>
  );
}
