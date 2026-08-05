import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  SshTerminalTab,
  SshTerminalTabsSnapshot,
  TerminalClient,
  TerminalEvent,
  TerminalSession,
  TerminalShellOption,
  TerminalShellOptions,
  TerminalSnapshot,
  TerminalSshCreateResult,
  TerminalSshLatency,
  TerminalSshMetadata,
  TerminalSshPrompt,
  TerminalStreamChunk,
  TerminalStreamHandle,
  TerminalStreamInputState,
  TerminalStreamSnapshot,
} from "./types";

type TerminalEventListener = (event: TerminalEvent) => void;

const globalTerminalListeners = new Set<TerminalEventListener>();
let globalListenerStarted = false;
const globalTerminalStreamHandles = new Set<TauriTerminalStreamHandle>();
let globalStreamListenerStarted = false;
const INPUT_FLUSH_BYTES = 4 * 1024;
const INPUT_FLUSH_MS = 8;
const INPUT_HIGH_WATER_BYTES = 256 * 1024;
const INPUT_LOW_WATER_BYTES = 128 * 1024;

function ensureGlobalTerminalListener() {
  if (globalListenerStarted) return;
  globalListenerStarted = true;
  void listen<RawTerminalEvent>("terminal:event", (event) => {
    const normalized = normalizeEvent(event.payload);
    if (!normalized) return;
    for (const listener of globalTerminalListeners) {
      listener(normalized);
    }
  });
}

function ensureGlobalTerminalStreamListener() {
  if (globalStreamListenerStarted) return;
  globalStreamListenerStarted = true;
  void listen<RawTerminalStreamEvent>("terminal:stream", (event) => {
    const chunk = normalizeStreamEvent(event.payload);
    if (!chunk) return;
    for (const handle of globalTerminalStreamHandles) {
      handle.accept(chunk);
    }
  });
}

type RawTerminalSession = Partial<TerminalSession> & {
  project_path_key?: string;
  created_at?: number;
  updated_at?: number;
  finished_at?: number | null;
  exit_code?: number | null;
  kind?: string;
  ssh?: RawTerminalSshMetadata | null;
};

type RawTerminalSshMetadata = Partial<TerminalSshMetadata> & {
  host_id?: string;
  host_name?: string;
  auth_type?: string;
  reconnect_attempt?: number;
  reconnect_max_attempts?: number;
  sftp_enabled?: boolean;
};

type RawTerminalSshPrompt = Partial<TerminalSshPrompt> & {
  host_id?: string;
  host_name?: string;
  fingerprint_sha256?: string;
  key_type?: string;
  answer_echo?: boolean;
};

type RawTerminalSnapshot = {
  session?: RawTerminalSession;
  output?: string;
  outputBytes?: unknown;
  output_bytes?: unknown;
  truncated?: boolean;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
  sshPrompt?: RawTerminalSshPrompt | null;
  ssh_prompt?: RawTerminalSshPrompt | null;
};

type RawTerminalStreamSnapshot = {
  session?: RawTerminalSession;
  bytes?: unknown;
  truncated?: boolean;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
};

type RawTerminalStreamEvent = {
  kind?: string;
  sessionId?: string;
  session_id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  startOffset?: number;
  start_offset?: number;
  endOffset?: number;
  end_offset?: number;
  bytes?: unknown;
};

type RawTerminalSshLatency = Partial<TerminalSshLatency> & {
  session_id?: string;
  latency_ms?: number;
};

type RawTerminalListResponse = {
  sessions?: RawTerminalSession[];
};

type RawSshTerminalTab = Partial<SshTerminalTab> & {
  session_id?: string;
  project_path_key?: string;
  created_at?: number;
  updated_at?: number;
};

type RawSshTerminalTabsSnapshot = Partial<SshTerminalTabsSnapshot> & {
  project_path_key?: string;
  tabs?: RawSshTerminalTab[];
};

type RawTerminalShellOption = Partial<TerminalShellOption>;

