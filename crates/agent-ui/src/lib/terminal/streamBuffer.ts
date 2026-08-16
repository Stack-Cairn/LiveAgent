import type {
  TerminalStreamChunk,
  TerminalStreamHandle,
  TerminalStreamInputState,
  TerminalStreamSnapshot,
} from "./types";

const INPUT_FLUSH_BYTES = 4 * 1024;
const INPUT_FLUSH_MS = 8;
const INPUT_HIGH_WATER_BYTES = 256 * 1024;
const INPUT_LOW_WATER_BYTES = 128 * 1024;
const RESIZE_FLUSH_MS = 16;

type TerminalResize = { cols: number; rows: number };

type TerminalStreamBufferOptions = {
  initialTransportReady: boolean;
  offlineInputRetryMs?: number;
  offlineResizeRetryMs?: number;
  sendInput: (bytes: Uint8Array, buffer: TerminalStreamBuffer) => Promise<void>;
  sendResize: (resize: TerminalResize, buffer: TerminalStreamBuffer) => Promise<void>;
  onInputSendError?: (error: unknown, bytes: Uint8Array, buffer: TerminalStreamBuffer) => void;
  onResizeSendError?: (
    error: unknown,
    resize: TerminalResize,
    buffer: TerminalStreamBuffer,
  ) => void;
  onDispose?: () => void;
};

export class TerminalStreamBuffer implements TerminalStreamHandle {
  private disposed = false;
  private transportReady: boolean;
  private readonly listeners = new Set<(chunk: TerminalStreamChunk) => void>();
  private readonly inputStateListeners = new Set<(state: TerminalStreamInputState) => void>();
  private readonly queuedChunks: TerminalStreamChunk[] = [];
  private inputQueue: Uint8Array[] = [];
  private inputBytes = 0;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private currentResize: TerminalResize | null = null;
  private latestResize: TerminalResize | null = null;
  private inputPausedReason: TerminalStreamInputState["reason"] | null = null;

  constructor(
    public snapshot: TerminalStreamSnapshot,
    private readonly options: TerminalStreamBufferOptions,
  ) {
    this.transportReady = options.initialTransportReady;
  }

  protected get streamDisposed() {
    return this.disposed;
  }

  accept(chunk: TerminalStreamChunk) {
    if (this.disposed || chunk.sessionId !== this.snapshot.session.id) return;
    if (this.listeners.size === 0) {
      this.queuedChunks.push(chunk);
      return;
    }
    for (const listener of this.listeners) {
      listener(chunk);
    }
  }

  write(data: Uint8Array) {
    if (this.disposed || data.byteLength === 0) return false;
    if (this.inputPausedReason) return false;
    if (this.inputBytes + data.byteLength > INPUT_HIGH_WATER_BYTES) {
      this.pauseInput("slow");
      if (this.inputBytes === 0) {
        queueMicrotask(() => this.clearInputPaused());
        return false;
      }
      this.flushInput();
      return false;
    }
    this.inputQueue.push(data.slice());
    this.inputBytes += data.byteLength;
    this.emitInputState();
    if (this.inputBytes >= INPUT_FLUSH_BYTES) {
      this.flushInput();
      return true;
    }
    this.inputTimer ??= setTimeout(() => this.flushInput(), INPUT_FLUSH_MS);
    return true;
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    const next = {
      cols: Math.max(20, Math.min(400, Math.round(cols))),
      rows: Math.max(6, Math.min(200, Math.round(rows))),
    };
    this.currentResize = next;
    this.latestResize = next;
    this.resizeTimer ??= setTimeout(() => this.flushResize(), RESIZE_FLUSH_MS);
  }

