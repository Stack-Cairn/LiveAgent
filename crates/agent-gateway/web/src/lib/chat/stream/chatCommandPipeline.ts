import type { HistoryMessageRef } from "../conversationState";
import type { TranscriptStore } from "../transcript/transcriptStore";
import type { ChatCommandAccepted, ChatCommandUpdate } from "./streamTypes";

// Command lifecycle for chat submissions from this client. The pipeline owns
// the optimistic user echo and reacts to pre-stream outcomes
// (chat.command_update); everything after run start flows through the
// conversation stream and needs no pipeline involvement.

export type ChatCommandRequest = {
  conversationId: string;
  clientRequestId: string;
  message: string;
  attachments?: Extract<
    Parameters<TranscriptStore["addOptimisticUserEntry"]>[0]["attachments"],
    unknown
  >;
  referencedConversations?: Extract<
    Parameters<TranscriptStore["addOptimisticUserEntry"]>[0]["referencedConversations"],
    unknown
  >;
  // edit_resend commands apply the truncation and replacement bubble in the
  // same optimistic transcript commit. Compensation paths
  // (queued_in_gui / failed) need to know to restore the persisted suffix.
  isEditResend?: boolean;
  baseMessageRef?: HistoryMessageRef;
  // Queue-destined submissions (a run is already streaming) skip the local
  // echo: the prompt belongs in the queue panel, and a transcript bubble
  // would just flash until the queued_in_gui compensation removed it.
  optimistic?: boolean;
  waitForStart?: boolean;
  submit: () => Promise<ChatCommandAccepted>;
};

export type PendingChatCommand = {
  runId: string | null;
  clientRequestId: string;
  conversationId: string;
  isEditResend: boolean;
  submittedAt: number;
  waitForStart?: boolean;
};

export type ChatCommandOutcome =
  | { kind: "accepted"; accepted: ChatCommandAccepted }
  | { kind: "queued_in_gui"; update: ChatCommandUpdate }
  | { kind: "bound"; update: ChatCommandUpdate }
  | { kind: "settled" }
  | { kind: "failed"; errorCode: string | null; message: string };

export type ChatCommandPipelineHooks = {
  getTranscriptStore(conversationId: string): TranscriptStore;
  // A draft conversation got its real id: re-key stores/subscriptions.
  onBound?(update: ChatCommandUpdate, pending: PendingChatCommand): void;
  onQueuedInGui?(update: ChatCommandUpdate, pending: PendingChatCommand): void;
  onFailed?(pending: PendingChatCommand, errorCode: string | null, message: string): void;
  onPendingChanged?(): void;
};

const PENDING_COMMAND_TIMEOUT_MS = 60_000;

export class ChatCommandPipeline {
  // conversationId → pending command (one in-flight submission per
  // conversation drives the pre-first-token spinner).
  private pending = new Map<string, PendingChatCommand>();
  private byRunId = new Map<string, PendingChatCommand>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private settledOutcomes = new WeakMap<PendingChatCommand, ChatCommandOutcome>();
  private boundConversationIds = new Map<string, string>();
  private bindingWaiters = new WeakMap<PendingChatCommand, Set<(id: string | null) => void>>();
  private startWaiters = new WeakMap<PendingChatCommand, (outcome: ChatCommandOutcome) => void>();
  private submissions = new WeakMap<PendingChatCommand, () => Promise<ChatCommandAccepted>>();

  resumePendingCommands(): void {
    for (const pending of this.pending.values()) {
      if (!pending.waitForStart) continue;
      // Re-submit the same request identity to replay its command update/watch.
      void this.submissions
        .get(pending)?.()
        .then((accepted) => {
          this.registerAcceptance(pending, accepted);
        })
        .catch(() => undefined);
    }
  }

  constructor(private readonly hooks: ChatCommandPipelineHooks) {}

  private registerAcceptance(pending: PendingChatCommand, accepted: ChatCommandAccepted): void {
    if (this.pending.get(pending.conversationId) !== pending) return;
    pending.runId = accepted.runId;
    this.byRunId.set(accepted.runId, pending);
    if (
      pending.waitForStart &&
      accepted.conversationId &&
      accepted.conversationId !== pending.conversationId
    ) {
      this.handleCommandUpdate({
        runId: accepted.runId,
        clientRequestId: pending.clientRequestId,
        conversationId: accepted.conversationId,
        phase: "bound",
        errorCode: null,
        message: null,
      });
    }
  }

