import type {
  ConversationStreamEvent,
  ConversationStreamHandlers,
  ConversationSubscribeResult,
} from "./streamTypes";
import { normalizeSubscribeResult, readEventConversationId, readEventSeq } from "./streamTypes";

// Transport-owned subscription manager: one persistent registration per
// conversation. Resume is built in — on every (re)connect the manager
// re-issues chat.subscribe with the last seen seq and stream epoch, so a
// dropped socket never silently ends a stream. Registrations survive
// disconnects and are removed only by their cleanup function.

type StreamTransport = {
  request<T>(type: string, payload: unknown, options?: { timeoutMs?: number }): Promise<T>;
};

type Registration = {
  conversationId: string;
  handlers: ConversationStreamHandlers;
  lastSeq: number;
  streamEpoch: string;
  synced: boolean;
  syncing: boolean;
  resyncQueued: boolean;
  disposed: boolean;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  // Live events that raced ahead of the chat.subscribe response; drained
  // after onSync (seq dedup drops the replay overlap).
  pendingEvents: ConversationStreamEvent[];
};

const MAX_PENDING_EVENTS = 512;
const SUBSCRIBE_REQUEST_TIMEOUT_MS = 30_000;
const SYNC_RETRY_INITIAL_DELAY_MS = 250;
// Persistent failures (deleted conversation, permanent server-side rejects)
// retry forever but back off far enough to stay negligible; transient
// outages still recover within the first fast attempts.
const SYNC_RETRY_MAX_DELAY_MS = 30_000;
const SYNC_RETRY_MAX_EXPONENT = 7;

export class ConversationStreamClient {
  private registrations = new Map<string, Registration>();
  private connected = false;
  private connectionGeneration = 0;

  constructor(private readonly transport: StreamTransport) {}

  get size(): number {
    return this.registrations.size;
  }

  subscribe(conversationId: string, handlers: ConversationStreamHandlers): () => void {
    const normalized = conversationId.trim();
    if (!normalized) {
      return () => {};
    }
    const previous = this.registrations.get(normalized);
    if (previous) {
      previous.disposed = true;
      this.clearRetry(previous);
    }
    const registration: Registration = {
      conversationId: normalized,
      handlers,
      lastSeq: 0,
      streamEpoch: "",
      synced: false,
      syncing: false,
      resyncQueued: false,
      disposed: false,
      retryAttempt: 0,
      retryTimer: null,
      pendingEvents: [],
    };
    this.registrations.set(normalized, registration);
    if (this.connected) {
      void this.sync(registration);
    }
    return () => {
      registration.disposed = true;
      this.clearRetry(registration);
      if (this.registrations.get(normalized) === registration) {
        this.registrations.delete(normalized);
        if (this.connected) {
          void this.transport
            .request("chat.unsubscribe", { conversation_id: normalized })
            .catch(() => undefined);
        }
      }
    };
  }

  // The socket authenticated (first connect or reconnect): (re)issue
  // chat.subscribe for every registration with its resume cursor.
  handleConnected(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.connectionGeneration += 1;
    for (const registration of this.registrations.values()) {
      this.clearRetry(registration);
      registration.retryAttempt = 0;
      registration.synced = false;
      void this.sync(registration);
    }
  }

  handleDisconnected(): void {
    if (this.connected) {
      this.connectionGeneration += 1;
    }
    this.connected = false;
    for (const registration of this.registrations.values()) {
      this.clearRetry(registration);
      registration.synced = false;
      registration.resyncQueued = false;
      // Events buffered on the dead connection belong to its stream epoch;
      // the resume protocol re-fetches everything after lastSeq on
      // reconnect, so draining them later could only corrupt the transcript.
      registration.pendingEvents = [];
    }
  }

