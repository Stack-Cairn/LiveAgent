import type {
  HistoryMigrationOutcome,
  HistoryMigrationProgress,
  HistoryMigrationSource,
} from "../kbrain/historyMigration";

export type StartupPhase = "connecting" | "checking" | "migrating" | "opening" | "error";
export type SourceProgress = {
  operationStartedAt: number;
  operation: HistoryMigrationProgress["operation"] | "waiting";
  counts: Record<HistoryMigrationOutcome, number>;
};
export type StartupProgress = {
  phase: StartupPhase;
  startedAt: number;
  lastProgressAt: number;
  sources: Record<HistoryMigrationSource, SourceProgress>;
};
const source = (now: number): SourceProgress => ({
  operationStartedAt: now,
  operation: "waiting",
  counts: { imported: 0, alreadyImported: 0, skipped: 0, failed: 0, partial: 0 },
});
export function createStartupProgress(now = Date.now()): StartupProgress {
  return {
    phase: "connecting",
    startedAt: now,
    lastProgressAt: now,
    sources: { legacy: source(now), pi: source(now) },
  };
}
export function applyMigrationProgress(
  state: StartupProgress,
  event: HistoryMigrationProgress,
  now = Date.now(),
): StartupProgress {
  const previous = state.sources[event.source];
  const counts = { ...previous.counts };
  if (event.operation === "settled" && event.outcome) counts[event.outcome] += 1;
  return {
    ...state,
    phase:
      event.operation === "processing" ||
      event.operation === "importing" ||
      event.operation === "settled"
        ? "migrating"
        : state.phase,
    lastProgressAt:
      previous.operation !== event.operation || event.operation === "settled"
        ? now
        : state.lastProgressAt,
    sources: {
      ...state.sources,
      [event.source]: {
        operation: event.operation,
        counts,
        operationStartedAt:
          event.operation === previous.operation && event.operation === "reading"
            ? previous.operationStartedAt
            : now,
      },
    },
  };
}
export function migrationCounts(state: StartupProgress) {
  const a = state.sources.legacy.counts;
  const b = state.sources.pi.counts;
  const counts = {
    imported: a.imported + b.imported,
    alreadyImported: a.alreadyImported + b.alreadyImported,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    partial: a.partial + b.partial,
  };
  return { ...counts, processed: Object.values(counts).reduce((sum, count) => sum + count, 0) };
}
