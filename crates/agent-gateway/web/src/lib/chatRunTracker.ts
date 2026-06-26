import type { RunningConversationRuntime } from "@/app/types";

export type ConversationRunState =
  | "idle"
  | "sending"
  | "queued_in_gui"
  | "remote_starting"
  | "remote_running"
  | "completing";

type ConversationRunEntry = {
  state: ConversationRunState;
  runId: string;
  workdir: string;
  firstSeq: number;
  runEpoch: number;
  updatedAt: number;
  abortController: AbortController | null;
  eventStreamController: AbortController | null;
  eventStreamRunKey: string;
  queuedInGuiAt: number | null;
  queuedInGuiTimeoutId: number | null;
  completedAt: number | null;
  completedRunId: string;
};

export type ChatRunTrackerSnapshot = {
  localRunningIds: ReadonlySet<string>;
  remoteRunningIds: ReadonlySet<string>;
  remoteRuntime: ReadonlyMap<string, RunningConversationRuntime>;
  version: number;
};

type Listener = () => void;
type ReconcileListener = (conversationId: string) => void;

const QUEUED_IN_GUI_TIMEOUT_MS = 60_000;

function emptyEntry(): ConversationRunEntry {
  return {
    state: "idle",
    runId: "",
    workdir: "",
    firstSeq: 0,
    runEpoch: 0,
    updatedAt: 0,
    abortController: null,
    eventStreamController: null,
    eventStreamRunKey: "",
    queuedInGuiAt: null,
    queuedInGuiTimeoutId: null,
    completedAt: null,
    completedRunId: "",
  };
}

export function resolveRunKey(
  runtime: Pick<RunningConversationRuntime, "runId"> | null | undefined,
): string {
  return runtime?.runId?.trim() ?? "";
}

export class ChatRunTracker {
  private entries = new Map<string, ConversationRunEntry>();
  private localRunningIds = new Set<string>();
  private remoteRunningIds = new Set<string>();
  private remoteRuntimeMap = new Map<string, RunningConversationRuntime>();
  private blockedHistoryHydrationIds = new Set<string>();
  private chatStartLocks = new Set<string>();
  private pendingHistoryRefresh = new Set<string>();
  private listeners = new Set<Listener>();
  private reconcileListeners = new Set<ReconcileListener>();
  private version = 0;
  private snapshotCache: ChatRunTrackerSnapshot | null = null;
  private snapshotVersion = -1;

  private getEntry(id: string): ConversationRunEntry {
    return this.entries.get(id) ?? emptyEntry();
  }