  // Server pushed chat.event: route by conversation id, advance the cursor.
  handleChatEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const event = payload as ConversationStreamEvent;
    const conversationId = readEventConversationId(event);
    if (!conversationId) {
      return;
    }
    const registration = this.registrations.get(conversationId);
    if (!registration || registration.disposed) {
      return;
    }
    if (!registration.synced) {
      // Live events published after the server registered the subscriber can
      // arrive before the subscribe response; buffer and drain after onSync.
      if (registration.pendingEvents.length < MAX_PENDING_EVENTS) {
        registration.pendingEvents.push(event);
      }
      return;
    }
    this.deliver(registration, event);
  }

  private deliver(registration: Registration, event: ConversationStreamEvent): void {
    const seq = readEventSeq(event);
    if (seq > 0) {
      if (seq <= registration.lastSeq) {
        return;
      }
      if (registration.lastSeq > 0 && seq > registration.lastSeq + 1) {
        // Missed events on the wire — resync from the cursor.
        void this.sync(registration);
        return;
      }
      registration.lastSeq = seq;
    }
    registration.handlers.onEvent(event);
  }

  // App-requested resync (e.g. transcript divergence): re-issue
  // chat.subscribe from the cursor, exactly like gap recovery. No-op when
  // the conversation is not subscribed or the socket is down (reconnect
  // resume covers that case).
  resync(conversationId: string): void {
    const registration = this.registrations.get(conversationId.trim());
    if (!registration || registration.disposed || !this.connected) {
      return;
    }
    this.clearRetry(registration);
    void this.sync(registration);
  }

  // Server told us our subscriber overflowed: resume from the cursor.
  handleSubscriptionReset(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const conversationId =
      typeof (payload as { conversation_id?: unknown }).conversation_id === "string"
        ? ((payload as { conversation_id: string }).conversation_id ?? "").trim()
        : "";
    const registration = conversationId ? this.registrations.get(conversationId) : undefined;
    if (registration && !registration.disposed) {
      this.clearRetry(registration);
      void this.sync(registration);
    }
  }

  private async sync(registration: Registration): Promise<void> {
    if (
      !this.connected ||
      registration.disposed ||
      this.registrations.get(registration.conversationId) !== registration
    ) {
      return;
    }
    if (registration.syncing) {
      registration.resyncQueued = true;
      return;
    }
    this.clearRetry(registration);
    registration.syncing = true;
    const connectionGeneration = this.connectionGeneration;
    let shouldRetry = false;
    try {
      const raw = await this.transport.request<unknown>(
        "chat.subscribe",
        {
          conversation_id: registration.conversationId,
          after_seq: registration.lastSeq,
          stream_epoch: registration.streamEpoch || undefined,
        },
        {
          timeoutMs: SUBSCRIBE_REQUEST_TIMEOUT_MS,
        },
      );
      if (
        registration.disposed ||
        !this.connected ||
        connectionGeneration !== this.connectionGeneration ||
        this.registrations.get(registration.conversationId) !== registration
      ) {
        return;
      }
      const result: ConversationSubscribeResult = normalizeSubscribeResult(
        registration.conversationId,
        raw,
      );
      registration.streamEpoch = result.streamEpoch;
      registration.lastSeq = result.latestSeq;
      registration.synced = true;
      registration.retryAttempt = 0;
      registration.handlers.onSync(result);
      const pending = registration.pendingEvents;
      registration.pendingEvents = [];
      for (const event of pending) {
        if (registration.disposed || !registration.synced) {
          break;
        }
        this.deliver(registration, event);
      }
    } catch {
      if (
        !registration.disposed &&
        this.connected &&
        connectionGeneration === this.connectionGeneration &&
        this.registrations.get(registration.conversationId) === registration
      ) {
        registration.synced = false;
        shouldRetry = true;
      }
    } finally {
      registration.syncing = false;
      if (
        registration.resyncQueued &&
        !registration.disposed &&
        this.connected &&
        this.registrations.get(registration.conversationId) === registration
      ) {
        registration.resyncQueued = false;
        void this.sync(registration);
      } else if (shouldRetry) {
        this.scheduleRetry(registration);
      }
    }
  }

  private scheduleRetry(registration: Registration): void {
    if (
      registration.retryTimer !== null ||
      registration.disposed ||
      !this.connected ||
      this.registrations.get(registration.conversationId) !== registration
    ) {
      return;
    }
    const baseDelay = Math.min(
      SYNC_RETRY_MAX_DELAY_MS,
      SYNC_RETRY_INITIAL_DELAY_MS *
        2 ** Math.min(registration.retryAttempt, SYNC_RETRY_MAX_EXPONENT),
    );
    registration.retryAttempt += 1;
    const jitter = Math.floor(Math.random() * Math.min(250, Math.max(1, baseDelay / 2)));
    registration.retryTimer = setTimeout(() => {
      registration.retryTimer = null;
      if (
        registration.disposed ||
        !this.connected ||
        this.registrations.get(registration.conversationId) !== registration
      ) {
        return;
      }
      void this.sync(registration);
    }, baseDelay + jitter);
  }

  private clearRetry(registration: Registration): void {
    if (registration.retryTimer === null) {
      return;
    }
    clearTimeout(registration.retryTimer);
    registration.retryTimer = null;
  }
}
