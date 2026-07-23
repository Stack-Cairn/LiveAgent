import type { TerminalWireHeader } from "@/lib/gatewaySocketV2/adapters";
import {
  decodeTerminalServerFrame,
  encodeTerminalHelloFrame,
  encodeTerminalStreamFrame,
  GATEWAY_V2_SUBPROTOCOL,
} from "@/lib/gatewaySocketV2/adapters";
import type {
  TerminalSession,
  TerminalStreamChunk,
  TerminalStreamClient,
  TerminalStreamHandle,
  TerminalStreamInputState,
  TerminalStreamSnapshot,
} from "./types";

const INPUT_FLUSH_BYTES = 4 * 1024;
const INPUT_FLUSH_MS = 8;
const INPUT_RETRY_MS = 25;
const INPUT_HIGH_WATER_BYTES = 256 * 1024;
const INPUT_LOW_WATER_BYTES = 128 * 1024;
const ATTACH_RETRY_MS = 250;

// 帧头形状沿用旧自定义帧的命名；v2 下由适配层映射到 TerminalStreamFrame。
type TerminalFrameHeader = TerminalWireHeader;

type PendingAttach = {
  handle: GatewayTerminalStreamHandle;
  resolve: (handle: GatewayTerminalStreamHandle) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  retryTimerId: ReturnType<typeof setTimeout> | null;
};

function terminalStreamUrl() {
  const origin = terminalRuntimeOrigin();
  if (!origin) {
    throw new Error("Gateway terminal stream origin is unavailable");
  }
  // v2 终端数据面唯一端点。
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/v2/terminal";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function terminalRuntimeOrigin() {
  const candidates = [
    globalThis.location,
    typeof window !== "undefined" ? window.location : undefined,
  ];
  for (const location of candidates) {
    const origin = location?.origin;
    if (typeof origin === "string" && origin.trim() && origin !== "null") {
      return origin;
    }
    const href = location?.href;
    if (typeof href === "string" && href.trim()) {
      const parsed = new URL(href);
      if (parsed.origin && parsed.origin !== "null") {
        return parsed.origin;
      }
    }
  }
  return "";
}

