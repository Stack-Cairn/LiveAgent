import { normalizeLiveToolStatus, VIBING_STATUS } from "./assistantStatus";
import { parseRunProgress, type RunProgress } from "./runProgress";

/**
 * What the single live status row of a running turn says. Backend stages are
 * folded into a few plain phases: waiting for the model and streaming its
 * reasoning both read as "thinking", and short-lived bookkeeping stages
 * (preparing, persisting, waiting for the previous task, connecting) only show
 * once they last long enough to matter. Stages that mean the turn is genuinely
 * blocked (reconnecting, compacting) are explicit and show at once.
 */
export type RunPhase =
  | "working"
  | "thinking"
  | "responding"
  | "tool"
  | "preparing"
  | "persisting"
  | "connecting"
  | "reconnecting"
  | "waiting_session"
  | "compacting"
  | "custom";

export type RunPhaseTarget = {
  phase: RunPhase;
  /** Raw backend stage, used by the detailed view and diagnostics. */
  stage: RunProgress["stage"] | null;
  /** Free-form status text for runtimes that do not emit staged progress. */
  text: string | null;
  /** How long the phase must hold before the quiet view switches to it. */
  delayMs: number;
  /** Whether a freshly mounted row may show this phase without waiting. */
  showOnMount: boolean;
};

/** Phase changes shorter than this never reach the screen in the quiet view. */
export const RUN_PHASE_DEBOUNCE_MS = 800;
/** A model wait only becomes "thinking" once the wait is noticeable. */
export const RUN_PHASE_MODEL_WAIT_MS = 1_500;

const STAGE_PHASES: Record<
  RunProgress["stage"],
  { phase: RunPhase; delayMs: number; showOnMount: boolean }
> = {
  connecting: { phase: "connecting", delayMs: RUN_PHASE_DEBOUNCE_MS, showOnMount: false },
  reconnecting: { phase: "reconnecting", delayMs: 0, showOnMount: true },
  waiting_session: { phase: "waiting_session", delayMs: RUN_PHASE_DEBOUNCE_MS, showOnMount: false },
  preparing: { phase: "preparing", delayMs: RUN_PHASE_DEBOUNCE_MS, showOnMount: false },
  compacting: { phase: "compacting", delayMs: 0, showOnMount: true },
  waiting_model: { phase: "thinking", delayMs: RUN_PHASE_MODEL_WAIT_MS, showOnMount: false },
  thinking: { phase: "thinking", delayMs: RUN_PHASE_DEBOUNCE_MS, showOnMount: true },
  responding: { phase: "responding", delayMs: RUN_PHASE_DEBOUNCE_MS, showOnMount: true },
  tool: { phase: "tool", delayMs: RUN_PHASE_DEBOUNCE_MS, showOnMount: true },
  persisting: { phase: "persisting", delayMs: RUN_PHASE_DEBOUNCE_MS, showOnMount: false },
};

/**
 * Map the live tool status of a turn to the phase its status row should move
 * to. `hasRunningTool` covers runtimes without staged progress, where a
 * running call is the only signal that a tool is executing.
 */
export function resolveRunPhaseTarget(
  status: string | null | undefined,
  options: { hasRunningTool?: boolean } = {},
): RunPhaseTarget {
  const progress = parseRunProgress(status);
  if (progress) {
    return { ...STAGE_PHASES[progress.stage], stage: progress.stage, text: null };
  }
  if (options.hasRunningTool) {
    return {
      phase: "tool",
      stage: null,
      text: null,
      delayMs: RUN_PHASE_DEBOUNCE_MS,
      showOnMount: true,
    };
  }
  const normalized = normalizeLiveToolStatus(status ?? null)?.trim();
  if (normalized && normalized !== VIBING_STATUS) {
    return {
      phase: "custom",
      stage: null,
      text: normalized,
      delayMs: RUN_PHASE_DEBOUNCE_MS,
      showOnMount: true,
    };
  }
  return {
    phase: "working",
    stage: null,
    text: null,
    delayMs: RUN_PHASE_DEBOUNCE_MS,
    showOnMount: false,
  };
}

export type RunPhaseState = {
  /** The phase on screen. */
  shown: RunPhase;
  /** A different phase waiting out its delay, with the time it was first requested. */
  pending: { phase: RunPhase; since: number; delayMs: number } | null;
};

export function initialRunPhaseState(target: RunPhaseTarget, immediate: boolean): RunPhaseState {
  return {
    shown: immediate || target.showOnMount ? target.phase : "working",
    pending: null,
  };
}

/**
 * Advance the debounced phase. Returns the next state plus the time at which
 * the pending phase is due (null when nothing is pending), so the caller can
 * schedule exactly one timer. With `immediate` (the detailed view) every
 * change shows at once.
 *
 * A pending phase keeps its original start when the raw stage changes but the
 * phase does not (waiting for the model, then reasoning), and adopts the
 * shorter delay of the two, so "thinking" appears 800 ms after reasoning
 * starts or 1.5 s after the model request, whichever comes first.
 */
export function stepRunPhase(
  state: RunPhaseState,
  target: RunPhaseTarget,
  now: number,
  immediate = false,
): { state: RunPhaseState; dueAt: number | null } {
  if (target.phase === state.shown) {
    return { state: state.pending ? { shown: state.shown, pending: null } : state, dueAt: null };
  }
  if (immediate || target.delayMs <= 0) {
    return { state: { shown: target.phase, pending: null }, dueAt: null };
  }
  const pending =
    state.pending?.phase === target.phase
      ? { ...state.pending, delayMs: Math.min(state.pending.delayMs, target.delayMs) }
      : { phase: target.phase, since: now, delayMs: target.delayMs };
  const dueAt = pending.since + pending.delayMs;
  if (now >= dueAt) {
    return { state: { shown: target.phase, pending: null }, dueAt: null };
  }
  const unchanged =
    state.pending?.phase === pending.phase &&
    state.pending.since === pending.since &&
    state.pending.delayMs === pending.delayMs;
  return { state: unchanged ? state : { shown: state.shown, pending }, dueAt };
}

/** Diagnostic timings carried by a staged progress status, in display order. */
export const RUN_PROGRESS_TIMINGS = [
  ["elapsed_ms", "backend"],
  ["model_request_ms", "modelRequest"],
  ["first_thinking_ms", "firstThinking"],
  ["first_text_ms", "firstText"],
  ["client_first_text_ms", "clientFirstText"],
] as const;

export function formatProgressSeconds(ms: number) {
  return `${(ms / 1000).toFixed(2)} s`;
}