type RawTerminalShellOptionsResponse = {
  options?: RawTerminalShellOption[];
  defaultShell?: string;
  default_shell?: string;
};

type RawTerminalEvent = {
  kind?: string;
  sessionId?: string;
  session_id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  session?: RawTerminalSession;
  sshTabs?: RawSshTerminalTabsSnapshot | null;
  ssh_tabs?: RawSshTerminalTabsSnapshot | null;
  data?: string | null;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
};

function normalizeSession(input: RawTerminalSession): TerminalSession {
  const projectPathKey = input.projectPathKey ?? input.project_path_key ?? "";
  const kind = input.kind === "ssh" ? "ssh" : "local";
  return {
    id: input.id ?? "",
    projectPathKey,
    cwd: input.cwd ?? "",
    shell: input.shell ?? "",
    title: input.title ?? "Terminal",
    kind,
    ssh: input.ssh ? normalizeSshMetadata(input.ssh) : null,
    pid: kind === "ssh" ? null : (input.pid ?? null),
    cols: Number(input.cols ?? 80),
    rows: Number(input.rows ?? 24),
    createdAt: Number(input.createdAt ?? input.created_at ?? 0),
    updatedAt: Number(input.updatedAt ?? input.updated_at ?? 0),
    finishedAt: input.finishedAt ?? input.finished_at ?? null,
    exitCode: input.exitCode ?? input.exit_code ?? null,
    running: input.running === true,
  };
}

function normalizeSshMetadata(input: RawTerminalSshMetadata): TerminalSshMetadata {
  return {
    hostId: input.hostId ?? input.host_id ?? "",
    hostName: input.hostName ?? input.host_name ?? "",
    username: input.username ?? "",
    host: input.host ?? "",
    port: Number(input.port ?? 22),
    authType: input.authType ?? input.auth_type ?? "",
    status: input.status ?? "connected",
    reconnectAttempt: Number(input.reconnectAttempt ?? input.reconnect_attempt ?? 0),
    reconnectMaxAttempts: Number(input.reconnectMaxAttempts ?? input.reconnect_max_attempts ?? 3),
    sftpEnabled: input.sftpEnabled ?? input.sftp_enabled ?? false,
  };
}

function normalizeSshPrompt(
  input: RawTerminalSshPrompt | null | undefined,
): TerminalSshPrompt | undefined {
  if (!input) return undefined;
  const id = input.id?.trim() ?? "";
  if (!id) return undefined;
  return {
    id,
    kind: input.kind ?? "hostKey",
    hostId: input.hostId ?? input.host_id ?? "",
    hostName: input.hostName ?? input.host_name ?? "",
    host: input.host ?? "",
    port: Number(input.port ?? 22),
    message: input.message ?? "",
    fingerprintSha256: input.fingerprintSha256 ?? input.fingerprint_sha256 ?? undefined,
    keyType: input.keyType ?? input.key_type ?? undefined,
    answerEcho: input.answerEcho ?? input.answer_echo ?? false,
  };
}

function normalizeSnapshot(input: RawTerminalSnapshot): TerminalSnapshot {
  if (!input.session) {
    throw new Error("Terminal response did not include a session");
  }
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    session: normalizeSession(input.session),
    output: input.output ?? "",
    outputBytes: normalizeBytes(input.outputBytes ?? input.output_bytes),
    truncated: input.truncated === true,
    outputStartOffset,
    outputEndOffset,
  };
}

function normalizeStreamSnapshot(input: RawTerminalStreamSnapshot): TerminalStreamSnapshot {
  if (!input.session) {
    throw new Error("Terminal stream attach did not include a session");
  }
  return {
    session: normalizeSession(input.session),
    bytes: normalizeBytes(input.bytes),
    truncated: input.truncated === true,
    outputStartOffset:
      normalizeOptionalOffset(input.outputStartOffset ?? input.output_start_offset) ?? 0,
    outputEndOffset: normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset) ?? 0,
  };
}

