import { type BackendEndpoint, resolveEndpoint, wsBaseUrl } from "../backend/endpoint";
import { backendInvoke } from "../backend/transport";
import {
  normalizeEvent,
  normalizeSession,
  normalizeShellOptions,
  normalizeSnapshot,
  normalizeSshCreateResult,
  normalizeSshLatency,
  normalizeSshTerminalTabsSnapshot,
  normalizeStreamSnapshot,
  type RawSshTerminalTabsSnapshot,
  type RawTerminalEvent,
  type RawTerminalListResponse,
  type RawTerminalSession,
  type RawTerminalShellOptionsResponse,
  type RawTerminalSnapshot,
  type RawTerminalSshLatency,
  type RawTerminalStreamSnapshot,
} from "./normalize";
import type {
  TerminalClient,
  TerminalEvent,
  TerminalStreamChunk,
  TerminalStreamHandle,
  TerminalStreamInputState,
  TerminalStreamSnapshot,
} from "./types";

type TerminalEventListener = (event: TerminalEvent) => void;

const INPUT_FLUSH_BYTES = 4 * 1024;
const INPUT_FLUSH_MS = 8;
const INPUT_HIGH_WATER_BYTES = 256 * 1024;
const INPUT_LOW_WATER_BYTES = 128 * 1024;
const ATTACH_TIMEOUT_MS = 15_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type DownFrame = {
  kind?: string;
  sessionId?: string;
  session?: RawTerminalStreamSnapshot["session"];
  bytes?: string;
  startOffset?: number;
  endOffset?: number;
  truncated?: boolean;
  event?: RawTerminalEvent;
  error?: string;
};

const eventListeners = new Set<TerminalEventListener>();
const handles = new Map<string, WsTerminalStreamHandle>();
const pendingAttach = new Map<string, (frame: DownFrame) => void>();

let socket: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 500;

function isOpen(candidate: WebSocket | null): candidate is WebSocket {
  return candidate !== null && candidate.readyState === WebSocket.OPEN;
}

async function ensureSocket(): Promise<WebSocket> {
  if (isOpen(socket)) return socket;
  if (connecting) return connecting;

  connecting = (async () => {
    const endpoint: BackendEndpoint = await resolveEndpoint();
    const url = new URL(`${wsBaseUrl(endpoint)}/ws/terminal`);
    url.searchParams.set("token", endpoint.password);
    const next = new WebSocket(url.toString());

    await new Promise<void>((resolve, reject) => {
      next.onopen = () => resolve();
      next.onerror = () => reject(new Error("终端 WS 连接失败"));
    });

    socket = next;
    retryDelay = 500;
    next.onmessage = (message) => {
      let frame: DownFrame;
      try {
        frame = JSON.parse(String(message.data)) as DownFrame;
      } catch {
        return;
      }
      handleFrame(frame);
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      for (const handle of handles.values()) {
        handle.notifyOffline();
      }
      scheduleReconnect();
    };
    next.onerror = () => {
      // onclose 紧随其后，重连只写一处
    };
    return next;
  })();

  connecting
    .catch(() => undefined)
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  if (handles.size === 0 && eventListeners.size === 0) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 10_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureSocket()
      .then(() => {
        for (const handle of handles.values()) {
          handle.reattach();
        }
      })
      .catch(() => scheduleReconnect());
  }, delay);
}

function send(frame: Record<string, unknown>): boolean {
  if (!isOpen(socket)) return false;
  socket.send(JSON.stringify(frame));
  return true;
}
function handleFrame(frame: DownFrame) {
  if (frame.kind === "event") {
    const normalized = frame.event ? normalizeEvent(frame.event) : null;
    if (!normalized) return;
    for (const listener of eventListeners) {
      listener(normalized);
    }
    return;
  }

  const sessionId = (frame.sessionId ?? "").trim();

  if (frame.kind === "snapshot") {
    const waiter = pendingAttach.get(sessionId);
    if (waiter) {
      waiter(frame);
      return;
    }
    handles.get(sessionId)?.acceptReattachSnapshot(frame);
    return;
  }

  if (frame.kind === "error") {
    const waiter = pendingAttach.get(sessionId);
    if (waiter) {
      waiter(frame);
      return;
    }
    console.warn("终端 WS 错误帧", frame.error);
    return;
  }

  if (frame.kind !== "output" || !sessionId) return;
  const bytes = base64ToBytes(frame.bytes);
  if (bytes.byteLength === 0) return;
  const handle = handles.get(sessionId);
  handle?.accept({
    sessionId,
    projectPathKey: handle.snapshot.session.projectPathKey,
    bytes,
    startOffset: Number(frame.startOffset ?? 0),
    endOffset: Number(frame.endOffset ?? 0),
  });
}

