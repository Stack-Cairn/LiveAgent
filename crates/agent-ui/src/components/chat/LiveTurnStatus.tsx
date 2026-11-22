import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n/index";
import {
  formatProgressSeconds,
  initialRunPhaseState,
  RUN_PROGRESS_TIMINGS,
  type RunPhase,
  type RunPhaseState,
  type RunPhaseTarget,
  resolveRunPhaseTarget,
  stepRunPhase,
} from "../../lib/chat/runPhase";
import { parseRunProgress } from "../../lib/chat/runProgress";
import { cn } from "../../lib/shared/utils";
import { formatElapsedTime, useTurnElapsedMs } from "./AssistantWorkTrace";
import { CompactionBand } from "./CompactionBand";
import { useDetailedProgress } from "./processDisclosure";

const PIXEL_KEYS = [
  "top-start",
  "top",
  "top-end",
  "start",
  "center",
  "end",
  "bottom-start",
  "bottom",
  "bottom-end",
] as const;

// Diagonal wave from the left column outward: 90ms per step away from the middle row.
const PIXEL_DELAYS = PIXEL_KEYS.map((_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

type WorkPixelStyle = CSSProperties & { "--chat-work-delay": `${number}ms` };

/** The turn's activity glyph: a 3×3 pixel wave, frozen while the turn waits on the user. */
export function WorkPixelGrid({ active }: { active: boolean }) {
  return (
    // 3×4px + 2×1.5px = 15px，比思考/工具行的 12px 图标列宽：居中溢出到图标列
    // 宽度的盒子里，状态行的像素格才和上方的图标共用同一条竖中轴。
    <span
      aria-hidden="true"
      className="flex w-3 shrink-0 items-center justify-center"
      data-chat-work-grid=""
    >
      <span className="grid shrink-0 grid-cols-activity-dots gap-1p5px">
        {PIXEL_KEYS.map((key, index) => (
          <span
            key={key}
            className={cn(
              "size-1 bg-foreground opacity-15 animate-chat-work-pixel motion-reduce:animate-none",
              "data-paused:animate-none data-paused:opacity-45",
            )}
            data-paused={active ? undefined : ""}
            style={{ "--chat-work-delay": `${PIXEL_DELAYS[index] ?? 0}ms` } as WorkPixelStyle}
          />
        ))}
      </span>
    </span>
  );
}

/**
 * Debounce the turn's phase: a new phase only reaches the screen once it has
 * held for its delay (see stepRunPhase). With `immediate` every change shows
 * at once. Exactly one timer is armed at a time.
 */
export function useDebouncedRunPhase(target: RunPhaseTarget, immediate: boolean): RunPhase {
  const [state, setState] = useState<RunPhaseState>(() => initialRunPhaseState(target, immediate));
  const stateRef = useRef(state);
  stateRef.current = state;
  const targetRef = useRef(target);
  targetRef.current = target;

  // The effect reads the latest target through a ref; the phase and delay are
  // listed only to re-run it whenever the requested phase changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-arm triggers
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const advance = () => {
      timer = null;
      const { state: next, dueAt } = stepRunPhase(
        stateRef.current,
        targetRef.current,
        Date.now(),
        immediate,
      );
      if (next !== stateRef.current) {
        stateRef.current = next;
        setState(next);
      }
      if (dueAt !== null) timer = setTimeout(advance, Math.max(0, dueAt - Date.now()));
    };
    advance();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [target.phase, target.delayMs, immediate]);

  return state.shown;
}

function phaseLabel(
  phase: RunPhase,
  target: RunPhaseTarget,
  detailed: boolean,
  toolLabel: string | undefined,
  t: (key: string) => string,
) {
  // The detailed view names the raw backend stage while it is current.
  if (detailed && target.stage && target.phase === phase) {
    return t(`chat.runProgress.${target.stage}`);
  }
  switch (phase) {
    case "thinking":
      return t("chat.thinking");
    case "responding":
      return t("chat.runPhase.responding");
    case "tool":
      return toolLabel ?? t("chat.runProgress.tool");
    case "custom":
      return target.text ?? t("chat.work.running");
    case "working":
      return t("chat.work.running");
    default:
      return t(`chat.runProgress.${phase}`);
  }
}

/**
 * The one live status indicator of a running turn: a single compact row with
 * the activity glyph, the current phase in plain words and the turn's elapsed
 * time ("思考中 · 12s"). Short-lived bookkeeping phases are debounced away,
 * waiting for the model and reasoning share one "thinking" wording, and the
 * backend's diagnostic timings live in the row's tooltip. A turn blocked on
 * the user freezes the glyph and says so; context compaction shows its band.
 */
export function LiveTurnStatus(props: {
  status: string | null;
  /** Context compaction is running: show the compaction band instead. */
  compacting?: boolean;
  /** The turn is blocked on a user decision (question, plan, approval). */
  awaitingDecision?: boolean;
  /** Turn start (epoch ms) so the clock survives remounts; mount time otherwise. */
  startedAtMs?: number;
  /** A tool call is running (for runtimes without staged progress). */
  hasRunningTool?: boolean;
  /** Names the running call, e.g. "正在运行 pnpm test", for the tool phase. */
  toolActivity?: { label: string; title?: string } | null;
  className?: string;
}) {
  const {
    status,
    compacting = false,
    awaitingDecision = false,
    startedAtMs,
    hasRunningTool = false,
    toolActivity,
    className,
  } = props;
  const { t } = useLocale();
  const detailed = useDetailedProgress();
  const target = resolveRunPhaseTarget(status, {
    hasRunningTool: hasRunningTool || !!toolActivity,
  });
  const phase = useDebouncedRunPhase(target, detailed);
  const elapsedMs = useTurnElapsedMs({ running: true, startedAtMs, tick: true });

  if (compacting || target.phase === "compacting") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn("flex w-full min-w-0 max-w-full items-center py-1", className)}
        data-compacting-status=""
        data-live-turn-status=""
      >
        <CompactionBand active label={t("chat.compactingContext")} />
      </span>
    );
  }

  const progress = parseRunProgress(status);
  const timings = progress
    ? RUN_PROGRESS_TIMINGS.flatMap(([key, label]) =>
        progress[key] === undefined
          ? []
          : [
              {
                key,
                label: t(`chat.runProgress.${label}`),
                value: formatProgressSeconds(progress[key]),
              },
            ],
      )
    : [];
  const label = awaitingDecision
    ? t("chat.work.awaitingDecision")
    : phaseLabel(phase, target, detailed, toolActivity?.label, t);
  const elapsed = formatElapsedTime(elapsedMs);
  const tooltip = [
    phase === "tool" && toolActivity?.title ? toolActivity.title : null,
    ...timings.map((timing) => `${timing.label}: ${timing.value}`),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-w-0 max-w-full flex-col py-1 text-sm font-normal text-muted-foreground",
        className,
      )}
      data-live-turn-status=""
      data-phase={awaitingDecision ? "awaiting_decision" : phase}
      data-paused={awaitingDecision ? "" : undefined}
      title={tooltip || undefined}
    >
      <span className="flex min-w-0 items-center gap-2">
        <WorkPixelGrid active={!awaitingDecision} />
        <span className={cn("min-w-0 truncate", !awaitingDecision && "shimmer")}>{label}</span>
        {elapsed ? (
          <span className="-ml-1 shrink-0 tabular-nums text-foreground/45">· {elapsed}</span>
        ) : null}
      </span>
      {detailed && timings.length > 0 ? (
        <dl
          className="mt-1 ml-5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs"
          data-run-progress-timings=""
        >
          {timings.map((timing) => (
            <div className="contents" key={timing.key}>
              <dt className="break-words">{timing.label}</dt>
              <dd className="tabular-nums">{timing.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