function normalizeSshCreateResult(input: RawTerminalSnapshot): TerminalSshCreateResult {
  const prompt = normalizeSshPrompt(input.sshPrompt ?? input.ssh_prompt);
  return {
    snapshot: input.session ? normalizeSnapshot(input) : undefined,
    prompt,
  };
}

function normalizeSshLatency(input: RawTerminalSshLatency): TerminalSshLatency {
  const latencyMs = Number(input.latencyMs ?? input.latency_ms ?? 0);
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
    throw new Error("SSH latency response did not include latency");
  }
  return {
    sessionId: input.sessionId ?? input.session_id ?? "",
    latencyMs: Math.round(latencyMs),
  };
}

function normalizeShellOptions(input: RawTerminalShellOptionsResponse): TerminalShellOptions {
  const options = (input.options ?? [])
    .map((option) => ({
      id: option.id?.trim() ?? "",
      label: option.label?.trim() ?? "",
      command: option.command?.trim() ?? "",
    }))
    .filter((option) => option.id && option.label);
  return {
    options,
    defaultShell: input.defaultShell ?? input.default_shell ?? options[0]?.id ?? "default",
  };
}

function normalizeSshTerminalTab(input: RawSshTerminalTab): SshTerminalTab {
  const kind = input.kind === "sftp" ? "sftp" : "bash";
  return {
    id: input.id ?? "",
    sessionId: input.sessionId ?? input.session_id ?? "",
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    kind,
    createdAt: Number(input.createdAt ?? input.created_at ?? 0),
    updatedAt: Number(input.updatedAt ?? input.updated_at ?? 0),
  };
}

function normalizeSshTerminalTabsSnapshot(
  input: RawSshTerminalTabsSnapshot | null | undefined,
): SshTerminalTabsSnapshot {
  return {
    projectPathKey: input?.projectPathKey ?? input?.project_path_key ?? "",
    tabs: (input?.tabs ?? []).map(normalizeSshTerminalTab).filter((tab) => tab.id && tab.sessionId),
    revision: Number(input?.revision ?? 0),
  };
}

function normalizeEvent(input: RawTerminalEvent): TerminalEvent | null {
  const sshTabs = normalizeSshTerminalTabsSnapshot(input.sshTabs ?? input.ssh_tabs);
  if (!input.session && !input.sshTabs && !input.ssh_tabs) return null;
  const session = input.session ? normalizeSession(input.session) : undefined;
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    kind: input.kind ?? "",
    sessionId: input.sessionId ?? input.session_id ?? session?.id,
    projectPathKey:
      input.projectPathKey ??
      input.project_path_key ??
      session?.projectPathKey ??
      sshTabs.projectPathKey,
    session,
    outputStartOffset,
    outputEndOffset,
    sshTabs: input.sshTabs || input.ssh_tabs ? sshTabs : undefined,
  };
}

function normalizeStreamEvent(input: RawTerminalStreamEvent): TerminalStreamChunk | null {
  const sessionId = (input.sessionId ?? input.session_id ?? "").trim();
  if (!sessionId) return null;
  const bytes = normalizeBytes(input.bytes);
  if (bytes.byteLength === 0) return null;
  return {
    sessionId,
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    bytes,
    startOffset: normalizeOptionalOffset(input.startOffset ?? input.start_offset) ?? 0,
    endOffset: normalizeOptionalOffset(input.endOffset ?? input.end_offset) ?? 0,
  };
}

function normalizeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((item) => Number(item) & 0xff));
  }
  if (typeof value === "string" && value.length > 0) {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array();
}