function nextStreamId() {
  const random = globalThis.crypto?.randomUUID?.();
  return random
    ? `terminal-${random}`
    : `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableAttachError(message: string) {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("desktop agent is offline") ||
    normalized.includes("terminal stream connection") ||
    normalized.includes("terminal stream is not connected")
  );
}

function normalizeSession(input: unknown): TerminalSession {
  const raw = (input ?? {}) as Record<string, unknown>;
  const ssh = (raw.ssh ?? null) as Record<string, unknown> | null;
  return {
    id: String(raw.id ?? ""),
    projectPathKey: String(raw.project_path_key ?? raw.projectPathKey ?? ""),
    cwd: String(raw.cwd ?? ""),
    shell: String(raw.shell ?? ""),
    title: String(raw.title ?? "Terminal"),
    kind: raw.kind === "ssh" ? "ssh" : "local",
    ssh: ssh
      ? {
          hostId: String(ssh.host_id ?? ssh.hostId ?? ""),
          hostName: String(ssh.host_name ?? ssh.hostName ?? ""),
          username: String(ssh.username ?? ""),
          host: String(ssh.host ?? ""),
          port: Number(ssh.port ?? 22),
          authType: String(ssh.auth_type ?? ssh.authType ?? ""),
          status: String(ssh.status ?? "connected"),
          reconnectAttempt: Number(ssh.reconnect_attempt ?? ssh.reconnectAttempt ?? 0),
          reconnectMaxAttempts: Number(ssh.reconnect_max_attempts ?? ssh.reconnectMaxAttempts ?? 3),
          sftpEnabled: Boolean(ssh.sftp_enabled ?? ssh.sftpEnabled ?? false),
        }
      : null,
    pid: raw.pid === null || raw.pid === undefined ? null : Number(raw.pid),
    cols: Number(raw.cols ?? 80),
    rows: Number(raw.rows ?? 24),
    createdAt: Number(raw.created_at ?? raw.createdAt ?? 0),
    updatedAt: Number(raw.updated_at ?? raw.updatedAt ?? 0),
    finishedAt:
      raw.finished_at === null ? null : Number(raw.finished_at ?? raw.finishedAt ?? 0) || null,
    exitCode: raw.exit_code === null ? null : Number(raw.exit_code ?? raw.exitCode ?? 0) || null,
    running: raw.running === true,
  };
}

class GatewayTerminalStreamHandle implements TerminalStreamHandle {
  private disposed = false;
  private transportReady = false;
  private readonly listeners = new Set<(chunk: TerminalStreamChunk) => void>();
  private readonly inputStateListeners = new Set<(state: TerminalStreamInputState) => void>();
  private readonly queuedChunks: TerminalStreamChunk[] = [];
  private inputQueue: Uint8Array[] = [];
  private inputBytes = 0;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private currentResize: { cols: number; rows: number } | null = null;
  private latestResize: { cols: number; rows: number } | null = null;
  private inputPausedReason: TerminalStreamInputState["reason"] | null = null;

  constructor(
    private readonly owner: BrowserGatewayTerminalStreamClient,
    readonly streamId: string,
    readonly maxBytes: number | undefined,
    public snapshot: TerminalStreamSnapshot,
  ) {}

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
      this.setInputPaused("slow");
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
    this.resizeTimer ??= setTimeout(() => this.flushResize(), 16);
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
    if (this.inputTimer) clearTimeout(this.inputTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.listeners.clear();
    this.inputStateListeners.clear();
    this.queuedChunks.length = 0;
    this.inputPausedReason = "closed";
    this.owner.detach(this.streamId, this.snapshot.session, this);
  }

  markTransportDown() {
    this.transportReady = false;
    this.setInputPaused("offline");
  }

  markTransportReady() {
    if (this.disposed) return;
    this.transportReady = true;
    this.flushResize();
    this.flushInput();
    if (this.inputBytes <= INPUT_LOW_WATER_BYTES) {
      this.clearInputPaused();
    }
  }

  replaySnapshot(snapshot: TerminalStreamSnapshot) {
    if (this.disposed) return;
    const previousSessionId = this.snapshot.session.id;
    this.snapshot = snapshot;
    this.owner.reindexHandle(this, previousSessionId, snapshot.session.id);
    this.markTransportReady();
    if (snapshot.bytes.byteLength > 0) {
      this.accept({
        sessionId: snapshot.session.id,
        projectPathKey: snapshot.session.projectPathKey,
        bytes: snapshot.bytes,
        startOffset: snapshot.outputStartOffset,
        endOffset: snapshot.outputEndOffset,
      });
    }
  }

  resendCurrentResize() {
    if (this.disposed || !this.transportReady || !this.currentResize) return;
    this.latestResize = this.currentResize;
    this.flushResize();
  }

  private flushInput() {
    if (this.inputTimer) {
      clearTimeout(this.inputTimer);
      this.inputTimer = null;
    }
    if (!this.transportReady) {
      if (this.inputBytes > 0) {
        this.setInputPaused("offline");
        this.inputTimer = setTimeout(() => this.flushInput(), INPUT_RETRY_MS);
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
    void this.owner
      .send(
        {
          kind: "input",
          streamId: this.streamId,
          sessionId: this.snapshot.session.id,
          projectPathKey: this.snapshot.session.projectPathKey,
        },
        bytes,
      )
      .then(() => this.clearInputPaused())
      .catch(() => {
        this.markTransportDown();
        this.prependInput(bytes);
        this.owner.scheduleReconnect();
      });
  }

  private flushResize() {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (!this.transportReady) {
      if (this.latestResize) {
        this.resizeTimer = setTimeout(() => this.flushResize(), 50);
      }
      return;
    }
    const latest = this.latestResize;
    this.latestResize = null;
    if (!latest) return;
    void this.owner
      .send({
        kind: "resize",
        streamId: this.streamId,
        sessionId: this.snapshot.session.id,
        projectPathKey: this.snapshot.session.projectPathKey,
        cols: latest.cols,
        rows: latest.rows,
      })
      .catch(() => {
        this.markTransportDown();
        this.latestResize = latest;
        this.owner.scheduleReconnect();
      });
  }

  private prependInput(bytes: Uint8Array) {
    if (this.disposed || bytes.byteLength === 0) return;
    if (this.inputBytes + bytes.byteLength > INPUT_HIGH_WATER_BYTES) {
      this.inputQueue = [];
      this.inputBytes = 0;
      this.setInputPaused("offline");
      return;
    }
    this.inputQueue.unshift(bytes);
    this.inputBytes += bytes.byteLength;
    this.setInputPaused("offline");
    this.inputTimer ??= setTimeout(() => this.flushInput(), INPUT_RETRY_MS);
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

  private setInputPaused(reason: NonNullable<TerminalStreamInputState["reason"]>) {
    if (this.inputPausedReason === reason) {
      this.emitInputState();
      return;
    }
    this.inputPausedReason = reason;
    this.emitInputState();
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

export class BrowserGatewayTerminalStreamClient implements TerminalStreamClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingAttach>();
  private handlesBySession = new Map<string, Set<GatewayTerminalStreamHandle>>();
  private handlesByStream = new Map<string, GatewayTerminalStreamHandle>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  // getAgentId 提供当前明确的活跃 Agent，终端数据面在 hello 时绑定该目标。
  constructor(
    private readonly token: string,
    private readonly getAgentId: () => string,
  ) {}

  async attach(
    session: TerminalSession,
    options?: { maxBytes?: number },
  ): Promise<TerminalStreamHandle> {
    const streamId = nextStreamId();
    const streamHandle = new GatewayTerminalStreamHandle(this, streamId, options?.maxBytes, {
      session,
      bytes: new Uint8Array(),
      truncated: false,
      outputStartOffset: 0,
      outputEndOffset: 0,
    });
    this.addHandle(streamHandle);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pending.get(streamId);
        if (pending) {
          this.failPendingAttach(pending, new Error("Terminal stream attach timed out"));
        }
      }, 15_000);
      const pending = { handle: streamHandle, resolve, reject, timeoutId, retryTimerId: null };
      this.pending.set(streamId, pending);
      void this.sendPendingAttach(pending);
    });
  }

  async send(header: TerminalFrameHeader, data?: Uint8Array<ArrayBufferLike>) {
    await this.ensureConnected();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Terminal stream is not connected");
    }
    this.socket.send(
      encodeTerminalStreamFrame(header, data ? new Uint8Array(data) : new Uint8Array()),
    );
  }

  detach(streamId: string, session: TerminalSession, handle: GatewayTerminalStreamHandle) {
    this.removeHandle(session.id, handle);
    const sessionStillAttached = this.handlesBySession.has(session.id);
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(
          encodeTerminalStreamFrame({
            kind: "detach",
            streamId,
            sessionId: sessionStillAttached ? undefined : session.id,
            projectPathKey: sessionStillAttached ? undefined : session.projectPathKey,
          }),
        );
      } catch {
        // The socket may move to CLOSING between the readyState check and send.
      }
    }
    if (this.activeHandles().length === 0) {
      this.clearReconnectTimer();
    }
  }

  dispose() {
    this.disposed = true;
    this.clearReconnectTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      if (pending.retryTimerId) clearTimeout(pending.retryTimerId);
      pending.reject(new Error("Terminal stream client disposed"));
    }
    this.pending.clear();
    this.handlesBySession.clear();
    this.handlesByStream.clear();
    this.socket?.close();
    this.socket = null;
  }

  scheduleReconnect(delayMs = 250) {
    if (this.disposed || this.reconnectTimer || this.activeHandles().length === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reattachActiveHandles();
    }, delayMs);
  }

  private async ensureConnected() {
    if (this.disposed) {
      throw new Error("Terminal stream client disposed");
    }
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const clearAttemptTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        clearAttemptTimeout();
        reject(error);
      };
      const resolveOnce = (socket: WebSocket) => {
        if (settled) return;
        settled = true;
        clearAttemptTimeout();
        this.socket = socket;
        resolve();
      };
      let url: string;
      try {
        url = terminalStreamUrl();
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // v2：二进制 protobuf 帧 + 子协议协商 + hello 鉴权握手。
      const socket = new WebSocket(url, GATEWAY_V2_SUBPROTOCOL);
      socket.binaryType = "arraybuffer";
      const failAttempt = (error: Error) => {
        if (settled) return;
        clearAttemptTimeout();
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // The browser may already have torn the socket down.
        }
        rejectOnce(error);
      };
      timeoutId = setTimeout(() => {
        failAttempt(new Error("Terminal stream connection timed out"));
      }, 15_000);
      socket.onopen = () => {
        socket.send(encodeTerminalHelloFrame(this.token, this.getAgentId()));
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          // v2 链路无文本帧；忽略。
          return;
        }
        const decoded = decodeTerminalServerFrame(event.data as ArrayBuffer);
        if (!decoded) return;
        if (decoded.kind === "hello") {
          if (decoded.ok) {
            resolveOnce(socket);
          } else {
            failAttempt(new Error(decoded.message || "Terminal stream auth failed"));
          }
          return;
        }
        this.handleStreamFrame(decoded.header, decoded.data);
      };
      socket.onerror = () => {
        failAttempt(new Error("Terminal stream connection failed"));
      };
      socket.onclose = () => {
        if (!settled) {
          failAttempt(new Error("Terminal stream connection closed"));
          return;
        }
        if (this.socket === socket) {
          this.socket = null;
          this.handleSocketClosed();
        }
      };
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private handleStreamFrame(header: TerminalFrameHeader, data: Uint8Array) {
    const kind = header.kind ?? "";
    if (kind === "snapshot") {
      this.resolveAttach(header, data);
      return;
    }
    if (kind === "output") {
      this.emitOutput(header, data);
      return;
    }
    if (kind === "error") {
      this.rejectAttach(header.streamId ?? "", header.error || "Terminal stream failed");
    }
  }

  private resolveAttach(header: TerminalFrameHeader, data: Uint8Array) {
    const streamId = header.streamId ?? "";
    const pending = this.pending.get(streamId);
    const session = normalizeSession(header.session);
    const snapshot = {
      session,
      bytes: data,
      truncated: header.truncated === true,
      outputStartOffset: Number(header.startOffset ?? 0),
      outputEndOffset: Number(header.endOffset ?? 0),
    };
    if (!pending) {
      const handle = this.handlesByStream.get(streamId);
      handle?.replaySnapshot(snapshot);
      handle?.resendCurrentResize();
      return;
    }
    clearTimeout(pending.timeoutId);
    if (pending.retryTimerId) clearTimeout(pending.retryTimerId);
    this.pending.delete(streamId);
    const previousSessionId = pending.handle.snapshot.session.id;
    pending.handle.snapshot = snapshot;
    this.reindexHandle(pending.handle, previousSessionId, session.id);
    pending.handle.markTransportReady();
    pending.resolve(pending.handle);
  }

  private rejectAttach(streamId: string, message: string) {
    const pending = this.pending.get(streamId);
    if (!pending) return;
    if (isRetryableAttachError(message)) {
      this.retryPendingAttach(pending);
      return;
    }
    this.failPendingAttach(pending, new Error(message));
  }

  private emitOutput(header: TerminalFrameHeader, data: Uint8Array) {
    const sessionId = header.sessionId ?? "";
    const handles = this.handlesBySession.get(sessionId);
    if (!handles) return;
    const chunk: TerminalStreamChunk = {
      sessionId,
      projectPathKey: header.projectPathKey ?? "",
      bytes: data,
      startOffset: Number(header.startOffset ?? 0),
      endOffset: Number(header.endOffset ?? 0),
    };
    for (const handle of handles) {
      handle.accept(chunk);
    }
  }

  private addHandle(handle: GatewayTerminalStreamHandle) {
    const sessionId = handle.snapshot.session.id;
    const handles = this.handlesBySession.get(sessionId) ?? new Set();
    handles.add(handle);
    this.handlesBySession.set(sessionId, handles);
    this.handlesByStream.set(handle.streamId, handle);
  }

  reindexHandle(
    handle: GatewayTerminalStreamHandle,
    previousSessionId: string,
    nextSessionId: string,
  ) {
    this.removeHandle(previousSessionId, handle);
    const handles = this.handlesBySession.get(nextSessionId) ?? new Set();
    handles.add(handle);
    this.handlesBySession.set(nextSessionId, handles);
    this.handlesByStream.set(handle.streamId, handle);
  }

  private removeHandle(sessionId: string, handleToRemove: GatewayTerminalStreamHandle) {
    const handles = this.handlesBySession.get(sessionId);
    if (!handles) return;
    handles.delete(handleToRemove);
    if (handles.size === 0) {
      this.handlesBySession.delete(sessionId);
    }
    this.handlesByStream.delete(handleToRemove.streamId);
  }

  private activeHandles() {
    return [...this.handlesByStream.values()];
  }

  private handleSocketClosed() {
    if (this.disposed) return;
    for (const pending of this.pending.values()) {
      pending.handle.markTransportDown();
      this.retryPendingAttach(pending);
    }
    for (const handle of this.activeHandles().filter(
      (handle) => !this.pending.has(handle.streamId),
    )) {
      handle.markTransportDown();
    }
    this.scheduleReconnect();
  }

  private async reattachActiveHandles() {
    if (this.disposed) return;
    const handles = this.activeHandles().filter((handle) => !this.pending.has(handle.streamId));
    if (handles.length === 0) return;
    try {
      await this.ensureConnected();
      await Promise.all(
        handles.map((handle) =>
          this.send({
            kind: "attach",
            streamId: handle.streamId,
            sessionId: handle.snapshot.session.id,
            projectPathKey: handle.snapshot.session.projectPathKey,
            maxBytes: handle.maxBytes,
          }),
        ),
      );
    } catch {
      this.scheduleReconnect(1_000);
    }
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async sendPendingAttach(pending: PendingAttach) {
    if (this.disposed || this.pending.get(pending.handle.streamId) !== pending) return;
    try {
      await this.send({
        kind: "attach",
        streamId: pending.handle.streamId,
        sessionId: pending.handle.snapshot.session.id,
        projectPathKey: pending.handle.snapshot.session.projectPathKey,
        maxBytes: pending.handle.maxBytes,
      });
    } catch (error) {
      if (isRetryableAttachError(errorMessage(error))) {
        pending.handle.markTransportDown();
        this.retryPendingAttach(pending);
        return;
      }
      this.failPendingAttach(pending, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private retryPendingAttach(pending: PendingAttach) {
    if (this.disposed || this.pending.get(pending.handle.streamId) !== pending) return;
    pending.handle.markTransportDown();
    if (pending.retryTimerId) return;
    pending.retryTimerId = setTimeout(() => {
      pending.retryTimerId = null;
      void this.sendPendingAttach(pending);
    }, ATTACH_RETRY_MS);
  }

  private failPendingAttach(pending: PendingAttach, error: Error) {
    clearTimeout(pending.timeoutId);
    if (pending.retryTimerId) clearTimeout(pending.retryTimerId);
    this.pending.delete(pending.handle.streamId);
    pending.handle.dispose();
    pending.reject(error);
  }
}