  private setEntry(id: string, entry: ConversationRunEntry) {
    if (
      entry.state === "idle" &&
      !entry.eventStreamController &&
      !entry.completedAt
    ) {
      this.entries.delete(id);
    } else {
      this.entries.set(id, entry);
    }
  }

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private emitReconcile(conversationId: string) {
    for (const listener of this.reconcileListeners) {
      listener(conversationId);
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onReconcile(listener: ReconcileListener): () => void {
    this.reconcileListeners.add(listener);
    return () => {
      this.reconcileListeners.delete(listener);
    };
  }

  getSnapshot = (): ChatRunTrackerSnapshot => {
    if (this.snapshotVersion === this.version && this.snapshotCache) {
      return this.snapshotCache;
    }
    this.snapshotCache = {
      localRunningIds: new Set(this.localRunningIds),
      remoteRunningIds: new Set(this.remoteRunningIds),
      remoteRuntime: new Map(this.remoteRuntimeMap),
      version: this.version,
    };
    this.snapshotVersion = this.version;
    return this.snapshotCache;
  };

  // --- State queries ---

  getState(id: string): ConversationRunState {
    return this.getEntry(id).state;
  }

  getRunId(id: string): string {
    return this.getEntry(id).runId;
  }

  getAbortController(id: string): AbortController | null {
    return this.getEntry(id).abortController;
  }

  getRuntime(id: string): RunningConversationRuntime | null {
    return this.remoteRuntimeMap.get(id) ?? null;
  }

  getEventStreamController(id: string): AbortController | null {
    return this.getEntry(id).eventStreamController;
  }

  getEventStreamRunKey(id: string): string {
    return this.getEntry(id).eventStreamRunKey;
  }

  getFullEntry(id: string): Readonly<ConversationRunEntry> {
    return this.getEntry(id);
  }

  isLocalRunning(id: string): boolean {
    return this.localRunningIds.has(id);
  }

  isRemoteRunning(id: string): boolean {
    return this.remoteRunningIds.has(id);
  }

  isAwaitingRemote(id: string): boolean {
    return this.getEntry(id).state === "queued_in_gui";
  }

  isActive(id: string): boolean {
    const state = this.getEntry(id).state;
    return state !== "idle";
  }

  hasActiveStream(id: string): boolean {
    return this.getEntry(id).eventStreamController !== null;
  }

  hasStartLock(id: string): boolean {
    return this.chatStartLocks.has(id);
  }

  addStartLock(id: string) {
    this.chatStartLocks.add(id);
  }

  deleteStartLock(id: string) {
    this.chatStartLocks.delete(id);
  }

  clearStartLocks() {
    this.chatStartLocks.clear();
  }

  isHistoryHydrationBlocked(id: string): boolean {
    return this.blockedHistoryHydrationIds.has(id);
  }

  blockHistoryHydration(id: string) {
    this.blockedHistoryHydrationIds.add(id);
  }

  unblockHistoryHydration(id: string) {
    this.blockedHistoryHydrationIds.delete(id);
  }

  hasPendingHistoryRefresh(id: string): boolean {
    return this.pendingHistoryRefresh.has(id);
  }

  addPendingHistoryRefresh(id: string) {
    this.pendingHistoryRefresh.add(id);
  }

  deletePendingHistoryRefresh(id: string): boolean {
    return this.pendingHistoryRefresh.delete(id);
  }

  canSubscribeEventStream(id: string): boolean {
    const state = this.getEntry(id).state;
    return (
      state === "remote_starting" ||
      state === "remote_running" ||
      state === "queued_in_gui"
    );
  }

  // --- Completion suppression (run-ID-aware) ---

  shouldSuppressIdleEvent(id: string, eventRunId: string): boolean {
    const entry = this.getEntry(id);
    if (!entry.completedAt) return false;
    if (Date.now() - entry.completedAt > 30_000) {
      this.clearCompletionMarker(id);
      return false;
    }
    if (!eventRunId || !entry.completedRunId) return true;
    return entry.completedRunId === eventRunId;
  }

  private clearCompletionMarker(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.completedAt = null;
    entry.completedRunId = "";
    this.setEntry(id, entry);
  }

  // --- State machine transitions ---

  markSending(id: string, controller: AbortController) {
    const entry = this.getEntry(id);
    this.clearQueuedTimeout(entry);
    entry.state = "sending";
    entry.abortController = controller;
    entry.completedAt = null;
    entry.completedRunId = "";
    this.setEntry(id, entry);
    this.localRunningIds.add(id);
    this.emit();
    this.emitReconcile(id);
  }

  markQueuedInGui(id: string) {
    const entry = this.getEntry(id);
    this.clearQueuedTimeout(entry);
    entry.state = "queued_in_gui";
    entry.abortController = null;
    entry.queuedInGuiAt = Date.now();
    entry.completedAt = null;
    entry.completedRunId = "";
    this.localRunningIds.delete(id);

    entry.queuedInGuiTimeoutId = window.setTimeout(() => {
      const current = this.entries.get(id);
      if (current?.state === "queued_in_gui") {
        this.clearQueuedTimeout(current);
        current.state = "idle";
        this.setEntry(id, current);
        this.emit();
        this.emitReconcile(id);
      }
    }, QUEUED_IN_GUI_TIMEOUT_MS);

    this.setEntry(id, entry);
    this.emit();
    this.emitReconcile(id);
  }

  markRemoteRunning(id: string, runtime: RunningConversationRuntime) {
    const runId = runtime.runId?.trim() ?? "";
    if (!runId) return;

    const entry = this.getEntry(id);
    this.clearQueuedTimeout(entry);

    if (
      entry.eventStreamController &&
      entry.eventStreamRunKey &&
      entry.eventStreamRunKey !== runId
    ) {
      entry.eventStreamController.abort();
      entry.eventStreamController = null;
      entry.eventStreamRunKey = "";
    }

    entry.state = "remote_running";
    entry.runId = runId;
    entry.workdir = runtime.workdir ?? "";
    entry.firstSeq = runtime.firstSeq ?? 0;
    entry.runEpoch = runtime.runEpoch ?? 0;
    entry.updatedAt = runtime.updatedAt ?? Date.now();
    entry.abortController = null;
    entry.queuedInGuiAt = null;
    entry.completedAt = null;
    entry.completedRunId = "";

    this.localRunningIds.delete(id);
    this.remoteRunningIds.add(id);
    this.remoteRuntimeMap.set(id, runtime);
    this.setEntry(id, entry);
    this.emit();
    this.emitReconcile(id);
  }

  markCompleted(id: string) {
    const entry = this.getEntry(id);
    this.clearQueuedTimeout(entry);
    entry.completedAt = Date.now();
    entry.completedRunId = entry.runId;
    entry.state = "idle";
    entry.abortController = null;
    entry.queuedInGuiAt = null;
    this.localRunningIds.delete(id);
    this.remoteRunningIds.delete(id);
    this.remoteRuntimeMap.delete(id);
    this.setEntry(id, entry);
    this.emit();
    this.emitReconcile(id);
  }

  markCancelled(id: string) {
    const entry = this.getEntry(id);
    this.clearQueuedTimeout(entry);
    entry.state = "idle";
    entry.runId = "";
    entry.abortController = null;
    entry.eventStreamController?.abort();
    entry.eventStreamController = null;
    entry.eventStreamRunKey = "";
    entry.completedAt = null;
    entry.completedRunId = "";
    entry.queuedInGuiAt = null;
    this.localRunningIds.delete(id);
    this.remoteRunningIds.delete(id);
    this.remoteRuntimeMap.delete(id);
    this.setEntry(id, entry);
    this.emit();
    this.emitReconcile(id);
  }

  markIdle(id: string) {
    const entry = this.getEntry(id);
    this.clearQueuedTimeout(entry);
    entry.state = "idle";
    entry.runId = "";
    entry.abortController = null;
    entry.queuedInGuiAt = null;
    this.localRunningIds.delete(id);
    this.remoteRunningIds.delete(id);
    this.remoteRuntimeMap.delete(id);
    this.setEntry(id, entry);
    this.emit();
    this.emitReconcile(id);
  }

  // --- Abort / stream management ---

  setAbortController(id: string, controller: AbortController | null) {
    const entry = this.getEntry(id);
    entry.abortController = controller;
    this.setEntry(id, entry);
  }

  clearAbortController(id: string) {
    this.setAbortController(id, null);
  }

  setEventStreamController(
    id: string,
    controller: AbortController,
    runKey: string,
  ) {
    const entry = this.getEntry(id);
    entry.eventStreamController = controller;
    entry.eventStreamRunKey = runKey;
    this.setEntry(id, entry);
  }

  clearEventStreamController(id: string) {
    const entry = this.getEntry(id);
    if (!entry.eventStreamController) return;
    entry.eventStreamController = null;
    entry.eventStreamRunKey = "";
    this.setEntry(id, entry);
  }

  stopEventStream(id: string) {
    const entry = this.getEntry(id);
    if (!entry.eventStreamController) return;
    const controller = entry.eventStreamController;
    entry.eventStreamController = null;
    entry.eventStreamRunKey = "";
    this.setEntry(id, entry);
    controller.abort();
  }

  stopAllEventStreams() {
    for (const [id, entry] of this.entries) {
      if (entry.eventStreamController) {
        const controller = entry.eventStreamController;
        entry.eventStreamController = null;
        entry.eventStreamRunKey = "";
        this.setEntry(id, entry);
        controller.abort();
      }
    }
  }

  clearStreamingState(
    id: string,
    options?: {
      remoteRunId?: string;
      preserveRemoteRun?: boolean;
      preserveRemoteRunOnMismatch?: boolean;
    },
  ) {
    const entry = this.getEntry(id);
    const expectedRunKey = resolveRunKey({ runId: options?.remoteRunId });
    const currentRunKey = entry.runId;
    const shouldClearRemote =
      !options?.preserveRemoteRun &&
      (!options?.preserveRemoteRunOnMismatch ||
        !expectedRunKey ||
        !currentRunKey ||
        expectedRunKey === currentRunKey);

    if (shouldClearRemote) {
      this.clearQueuedTimeout(entry);
      entry.state = "idle";
      entry.runId = "";
      this.remoteRunningIds.delete(id);
      this.remoteRuntimeMap.delete(id);
    }

    entry.abortController = null;
    this.localRunningIds.delete(id);
    this.setEntry(id, entry);
    this.emit();
    this.emitReconcile(id);
  }

  // --- Lifecycle ---

  resetAll() {
    for (const entry of this.entries.values()) {
      this.clearQueuedTimeout(entry);
    }
    this.entries.clear();
    this.localRunningIds.clear();
    this.remoteRunningIds.clear();
    this.remoteRuntimeMap.clear();
    this.blockedHistoryHydrationIds.clear();
    this.chatStartLocks.clear();
    this.pendingHistoryRefresh.clear();
    this.emit();
  }

  deleteConversation(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      this.clearQueuedTimeout(entry);
      entry.eventStreamController?.abort();
    }
    this.entries.delete(id);
    this.localRunningIds.delete(id);
    this.remoteRunningIds.delete(id);
    this.remoteRuntimeMap.delete(id);
    this.blockedHistoryHydrationIds.delete(id);
    this.chatStartLocks.delete(id);
    this.pendingHistoryRefresh.delete(id);
    this.emit();
  }

  private clearQueuedTimeout(entry: ConversationRunEntry) {
    if (entry.queuedInGuiTimeoutId !== null) {
      window.clearTimeout(entry.queuedInGuiTimeoutId);
      entry.queuedInGuiTimeoutId = null;
    }
  }
}
