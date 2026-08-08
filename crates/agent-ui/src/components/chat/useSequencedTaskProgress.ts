import { useEffect, useRef, useState } from "react";
import {
  applyTodoProgressUpdate,
  foldTodoProgressUpdates,
  type TodoProgressPlan,
  type TodoProgressSnapshot,
  type TodoProgressUpdate,
  todoProgressSnapshotSignature,
} from "../../lib/chat/taskProgress";

export const TASK_PROGRESS_SEQUENCE_STEP_MS = 180;
export const TASK_PROGRESS_ARGUMENT_STABLE_MS = 240;

type QueuedSnapshot = {
  snapshot: TodoProgressSnapshot | null;
  signature: string;
};

type PendingArgumentUpdate = {
  update: TodoProgressUpdate;
};

function updateSignature(update: TodoProgressUpdate): string {
  const phase = update.settled === false ? "arguments" : "settled";
  const snapshot =
    update.snapshot === undefined ? "invalid" : todoProgressSnapshotSignature(update.snapshot);
  return `${phase}:${snapshot}`;
}

function foldVisibleUpdates(
  updates: readonly TodoProgressUpdate[],
  isConversationRunning: boolean,
): TodoProgressPlan {
  return foldTodoProgressUpdates(
    isConversationRunning ? updates.filter((update) => update.settled !== false) : updates,
  );
}