  subscribeOutput(listener: (chunk: TerminalStreamChunk) => void) {
    this.listeners.add(listener);
    const queued = this.queuedChunks.splice(0);
    for (const chunk of queued) {
      listener(chunk);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeInputState(listener: (state: TerminalStreamInputState) => void) {
    this.inputStateListeners.add(listener);
    listener(this.inputState());
    return () => {
      this.inputStateListeners.delete(listener);
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.flushInput();
    this.clearInputTimer();
    this.clearResizeTimer();
    this.options.onDispose?.();
    this.listeners.clear();
    this.inputStateListeners.clear();
    this.queuedChunks.length = 0;
    this.inputPausedReason = "closed";
  }

  markTransportDown() {
    this.transportReady = false;
    this.pauseInput("offline");
  }

  markTransportReady() {
    if (this.disposed) return;
    this.transportReady = true;
    this.flushResize();
    this.flushInput();
    this.clearInputPaused();
  }

  resendCurrentResize() {
    if (this.disposed || !this.transportReady || !this.currentResize) return;
    this.latestResize = this.currentResize;
    this.flushResize();
  }

  restoreInput(bytes: Uint8Array) {
    if (this.disposed || bytes.byteLength === 0) return;
    if (this.inputBytes + bytes.byteLength > INPUT_HIGH_WATER_BYTES) {
      this.inputQueue = [];
      this.inputBytes = 0;
      this.pauseInput("offline");
      return;
    }
    this.inputQueue.unshift(bytes);
    this.inputBytes += bytes.byteLength;
    this.pauseInput("offline");
    this.scheduleOfflineInputRetry();
  }

  retryResize(resize: TerminalResize) {
    if (this.disposed) return;
    this.latestResize = resize;
    this.scheduleOfflineResizeRetry();
  }

  pauseInput(reason: NonNullable<TerminalStreamInputState["reason"]>) {
    if (this.inputPausedReason === reason) {
      this.emitInputState();
      return;
    }
    this.inputPausedReason = reason;
    this.emitInputState();
  }

  private flushInput() {
    this.clearInputTimer();
    if (!this.transportReady) {
      if (this.inputBytes > 0) {
        this.pauseInput("offline");
        this.scheduleOfflineInputRetry();
      }
      return;
    }
    if (this.inputBytes === 0) {
      this.clearInputPaused();
      return;
    }
    const bytes = new Uint8Array(this.inputBytes);
    let offset = 0;
    for (const chunk of this.inputQueue) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.inputQueue = [];
    this.inputBytes = 0;
    this.emitInputState();
    void this.options
      .sendInput(bytes, this)
      .then(() => this.clearInputPaused())
      .catch((error: unknown) => this.options.onInputSendError?.(error, bytes, this));
  }

  private flushResize() {
    this.clearResizeTimer();
    if (!this.transportReady) {
      if (this.latestResize) {
        this.scheduleOfflineResizeRetry();
      }
      return;
    }
    const latest = this.latestResize;
    this.latestResize = null;
    if (!latest) return;
    void this.options
      .sendResize(latest, this)
      .catch((error: unknown) => this.options.onResizeSendError?.(error, latest, this));
  }

  private scheduleOfflineInputRetry() {
    if (this.inputTimer !== null || this.options.offlineInputRetryMs === undefined) return;
    this.inputTimer = setTimeout(
      () => this.flushInput(),
      Math.max(0, this.options.offlineInputRetryMs),
    );
  }

  private scheduleOfflineResizeRetry() {
    if (this.resizeTimer !== null || this.options.offlineResizeRetryMs === undefined) return;
    this.resizeTimer = setTimeout(
      () => this.flushResize(),
      Math.max(0, this.options.offlineResizeRetryMs),
    );
  }

  private clearInputTimer() {
    if (this.inputTimer === null) return;
    clearTimeout(this.inputTimer);
    this.inputTimer = null;
  }

  private clearResizeTimer() {
    if (this.resizeTimer === null) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
  }

  private inputState(): TerminalStreamInputState {
    return {
      paused: this.inputPausedReason !== null,
      queuedBytes: this.inputBytes,
      highWaterBytes: INPUT_HIGH_WATER_BYTES,
      reason: this.inputPausedReason ?? undefined,
    };
  }

  private emitInputState() {
    if (this.inputStateListeners.size === 0) return;
    const state = this.inputState();
    for (const listener of this.inputStateListeners) {
      listener(state);
    }
  }

  private clearInputPaused() {
    if (
      this.inputPausedReason === null ||
      !this.transportReady ||
      this.inputBytes > INPUT_LOW_WATER_BYTES
    ) {
      return;
    }
    this.inputPausedReason = null;
    this.emitInputState();
  }
}