class WsTerminalStreamHandle implements TerminalStreamHandle {
  private disposed = false;
  private readonly listeners = new Set<(chunk: TerminalStreamChunk) => void>();
  private readonly inputStateListeners = new Set<(state: TerminalStreamInputState) => void>();
  private readonly queuedChunks: TerminalStreamChunk[] = [];
  private inputQueue: Uint8Array[] = [];
  private inputBytes = 0;
  private inputTimer: number | null = null;
  private resizeTimer: number | null = null;
  private latestResize: { cols: number; rows: number } | null = null;
  private inputPausedReason: TerminalStreamInputState["reason"] | null = null;

  constructor(
    public snapshot: TerminalStreamSnapshot,
    private readonly sessionId: string,
    private readonly maxBytes: number | undefined,
  ) {}

  accept(chunk: TerminalStreamChunk) {
    if (this.disposed || chunk.sessionId !== this.sessionId) return;
    if (this.listeners.size === 0) {
      this.queuedChunks.push(chunk);
      return;
    }
    for (const listener of this.listeners) {
      listener(chunk);
    }
  }

  acceptReattachSnapshot(frame: DownFrame) {
    if (this.disposed) return;
    this.snapshot = normalizeStreamSnapshot({
      session: frame.session,
      bytes: base64ToBytes(frame.bytes),
      truncated: frame.truncated,
      outputStartOffset: frame.startOffset,
      outputEndOffset: frame.endOffset,
    });
    if (this.snapshot.bytes.byteLength === 0 || this.listeners.size === 0) return;
    for (const listener of this.listeners) {
      listener({
        sessionId: this.sessionId,
        projectPathKey: this.snapshot.session.projectPathKey,
        bytes: this.snapshot.bytes,
        startOffset: this.snapshot.outputStartOffset,
        endOffset: this.snapshot.outputEndOffset,
      });
    }
  }

  notifyOffline() {
    if (this.disposed) return;
    this.setInputPaused("offline");
  }

  reattach() {
    if (this.disposed) return;
    send({ kind: "attach", sessionId: this.sessionId, maxBytes: this.maxBytes });
    // 先冲掉离线期间的积压输入，成功路径会顺带解除 offline 暂停
    this.flushInput();
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
    if (this.inputTimer === null) {
      this.inputTimer = window.setTimeout(() => this.flushInput(), INPUT_FLUSH_MS);
    }
    return true;
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    this.latestResize = {
      cols: Math.max(20, Math.min(400, Math.round(cols))),
      rows: Math.max(6, Math.min(200, Math.round(rows))),
    };
    if (this.resizeTimer !== null) return;
    this.resizeTimer = window.setTimeout(() => this.flushResize(), 16);
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
    if (this.inputTimer !== null) {
      window.clearTimeout(this.inputTimer);
      this.inputTimer = null;
    }
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    send({ kind: "detach", sessionId: this.sessionId });
    handles.delete(this.sessionId);
    this.listeners.clear();
    this.inputStateListeners.clear();
    this.queuedChunks.length = 0;
    this.inputPausedReason = "closed";
  }

  private flushInput() {
    if (this.inputTimer !== null) {
      window.clearTimeout(this.inputTimer);
      this.inputTimer = null;
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
    const delivered = send({
      kind: "input",
      sessionId: this.sessionId,
      data: bytesToBase64(bytes),
    });
    if (delivered) {
      this.clearInputPaused();
    } else {
      this.setInputPaused("offline");
    }
  }

  private flushResize() {
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    const latest = this.latestResize;
    this.latestResize = null;
    if (!latest) return;
    send({
      kind: "resize",
      sessionId: this.sessionId,
      cols: latest.cols,
      rows: latest.rows,
    });
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
    if (this.inputPausedReason === null || this.inputBytes > INPUT_LOW_WATER_BYTES) {
      return;
    }
    this.inputPausedReason = null;
    this.emitInputState();
  }
}
async function attachSession(
  sessionId: string,
  maxBytes: number | undefined,
): Promise<TerminalStreamSnapshot> {
  await ensureSocket();
  return new Promise<TerminalStreamSnapshot>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingAttach.delete(sessionId);
      reject(new Error(`终端 attach 超时（${ATTACH_TIMEOUT_MS}ms）: ${sessionId}`));
    }, ATTACH_TIMEOUT_MS);

    pendingAttach.set(sessionId, (frame) => {
      window.clearTimeout(timer);
      pendingAttach.delete(sessionId);
      if (frame.kind === "error") {
        reject(new Error(frame.error ?? "终端 attach 失败"));
        return;
      }
      try {
        resolve(
          normalizeStreamSnapshot({
            session: frame.session,
            bytes: base64ToBytes(frame.bytes),
            truncated: frame.truncated,
            outputStartOffset: frame.startOffset,
            outputEndOffset: frame.endOffset,
          }),
        );
      } catch (error) {
        reject(error);
      }
    });

    if (!send({ kind: "attach", sessionId, maxBytes })) {
      window.clearTimeout(timer);
      pendingAttach.delete(sessionId);
      reject(new Error("终端 WS 未连接，无法 attach"));
    }
  });
}

