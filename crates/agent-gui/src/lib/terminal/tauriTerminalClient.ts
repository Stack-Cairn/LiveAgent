import {
  buildTerminalCreatePayload,
  buildTerminalSshCreatePayload,
  buildTerminalSshPromptAnswerPayload,
  normalizeOptionalOffset,
  normalizeSshTerminalTabsSnapshot,
  normalizeTerminalByteContainer,
  normalizeTerminalEvent,
  normalizeTerminalSession,
  normalizeTerminalShellOptions,
  normalizeTerminalSnapshot,
  normalizeTerminalSshCreateResult,
  normalizeTerminalSshLatency,
  type RawSshTerminalTabsSnapshot,
  type RawTerminalEvent,
  type RawTerminalSession,
  type RawTerminalShellOptionsResponse,
  type RawTerminalSnapshot,
  type RawTerminalSshLatency,
} from "@liveagent/ui/lib/terminal/normalization";
import { TerminalStreamBuffer } from "@liveagent/ui/lib/terminal/streamBuffer";
import type {
  TerminalClient,
  TerminalEvent,
  TerminalStreamChunk,
  TerminalStreamSnapshot,
} from "@liveagent/ui/lib/terminal/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type TerminalEventListener = (event: TerminalEvent) => void;

const globalTerminalListeners = new Set<TerminalEventListener>();
let globalListenerStarted = false;
const globalTerminalStreamHandles = new Set<TauriTerminalStreamHandle>();
let globalStreamListenerStarted = false;

function ensureGlobalTerminalListener() {
  if (globalListenerStarted) return;
  globalListenerStarted = true;
  void listen<RawTerminalEvent>("terminal:event", (event) => {
    const normalized = normalizeTerminalEvent(event.payload);
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

type RawTerminalListResponse = {
  sessions?: RawTerminalSession[];
};

function normalizeStreamSnapshot(input: RawTerminalStreamSnapshot): TerminalStreamSnapshot {
  if (!input.session) {
    throw new Error("Terminal stream attach did not include a session");
  }
  return {
    session: normalizeTerminalSession(input.session),
    bytes: normalizeBytes(input.bytes),
    truncated: input.truncated === true,
    outputStartOffset:
      normalizeOptionalOffset(input.outputStartOffset ?? input.output_start_offset) ?? 0,
    outputEndOffset: normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset) ?? 0,
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
  return normalizeTerminalByteContainer(value, (text) => new TextEncoder().encode(text));
}

class TauriTerminalStreamHandle extends TerminalStreamBuffer {
  constructor(snapshot: TerminalStreamSnapshot, sessionId: string) {
    super(snapshot, {
      initialTransportReady: true,
      sendInput: async (bytes) => {
        await invoke("terminal_stream_input", {
          session_id: sessionId,
          bytes: Array.from(bytes),
        });
      },
      sendResize: async ({ cols, rows }) => {
        await invoke("terminal_stream_resize", {
          session_id: sessionId,
          cols,
          rows,
        });
      },
      onInputSendError: (_error, _bytes, buffer) => buffer.pauseInput("closed"),
    });
  }

  override dispose() {
    super.dispose();
    globalTerminalStreamHandles.delete(this);
  }
}

export const tauriTerminalClient: TerminalClient = {
  async shellOptions() {
    return normalizeTerminalShellOptions(
      await invoke<RawTerminalShellOptionsResponse>("terminal_shell_options"),
    );
  },
  async list(projectPathKey) {
    const response = await invoke<RawTerminalListResponse>("terminal_list", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeTerminalSession);
  },
  async create(params) {
    return normalizeTerminalSnapshot(
      await invoke<RawTerminalSnapshot>("terminal_create", {
        ...buildTerminalCreatePayload(params),
      }),
      normalizeBytes,
    );
  },
  async createSsh(params) {
    return normalizeTerminalSshCreateResult(
      await invoke<RawTerminalSnapshot>("terminal_create_ssh", {
        ...buildTerminalSshCreatePayload(params),
      }),
      normalizeBytes,
    );
  },
  async answerSshPrompt(params) {
    return normalizeTerminalSshCreateResult(
      await invoke<RawTerminalSnapshot>("terminal_answer_ssh_prompt", {
        ...buildTerminalSshPromptAnswerPayload(params),
      }),
      normalizeBytes,
    );
  },
  async cancelSshPrompt(promptId) {
    await invoke("terminal_cancel_ssh_prompt", {
      prompt_id: promptId,
    });
  },
  async sshReconnect(sessionId, _projectPathKey) {
    return normalizeTerminalSession(
      await invoke<RawTerminalSession>("terminal_ssh_reconnect", {
        session_id: sessionId,
      }),
    );
  },
  async sshLatency(sessionId, _projectPathKey) {
    return normalizeTerminalSshLatency(
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
    return normalizeTerminalSession(
      await invoke<RawTerminalSession>("terminal_rename", {
        session_id: sessionId,
        title,
      }),
    );
  },
  async close(sessionId, _projectPathKey) {
    return normalizeTerminalSession(
      await invoke<RawTerminalSession>("terminal_close", {
        session_id: sessionId,
      }),
    );
  },
  async closeProject(projectPathKey) {
    const response = await invoke<RawTerminalListResponse>("terminal_close_project", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeTerminalSession);
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