function normalizeOptionalOffset(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

class TauriTerminalStreamHandle implements TerminalStreamHandle {
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
    globalTerminalStreamHandles.delete(this);
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
    void invoke("terminal_stream_input", {
      session_id: this.sessionId,
      bytes: Array.from(bytes),
    })
      .then(() => this.clearInputPaused())
      .catch(() => this.setInputPaused("closed"));
  }

  private flushResize() {
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    const latest = this.latestResize;
    this.latestResize = null;
    if (!latest) return;
    void invoke("terminal_stream_resize", {
      session_id: this.sessionId,
      cols: latest.cols,
      rows: latest.rows,
    }).catch(() => undefined);
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

export const tauriTerminalClient: TerminalClient = {
  async shellOptions() {
    return normalizeShellOptions(
      await invoke<RawTerminalShellOptionsResponse>("terminal_shell_options"),
    );
  },
  async list(projectPathKey) {
    const response = await invoke<RawTerminalListResponse>("terminal_list", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeSession);
  },
  async create(params) {
    return normalizeSnapshot(
      await invoke<RawTerminalSnapshot>("terminal_create", {
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
      await invoke<RawTerminalSnapshot>("terminal_create_ssh", {
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
      await invoke<RawTerminalSnapshot>("terminal_answer_ssh_prompt", {
        prompt_id: params.promptId,
        prompt_answer: params.answer,
        trust_host_key: params.trustHostKey,
      }),
    );
  },
  async cancelSshPrompt(promptId) {
    await invoke("terminal_cancel_ssh_prompt", {
      prompt_id: promptId,
    });
  },
  async sshReconnect(sessionId, _projectPathKey) {
    return normalizeSession(
      await invoke<RawTerminalSession>("terminal_ssh_reconnect", {
        session_id: sessionId,
      }),
    );
  },
  async sshLatency(sessionId, _projectPathKey) {
    return normalizeSshLatency(
      await invoke<RawTerminalSshLatency>("terminal_ssh_latency", {
        session_id: sessionId,
      }),
    );
  },
  async listSshTerminalTabs(projectPathKey) {
    return normalizeSshTerminalTabsSnapshot(
      await invoke<RawSshTerminalTabsSnapshot>("ssh_terminal_tabs_list", {
        project_path_key: projectPathKey,
      }),
    );
  },
  async openSshTerminalTab(params) {
    return normalizeSshTerminalTabsSnapshot(
      await invoke<RawSshTerminalTabsSnapshot>("ssh_terminal_tab_open", {
        session_id: params.sessionId,
        kind: params.kind,
      }),
    );
  },
  async closeSshTerminalTab(tabId) {
    return normalizeSshTerminalTabsSnapshot(
      await invoke<RawSshTerminalTabsSnapshot>("ssh_terminal_tab_close", {
        tab_id: tabId,
      }),
    );
  },
  async rename(sessionId, title, _projectPathKey) {
    return normalizeSession(
      await invoke<RawTerminalSession>("terminal_rename", {
        session_id: sessionId,
        title,
      }),
    );
  },
  async close(sessionId, _projectPathKey) {
    return normalizeSession(
      await invoke<RawTerminalSession>("terminal_close", {
        session_id: sessionId,
      }),
    );
  },
  async closeProject(projectPathKey) {
    const response = await invoke<RawTerminalListResponse>("terminal_close_project", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeSession);
  },
  subscribe(listener) {
    ensureGlobalTerminalListener();
    globalTerminalListeners.add(listener);
    return () => {
      globalTerminalListeners.delete(listener);
    };
  },
  stream: {
    async attach(session, options) {
      ensureGlobalTerminalStreamListener();
      const handle = new TauriTerminalStreamHandle(
        {
          session,
          bytes: new Uint8Array(),
          truncated: false,
          outputStartOffset: 0,
          outputEndOffset: 0,
        },
        session.id,
      );
      globalTerminalStreamHandles.add(handle);
      try {
        const snapshot = normalizeStreamSnapshot(
          await invoke<RawTerminalStreamSnapshot>("terminal_stream_attach", {
            session_id: session.id,
            max_bytes: options?.maxBytes,
          }),
        );
        handle.snapshot = snapshot;
        return handle;
      } catch (error) {
        handle.dispose();
        throw error;
      }
    },
  },
};