  hasPending(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  resolveConversationId(conversationId: string): string {
    return this.boundConversationIds.get(conversationId) ?? conversationId;
  }

  waitForConversationBinding(conversationId: string): Promise<string | null> {
    const resolved = this.resolveConversationId(conversationId);
    if (resolved !== conversationId) return Promise.resolve(resolved);
    const pending = this.pending.get(conversationId);
    if (!pending) return Promise.resolve(null);
    return new Promise((resolve) => {
      let waiters = this.bindingWaiters.get(pending);
      if (!waiters) {
        waiters = new Set();
        this.bindingWaiters.set(pending, waiters);
      }
      waiters.add(resolve);
    });
  }

  private settleBindingWaiters(pending: PendingChatCommand, conversationId: string | null): void {
    const waiters = this.bindingWaiters.get(pending);
    this.bindingWaiters.delete(pending);
    for (const resolve of waiters ?? []) resolve(conversationId);
  }

  // Conversations with an in-flight submission — activity hydration must not
  // drop these even when an authoritative snapshot does not list them yet.
  pendingConversationIds(): Set<string> {
    return new Set(this.pending.keys());
  }

  reset(): void {
    for (const pending of this.pending.values()) {
      const store = this.hooks.getTranscriptStore(pending.conversationId);
      if (pending.isEditResend) {
        store.restoreEditResendTranscript?.(pending.clientRequestId);
      }
      store.removeOptimisticUserEntry(pending.clientRequestId);
      this.settledOutcomes.set(pending, { kind: "settled" });
      this.startWaiters.get(pending)?.({ kind: "settled" });
      this.startWaiters.delete(pending);
      this.settleBindingWaiters(pending, null);
    }
    this.boundConversationIds.clear();
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.pending.clear();
    this.byRunId.clear();
    this.timeouts.clear();
    this.hooks.onPendingChanged?.();
  }

  async submit(request: ChatCommandRequest): Promise<ChatCommandOutcome> {
    if (request.optimistic !== false) {
      this.hooks.getTranscriptStore(request.conversationId).addOptimisticUserEntry({
        clientRequestId: request.clientRequestId,
        text: request.message,
        attachments: request.attachments as never,
        referencedConversations: request.referencedConversations as never,
        baseMessageRef: request.baseMessageRef,
      });
    }

    const pending: PendingChatCommand = {
      runId: null,
      clientRequestId: request.clientRequestId,
      conversationId: request.conversationId,
      isEditResend: request.isEditResend === true,
      submittedAt: Date.now(),
      waitForStart: request.waitForStart,
    };
    const started = request.waitForStart
      ? new Promise<ChatCommandOutcome>((resolve) => this.startWaiters.set(pending, resolve))
      : null;
    this.submissions.set(pending, request.submit);
    this.setPending(request.conversationId, pending);

    try {
      const accepted = await request.submit();
      const settledOutcome = this.settledOutcomes.get(pending);
      if (settledOutcome) {
        return settledOutcome;
      }
      if (this.pending.get(pending.conversationId) === pending) {
        // Only register while the pending is still live: an own run signal
        // (matched by client_request_id) may have settled it before the
        // accept response landed, and a dead registration would leak.
        this.registerAcceptance(pending, accepted);
      }
      return started ? await started : { kind: "accepted", accepted };
    } catch (error) {
      const settledOutcome = this.settledOutcomes.get(pending);
      if (settledOutcome) {
        return settledOutcome;
      }
      const message = error instanceof Error ? error.message : "chat command failed";
      return this.fail(pending, null, message);
    }
  }

  // chat.command_update push from the gateway (issuing connection only).
  handleCommandUpdate(update: ChatCommandUpdate): void {
    let pending = this.byRunId.get(update.runId);
    if (!pending && update.clientRequestId) {
      // The update rides the gateway's priority control queue and can
      // overtake the chat.command accept response on a congested link, so
      // the run id may not be bound yet. Adopt it — but only onto a pending
      // that is still unbound and proves ownership by its own client id
      // (mirrors handleRunSignal's strict matching).
      for (const candidate of this.pending.values()) {
        if (candidate.runId === null && candidate.clientRequestId === update.clientRequestId) {
          candidate.runId = update.runId;
          this.byRunId.set(update.runId, candidate);
          pending = candidate;
          break;
        }
      }
    }
    if (!pending) {
      return;
    }
    switch (update.phase) {
      case "bound": {
        if (update.conversationId && update.conversationId !== pending.conversationId) {
          // Draft conversation materialized: the app re-keys stores and
          // subscriptions, then the pending command follows the real id.
          const previousConversationId = pending.conversationId;
          pending.conversationId = update.conversationId;
          this.boundConversationIds.set(previousConversationId, update.conversationId);
          this.movePending(previousConversationId, update.conversationId, pending);
          this.hooks.onBound?.(update, pending);
          this.settleBindingWaiters(pending, update.conversationId);
        }
        return;
      }
      case "queued_in_gui": {
        // The prompt is parked in the desktop queue: it is not pending
        // anymore, the queue panel shows it. The seeded entries are removed
        // by the stream's run_queued event; the optimistic entry may still
        // exist if the seed never reached the stream (draft conversations).
        const store = this.hooks.getTranscriptStore(pending.conversationId);
        if (pending.isEditResend) {
          // Server-side history is unchanged for a parked edit: restore the
          // optimistically truncated suffix locally right away; the hook's
          // history refresh remains the authoritative reconciliation.
          store.restoreEditResendTranscript?.(pending.clientRequestId);
        }
        store.removeOptimisticUserEntry(pending.clientRequestId);
        const outcome: ChatCommandOutcome = { kind: "queued_in_gui", update };
        this.settledOutcomes.set(pending, outcome);
        this.startWaiters.get(pending)?.(outcome);
        this.startWaiters.delete(pending);
        const boundConversationId = update.conversationId?.trim() ?? "";
        this.settleBindingWaiters(
          pending,
          boundConversationId && boundConversationId !== pending.conversationId
            ? boundConversationId
            : null,
        );
        this.clearPending(pending);
        this.hooks.onQueuedInGui?.(update, pending);
        return;
      }
      case "failed": {
        this.fail(pending, update.errorCode, update.message ?? "chat command failed");
        return;
      }
    }
  }

  // Stream/activity signals that settle the pending command: the run started
  // (tokens will flow), finished (failed fast), or was queued. Identity is
  // strict — a null-runId pending (accept response still in flight) settles
  // only on a signal carrying its own client_request_id; foreign runs (GUI
  // queue auto-sends, another client's commands) never disarm the watchdog.
  handleRunSignal(
    conversationId: string,
    runId: string,
    clientRequestId?: string,
    started = true,
  ): void {
    const pending = this.pending.get(conversationId);
    if (!pending) {
      return;
    }
    if (pending.waitForStart && !started) return;
    const matchesRunId = runId !== "" && pending.runId === runId;
    const matchesClientRequest =
      pending.runId === null &&
      typeof clientRequestId === "string" &&
      clientRequestId !== "" &&
      clientRequestId === pending.clientRequestId;
    if (matchesRunId || matchesClientRequest) {
      this.settledOutcomes.set(pending, { kind: "settled" });
      this.startWaiters.get(pending)?.({ kind: "settled" });
      this.startWaiters.delete(pending);
      this.clearPending(pending);
    }
  }

  private fail(
    pending: PendingChatCommand,
    errorCode: string | null,
    message: string,
  ): Extract<ChatCommandOutcome, { kind: "failed" }> {
    const outcome = { kind: "failed" as const, errorCode, message };
    this.settledOutcomes.set(pending, outcome);
    this.startWaiters.get(pending)?.(outcome);
    this.startWaiters.delete(pending);
    const store = this.hooks.getTranscriptStore(pending.conversationId);
    if (pending.isEditResend) {
      // Offline-safe compensation: the command never ran, so the transcript
      // stashed before the optimistic truncation is still authoritative. The
      // onFailed hook's history refresh reconciles when the network works.
      store.restoreEditResendTranscript?.(pending.clientRequestId);
    }
    store.removeOptimisticUserEntry(pending.clientRequestId);
    if (!pending.waitForStart) store.appendLocalError(message);
    this.settleBindingWaiters(pending, null);
    this.clearPending(pending);
    this.hooks.onFailed?.(pending, errorCode, message);
    return outcome;
  }

  private setPending(conversationId: string, pending: PendingChatCommand): void {
    const existingTimeout = this.timeouts.get(conversationId);
    if (existingTimeout !== undefined) {
      clearTimeout(existingTimeout);
    }
    this.pending.set(conversationId, pending);
    this.timeouts.set(
      conversationId,
      setTimeout(() => {
        const current = this.pending.get(pending.conversationId);
        if (current === pending) {
          this.fail(
            pending,
            "startup_timeout",
            "The desktop app did not start this request in time. Please retry.",
          );
        }
      }, PENDING_COMMAND_TIMEOUT_MS),
    );
    this.hooks.onPendingChanged?.();
  }

  private movePending(from: string, to: string, pending: PendingChatCommand): void {
    if (this.pending.get(from) === pending) {
      this.pending.delete(from);
    }
    const timeout = this.timeouts.get(from);
    if (timeout !== undefined) {
      this.timeouts.delete(from);
      this.timeouts.set(to, timeout);
    }
    this.pending.set(to, pending);
    this.hooks.onPendingChanged?.();
  }

  private clearPending(pending: PendingChatCommand): void {
    if (this.pending.get(pending.conversationId) === pending) {
      this.pending.delete(pending.conversationId);
      const timeout = this.timeouts.get(pending.conversationId);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        this.timeouts.delete(pending.conversationId);
      }
    }
    if (pending.runId) {
      this.byRunId.delete(pending.runId);
    }
    this.hooks.onPendingChanged?.();
  }
}