export const wsTerminalClient: TerminalClient = {
  async shellOptions() {
    return normalizeShellOptions(
      await backendInvoke<RawTerminalShellOptionsResponse>("terminal_shell_options"),
    );
  },
  async list(projectPathKey) {
    const response = await backendInvoke<RawTerminalListResponse>("terminal_list", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeSession);
  },
  async create(params) {
    return normalizeSnapshot(
      await backendInvoke<RawTerminalSnapshot>("terminal_create", {
        cwd: params.cwd,
        project_path_key: params.projectPathKey,
        shell: params.shell,
        title: params.title,
        cols: params.cols,
        rows: params.rows,
      }),
    );
  },
  async createSsh(params) {
    return normalizeSshCreateResult(
      await backendInvoke<RawTerminalSnapshot>("terminal_create_ssh", {
        cwd: params.cwd,
        project_path_key: params.projectPathKey,
        ssh_host_id: params.hostId,
        title: params.title,
        cols: params.cols,
        rows: params.rows,
        sftp_enabled: params.sftpEnabled ?? false,
      }),
    );
  },
  async answerSshPrompt(params) {
    return normalizeSshCreateResult(
      await backendInvoke<RawTerminalSnapshot>("terminal_answer_ssh_prompt", {
        prompt_id: params.promptId,
        prompt_answer: params.answer,
        trust_host_key: params.trustHostKey,
      }),
    );
  },
  async cancelSshPrompt(promptId) {
    await backendInvoke("terminal_cancel_ssh_prompt", {
      prompt_id: promptId,
    });
  },
  async sshReconnect(sessionId, _projectPathKey) {
    return normalizeSession(
      await backendInvoke<RawTerminalSession>("terminal_ssh_reconnect", {
        session_id: sessionId,
      }),
    );
  },
  async sshLatency(sessionId, _projectPathKey) {
    return normalizeSshLatency(
      await backendInvoke<RawTerminalSshLatency>("terminal_ssh_latency", {
        session_id: sessionId,
      }),
    );
  },
  async listSshTerminalTabs(projectPathKey) {
    return normalizeSshTerminalTabsSnapshot(
      await backendInvoke<RawSshTerminalTabsSnapshot>("ssh_terminal_tabs_list", {
        project_path_key: projectPathKey,
      }),
    );
  },
  async openSshTerminalTab(params) {
    return normalizeSshTerminalTabsSnapshot(
      await backendInvoke<RawSshTerminalTabsSnapshot>("ssh_terminal_tab_open", {
        session_id: params.sessionId,
        kind: params.kind,
      }),
    );
  },
  async closeSshTerminalTab(tabId) {
    return normalizeSshTerminalTabsSnapshot(
      await backendInvoke<RawSshTerminalTabsSnapshot>("ssh_terminal_tab_close", {
        tab_id: tabId,
      }),
    );
  },
  async rename(sessionId, title, _projectPathKey) {
    return normalizeSession(
      await backendInvoke<RawTerminalSession>("terminal_rename", {
        session_id: sessionId,
        title,
      }),
    );
  },
  async close(sessionId, _projectPathKey) {
    return normalizeSession(
      await backendInvoke<RawTerminalSession>("terminal_close", {
        session_id: sessionId,
      }),
    );
  },
  async closeProject(projectPathKey) {
    const response = await backendInvoke<RawTerminalListResponse>("terminal_close_project", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeSession);
  },
  subscribe(listener) {
    eventListeners.add(listener);
    void ensureSocket().catch(() => scheduleReconnect());
    return () => {
      eventListeners.delete(listener);
    };
  },
  stream: {
    async attach(session, options) {
      const existing = handles.get(session.id);
      if (existing) existing.dispose();
      const snapshot = await attachSession(session.id, options?.maxBytes);
      const handle = new WsTerminalStreamHandle(snapshot, session.id, options?.maxBytes);
      handles.set(session.id, handle);
      return handle;
    },
  },
};