export function useSequencedTaskProgress(
  updates: readonly TodoProgressUpdate[],
  isConversationRunning = true,
): TodoProgressSnapshot | null {
  const latestUpdate = updates[updates.length - 1];
  const latestUpdateClears = latestUpdate?.settled !== false && latestUpdate?.snapshot === null;
  const initialPlan = foldVisibleUpdates(updates, isConversationRunning);
  const initialSnapshot = initialPlan.snapshot;
  const [displayedSnapshot, setDisplayedSnapshot] = useState<TodoProgressSnapshot | null>(
    initialSnapshot,
  );
  const initializedRef = useRef(false);
  const planRef = useRef<TodoProgressPlan>(initialPlan);
  const seenSignaturesRef = useRef(new Map<string, string>());
  const queueRef = useRef<QueuedSnapshot[]>([]);
  const timerRef = useRef<number | null>(null);
  const argumentTimerRef = useRef<number | null>(null);
  const pendingArgumentRef = useRef<PendingArgumentUpdate | null>(null);
  const displayedSignatureRef = useRef(todoProgressSnapshotSignature(initialSnapshot));
  const drainRef = useRef<() => void>(() => undefined);
  const enqueueSnapshotRef = useRef<(snapshot: TodoProgressSnapshot | null) => void>(
    () => undefined,
  );
  const clearArgumentFallbackRef = useRef<(key?: string) => void>(() => undefined);
  const scheduleArgumentFallbackRef = useRef<(update: TodoProgressUpdate) => void>(() => undefined);

  drainRef.current = () => {
    const next = queueRef.current.shift();
    if (!next) {
      timerRef.current = null;
      return;
    }
    displayedSignatureRef.current = next.signature;
    setDisplayedSnapshot(next.snapshot);
    if (queueRef.current.length > 0) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        drainRef.current();
      }, TASK_PROGRESS_SEQUENCE_STEP_MS);
    } else {
      timerRef.current = null;
    }
  };

  enqueueSnapshotRef.current = (snapshot: TodoProgressSnapshot | null) => {
    const signature = todoProgressSnapshotSignature(snapshot);
    const tailSignature =
      queueRef.current[queueRef.current.length - 1]?.signature ?? displayedSignatureRef.current;
    if (signature === tailSignature) return;
    queueRef.current.push({ snapshot, signature });
    if (timerRef.current === null) drainRef.current();
  };

  clearArgumentFallbackRef.current = (key?: string) => {
    if (key && pendingArgumentRef.current?.update.key !== key) return;
    if (argumentTimerRef.current !== null) window.clearTimeout(argumentTimerRef.current);
    argumentTimerRef.current = null;
    pendingArgumentRef.current = null;
  };

  scheduleArgumentFallbackRef.current = (update: TodoProgressUpdate) => {
    clearArgumentFallbackRef.current();
    if (update.snapshot === undefined) return;
    pendingArgumentRef.current = { update };
    argumentTimerRef.current = window.setTimeout(() => {
      argumentTimerRef.current = null;
      const pending = pendingArgumentRef.current;
      pendingArgumentRef.current = null;
      if (!pending) return;
      const nextPlan = applyTodoProgressUpdate(planRef.current, pending.update);
      planRef.current = nextPlan;
      enqueueSnapshotRef.current(nextPlan.snapshot);
    }, TASK_PROGRESS_ARGUMENT_STABLE_MS);
  };

  useEffect(() => {
    const seen = seenSignaturesRef.current;
    if (!initializedRef.current) {
      for (const update of updates) {
        seen.set(update.key, updateSignature(update));
      }
      planRef.current = foldVisibleUpdates(updates, isConversationRunning);
      initializedRef.current = true;
      const provisional = updates[updates.length - 1];
      if (isConversationRunning && provisional?.settled === false) {
        scheduleArgumentFallbackRef.current(provisional);
      }
      return;
    }
    if (updates.length === 0) {
      // Live rounds may disappear one render before their persisted history
      // replacement arrives. Keep the last visible state through that handoff.
      return;
    }

    const hadSeenUpdates = seen.size > 0;
    if (!hadSeenUpdates && !isConversationRunning) {
      // An idle empty -> populated transition is history hydration, not new
      // live progress. Adopt the restored conversation without replaying it.
      const hydratedPlan = foldTodoProgressUpdates(updates);
      for (const update of updates) {
        seen.set(update.key, updateSignature(update));
      }
      planRef.current = hydratedPlan;
      displayedSignatureRef.current = todoProgressSnapshotSignature(hydratedPlan.snapshot);
      setDisplayedSnapshot(hydratedPlan.snapshot);
      return;
    }
    let lastSeenIndex = -1;
    for (let index = 0; index < updates.length; index += 1) {
      if (seen.has(updates[index]?.key ?? "")) lastSeenIndex = index;
    }

    if (hadSeenUpdates && lastSeenIndex < 0) {
      // A non-overlapping history replacement is not a live append. Adopt its
      // latest state without replaying an entire restored conversation.
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      queueRef.current = [];
      clearArgumentFallbackRef.current();
      for (const update of updates) {
        seen.set(update.key, updateSignature(update));
      }
      const replacementPlan = foldVisibleUpdates(updates, isConversationRunning);
      planRef.current = replacementPlan;
      displayedSignatureRef.current = todoProgressSnapshotSignature(replacementPlan.snapshot);
      setDisplayedSnapshot(replacementPlan.snapshot);
      const provisional = updates[updates.length - 1];
      if (isConversationRunning && provisional?.settled === false) {
        scheduleArgumentFallbackRef.current(provisional);
      }
      return;
    }

    const candidates: QueuedSnapshot[] = [];
    const provisionalUpdates: PendingArgumentUpdate[] = [];
    let nextPlan = planRef.current;
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index];
      if (!update) continue;
      const signature = updateSignature(update);
      const previousSignature = seen.get(update.key);
      if (
        (previousSignature !== undefined && previousSignature !== signature) ||
        (previousSignature === undefined && (!hadSeenUpdates || index > lastSeenIndex))
      ) {
        if (update.settled === false) {
          provisionalUpdates.push({ update });
        } else {
          clearArgumentFallbackRef.current(update.key);
          nextPlan = applyTodoProgressUpdate(nextPlan, update);
          if (update.snapshot !== null && update.snapshot !== undefined) {
            candidates.push({
              snapshot: nextPlan.snapshot,
              signature: todoProgressSnapshotSignature(nextPlan.snapshot),
            });
          }
        }
      }
      seen.set(update.key, signature);
    }
    planRef.current = nextPlan;

    if (latestUpdateClears) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      queueRef.current = [];
      clearArgumentFallbackRef.current();
      displayedSignatureRef.current = todoProgressSnapshotSignature(nextPlan.snapshot);
      setDisplayedSnapshot(nextPlan.snapshot);
      return;
    }

    let tailSignature =
      queueRef.current[queueRef.current.length - 1]?.signature ?? displayedSignatureRef.current;
    for (const candidate of candidates) {
      if (candidate.signature === tailSignature) continue;
      queueRef.current.push(candidate);
      tailSignature = candidate.signature;
    }
    if (timerRef.current === null && queueRef.current.length > 0) drainRef.current();
    for (const provisional of provisionalUpdates) {
      scheduleArgumentFallbackRef.current(provisional.update);
    }
  }, [isConversationRunning, latestUpdateClears, updates]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      queueRef.current = [];
      if (argumentTimerRef.current !== null) window.clearTimeout(argumentTimerRef.current);
      argumentTimerRef.current = null;
      pendingArgumentRef.current = null;
    },
    [],
  );

  return latestUpdateClears ? null : displayedSnapshot;
}
