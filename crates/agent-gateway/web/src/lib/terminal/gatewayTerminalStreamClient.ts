import { normalizeUnknownTerminalSession } from "@liveagent/ui/lib/terminal/normalization";
import { TerminalStreamBuffer } from "@liveagent/ui/lib/terminal/streamBuffer";
import type {
  TerminalSession,
  TerminalStreamChunk,
  TerminalStreamClient,
  TerminalStreamHandle,
  TerminalStreamSnapshot,
} from "@liveagent/ui/lib/terminal/types";
import type { TerminalWireHeader } from "@/lib/gatewaySocketV2/adapters";
import {
  decodeTerminalServerFrame,
  encodeTerminalHelloFrame,
  encodeTerminalStreamFrame,
  GATEWAY_V2_SUBPROTOCOL,
} from "@/lib/gatewaySocketV2/adapters";

const INPUT_RETRY_MS = 25;
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

// TerminalStreamBuffer 来自 @liveagent/ui（跨包导入），生产构建下 rolldown 可能把这里和它的
// 定义拆进不同 chunk。class 顶层的 extends 子句在模块求值时立即读取该导入绑定，若此时目标 chunk
// 还没跑完初始化就会读到 undefined，报 "Class extends value undefined is not a constructor"。
// 包一层工厂函数，把 extends 求值推迟到首次实际 attach（此时全部 chunk 必已加载完毕）。
function createGatewayTerminalStreamHandleClass() {
  return class GatewayTerminalStreamHandle extends TerminalStreamBuffer {
    constructor(
      private readonly owner: BrowserGatewayTerminalStreamClient,
      readonly streamId: string,
      readonly maxBytes: number | undefined,
      snapshot: TerminalStreamSnapshot,
    ) {
      super(snapshot, {
        initialTransportReady: false,
        offlineInputRetryMs: INPUT_RETRY_MS,
        offlineResizeRetryMs: 50,
        sendInput: (bytes, buffer) =>
          owner.send(
            {
              kind: "input",
              streamId,
              sessionId: buffer.snapshot.session.id,
              projectPathKey: buffer.snapshot.session.projectPathKey,
            },
            bytes,
          ),
        sendResize: (resize, buffer) =>
          owner.send({
            kind: "resize",
            streamId,
            sessionId: buffer.snapshot.session.id,
            projectPathKey: buffer.snapshot.session.projectPathKey,
            ...resize,
          }),
        onInputSendError: (_error, bytes, buffer) => {
          buffer.markTransportDown();
          buffer.restoreInput(bytes);
          owner.scheduleReconnect();
        },
        onResizeSendError: (_error, resize, buffer) => {
          buffer.markTransportDown();
          buffer.retryResize(resize);
          owner.scheduleReconnect();
        },
      });
    }

    override dispose() {
      if (this.streamDisposed) return;
      super.dispose();
      this.owner.detach(this.streamId, this.snapshot.session, this);
    }

    replaySnapshot(snapshot: TerminalStreamSnapshot) {
      if (this.streamDisposed) return;
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
  };
}

type GatewayTerminalStreamHandle = InstanceType<
  ReturnType<typeof createGatewayTerminalStreamHandleClass>
>;

let gatewayTerminalStreamHandleCtor:
  | ReturnType<typeof createGatewayTerminalStreamHandleClass>
  | undefined;
function getGatewayTerminalStreamHandleCtor() {
  if (gatewayTerminalStreamHandleCtor === undefined) {
    gatewayTerminalStreamHandleCtor = createGatewayTerminalStreamHandleClass();
  }
  return gatewayTerminalStreamHandleCtor;
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
    const HandleCtor = getGatewayTerminalStreamHandleCtor();
    const streamHandle = new HandleCtor(this, streamId, options?.maxBytes, {
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
    const session = normalizeUnknownTerminalSession(header.session);
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
