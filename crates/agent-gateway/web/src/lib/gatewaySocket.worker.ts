import type {
  GatewaySettingsSyncPayload,
  GatewaySettingsSyncUpdatePayload,
} from "@/lib/settings/sync";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type {
  TerminalEvent,
  TerminalSession,
  TerminalSnapshot,
  TerminalStreamChunk,
  TerminalStreamHandle,
  TerminalStreamInputState,
  TerminalStreamSnapshot,
} from "@/lib/terminal/types";

import { GatewayWebSocketClient } from "./gatewaySocket";
import type {
  AgentStatus,
  CronManagePayload,
  MemoryManagePayload,
} from "./gatewayTypes";

type WorkerClientRequest =
  | {
      type: "connect";
      connection_id: string;
      token: string;
    }
  | {
      type: "request";
      connection_id: string;
      request_id: string;
      method: string;
      payload?: unknown;
    }
  | {
      type: "wakeup";
      connection_id: string;
    }
  | {
      type: "terminal_stream_attach";
      connection_id: string;
      stream_id: string;
      session: TerminalSession;
      max_bytes?: number;
    }
  | {
      type: "terminal_stream_write";
      connection_id: string;
      stream_id: string;
      session_id: string;
      bytes?: Uint8Array<ArrayBufferLike> | ArrayBuffer;
    }
  | {
      type: "terminal_stream_resize";
      connection_id: string;
      stream_id: string;
      session_id: string;
      cols: number;
      rows: number;
    }
  | {
      type: "terminal_stream_detach";
      connection_id: string;
      stream_id: string;
      session_id: string;
    }
  | {
      type: "dispose";
      connection_id: string;
    };

type ManagedClient = {
  token: string;
  client: GatewayWebSocketClient;
  ports: Set<MessagePort>;
  status: AgentStatus | null;
  statusError: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  terminalSessions: Map<string, TerminalSession>;
  terminalStreams: Map<string, ManagedTerminalStream>;
  terminalStreamPageSessions: Map<string, string>;
};

type PortState = {
  connectionID: string;
  client: ManagedClient;
  terminalAllProjects: boolean;
  terminalProjectKeys: Set<string>;
  terminalSessionIds: Set<string>;
  terminalStreamIds: Set<string>;
};

type ManagedTerminalStream = {
  session: TerminalSession;
  maxBytes: number;
  handle: TerminalStreamHandle | null;
  attaching: Promise<TerminalStreamHandle> | null;
  pageStreams: Map<string, { port: MessagePort; connectionID: string }>;
  unsubscribe: (() => void) | null;
  inputStateUnsubscribe: (() => void) | null;
  lastInputState: TerminalStreamInputState;
};

type SharedWorkerScope = {
  onconnect: ((event: MessageEvent & { ports: MessagePort[] }) => void) | null;
};

const clients = new Map<string, ManagedClient>();
const portStates = new Map<MessagePort, PortState>();
const MANAGED_CLIENT_WARM_WINDOW_MS = 10 * 60_000;

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const text = String(error ?? "").trim();
  return text || fallback;
}

function postToPort(port: MessagePort, payload: unknown) {
  try {
    port.postMessage(payload);
  } catch {
    disconnectPort(port);
  }
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWorkerHistoryMessageRef(value: unknown): HistoryMessageRef {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const segmentIndex = readNumber(body.segmentIndex ?? body.segment_index);
  const messageIndex = readNumber(body.messageIndex ?? body.message_index);
  const segmentId = readString(body.segmentId ?? body.segment_id);
  const messageId = readString(body.messageId ?? body.message_id);
  const role = readString(body.role);
  const contentHash = readString(body.contentHash ?? body.content_hash);
  if (
    segmentIndex === undefined ||
    messageIndex === undefined ||
    segmentIndex < 0 ||
    messageIndex < 0 ||
    !segmentId ||
    !messageId ||
    !role ||
    !contentHash
  ) {
    throw new Error("history.prefix requires a complete base_message_ref");
  }
  return {
    segmentIndex,
    messageIndex,
    segmentId,
    messageId,
    role,
    contentHash,
  };
}

function broadcast(client: ManagedClient, payload: Record<string, unknown>) {
  for (const port of [...client.ports]) {
    const state = portStates.get(port);
    if (!state || state.client !== client) {
      client.ports.delete(port);
      continue;
    }
    postToPort(port, {
      ...payload,
      connection_id: state.connectionID,
    });
  }
}

function shouldPostTerminalEventToPort(state: PortState, event: TerminalEvent) {
  const sessionID = event.sessionId?.trim() ?? "";
  if (event.kind === "output") {
    return sessionID !== "" && state.terminalSessionIds.has(sessionID);
  }
  const projectPathKey = event.projectPathKey.trim();
  if (sessionID !== "" || projectPathKey !== "") {
    return true;
  }
  if (state.terminalAllProjects) {
    return true;
  }
  return (
    (sessionID !== "" && state.terminalSessionIds.has(sessionID)) ||
    (projectPathKey !== "" && state.terminalProjectKeys.has(projectPathKey))
  );
}

function applyTerminalSessionEvent(
  sessions: Map<string, TerminalSession>,
  event: TerminalEvent,
) {
  if (event.kind === "output") return;
  const sessionId = (event.sessionId || event.session?.id || "").trim();
  if (event.kind === "closed") {
    if (sessionId) {
      sessions.delete(sessionId);
    }
    return;
  }
  const session = event.session;
  if (session?.id) {
    sessions.set(session.id, session);
  }
}

function replayTerminalSessionsToPort(port: MessagePort, state: PortState) {
  const sessions = [...state.client.terminalSessions.values()].sort((a, b) => {
    const leftProject = (a.projectPathKey || a.cwd || "").trim();
    const rightProject = (b.projectPathKey || b.cwd || "").trim();
    return leftProject.localeCompare(rightProject) || a.createdAt - b.createdAt;
  });
  for (const session of sessions) {
    const event: TerminalEvent = {
      kind: "created",
      sessionId: session.id,
      projectPathKey: session.projectPathKey,
      session,
    };
    if (!shouldPostTerminalEventToPort(state, event)) {
      continue;
    }
    postToPort(port, {
      type: "event",
      event_type: "terminal",
      payload: event,
      connection_id: state.connectionID,
    });
  }
}

function broadcastTerminal(client: ManagedClient, event: TerminalEvent) {
  for (const port of [...client.ports]) {
    const state = portStates.get(port);
    if (!state || state.client !== client) {
      client.ports.delete(port);
      continue;
    }
    if (!shouldPostTerminalEventToPort(state, event)) {
      continue;
    }
    postToPort(port, {
      type: "event",
      event_type: "terminal",
      payload: event,
      connection_id: state.connectionID,
    });
  }
}

function normalizeTerminalStreamBytes(input: unknown) {
  if (input instanceof Uint8Array) {
    return input.byteLength === 0 ? input : input.slice();
  }
  if (input instanceof ArrayBuffer) {
    return input.byteLength === 0 ? new Uint8Array() : new Uint8Array(input.slice(0));
  }
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return new Uint8Array();
}

function postTerminalStreamSnapshot(
  port: MessagePort,
  connectionID: string,
  streamID: string,
  snapshot: TerminalStreamSnapshot,
) {
  postToPort(port, {
    type: "terminal_stream_snapshot",
    connection_id: connectionID,
    stream_id: streamID,
    payload: snapshot,
  });
}

function postTerminalStreamOutput(
  port: MessagePort,
  connectionID: string,
  streamID: string,
  chunk: TerminalStreamChunk,
) {
  postToPort(port, {
    type: "terminal_stream_output",
    connection_id: connectionID,
    stream_id: streamID,
    payload: chunk,
  });
}

function postTerminalStreamInputState(
  port: MessagePort,
  connectionID: string,
  streamID: string,
  state: TerminalStreamInputState,
) {
  postToPort(port, {
    type: "terminal_stream_input_state",
    connection_id: connectionID,
    stream_id: streamID,
    payload: state,
  });
}

function postTerminalStreamError(
  port: MessagePort,
  connectionID: string,
  streamID: string,
  error: string,
) {
  postToPort(port, {
    type: "terminal_stream_error",
    connection_id: connectionID,
    stream_id: streamID,
    error,
  });
}

function closeManagedTerminalStream(
  client: ManagedClient,
  sessionID: string,
  entry: ManagedTerminalStream,
) {
  if (client.terminalStreams.get(sessionID) !== entry) {
    return;
  }
  client.terminalStreams.delete(sessionID);
  for (const streamID of entry.pageStreams.keys()) {
    client.terminalStreamPageSessions.delete(streamID);
  }
  entry.pageStreams.clear();
  entry.unsubscribe?.();
  entry.unsubscribe = null;
  entry.inputStateUnsubscribe?.();
  entry.inputStateUnsubscribe = null;
  entry.handle?.dispose();
  entry.handle = null;
  entry.attaching = null;
}

function closeAllManagedTerminalStreams(client: ManagedClient) {
  for (const [sessionID, entry] of [...client.terminalStreams]) {
    closeManagedTerminalStream(client, sessionID, entry);
  }
  client.terminalStreamPageSessions.clear();
}

function broadcastTerminalStreamChunk(
  client: ManagedClient,
  sessionID: string,
  entry: ManagedTerminalStream,
  chunk: TerminalStreamChunk,
) {
  for (const [streamID, ref] of [...entry.pageStreams]) {
    const state = portStates.get(ref.port);
    if (!state || state.client !== client || state.connectionID !== ref.connectionID) {
      entry.pageStreams.delete(streamID);
      client.terminalStreamPageSessions.delete(streamID);
      continue;
    }
    postTerminalStreamOutput(ref.port, ref.connectionID, streamID, chunk);
  }
  if (entry.pageStreams.size === 0) {
    closeManagedTerminalStream(client, sessionID, entry);
  }
}

function broadcastTerminalStreamInputState(
  client: ManagedClient,
  sessionID: string,
  entry: ManagedTerminalStream,
  inputState: TerminalStreamInputState,
) {
  for (const [streamID, ref] of [...entry.pageStreams]) {
    const state = portStates.get(ref.port);
    if (!state || state.client !== client || state.connectionID !== ref.connectionID) {
      entry.pageStreams.delete(streamID);
      client.terminalStreamPageSessions.delete(streamID);
      continue;
    }
    postTerminalStreamInputState(ref.port, ref.connectionID, streamID, inputState);
  }
  if (entry.pageStreams.size === 0) {
    closeManagedTerminalStream(client, sessionID, entry);
  }
}

function ensureManagedTerminalStreamAttached(
  client: ManagedClient,
  sessionID: string,
  entry: ManagedTerminalStream,
) {
  if (entry.handle) {
    return;
  }
  if (entry.attaching) {
    return;
  }

  entry.attaching = client.client.terminalStream.attach(entry.session, {
    maxBytes: entry.maxBytes,
  });
  entry.attaching
    .then((handle) => {
      if (client.terminalStreams.get(sessionID) !== entry || entry.pageStreams.size === 0) {
        handle.dispose();
        return;
      }
      entry.handle = handle;
      entry.attaching = null;
      entry.unsubscribe = handle.subscribeOutput((chunk) => {
        broadcastTerminalStreamChunk(client, sessionID, entry, chunk);
      });
      entry.inputStateUnsubscribe = handle.subscribeInputState((inputState) => {
        entry.lastInputState = inputState;
        broadcastTerminalStreamInputState(client, sessionID, entry, inputState);
      });
      for (const [streamID, ref] of entry.pageStreams) {
        postTerminalStreamSnapshot(ref.port, ref.connectionID, streamID, handle.snapshot);
      }
    })
    .catch((error) => {
      const message = asErrorMessage(error, "Terminal stream attach failed");
      for (const [streamID, ref] of entry.pageStreams) {
        postTerminalStreamError(ref.port, ref.connectionID, streamID, message);
      }
      closeManagedTerminalStream(client, sessionID, entry);
    });
}

function handleTerminalStreamAttach(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "terminal_stream_attach" }>,
) {
  const streamID = message.stream_id.trim();
  const session = message.session;
  const sessionID = session?.id?.trim() ?? "";
  if (!streamID || !sessionID) {
    postTerminalStreamError(port, state.connectionID, streamID, "Terminal stream attach is invalid");
    return;
  }

  const previousSessionID = state.client.terminalStreamPageSessions.get(streamID);
  if (previousSessionID) {
    detachTerminalStreamPage(state, streamID, previousSessionID);
  }

  state.terminalStreamIds.add(streamID);
  state.terminalSessionIds.add(sessionID);
  state.client.terminalStreamPageSessions.set(streamID, sessionID);

  let entry = state.client.terminalStreams.get(sessionID);
  if (!entry) {
    entry = {
      session,
      maxBytes: Math.max(0, Math.round(message.max_bytes ?? 256 * 1024)),
      handle: null,
      attaching: null,
      pageStreams: new Map(),
      unsubscribe: null,
      inputStateUnsubscribe: null,
      lastInputState: {
        paused: false,
        queuedBytes: 0,
        highWaterBytes: 256 * 1024,
      },
    };
    state.client.terminalStreams.set(sessionID, entry);
  } else {
    entry.session = session;
    entry.maxBytes = Math.max(entry.maxBytes, Math.max(0, Math.round(message.max_bytes ?? 0)));
  }

  entry.pageStreams.set(streamID, { port, connectionID: state.connectionID });
  if (entry.handle) {
    postTerminalStreamSnapshot(port, state.connectionID, streamID, entry.handle.snapshot);
    postTerminalStreamInputState(port, state.connectionID, streamID, entry.lastInputState);
    return;
  }
  ensureManagedTerminalStreamAttached(state.client, sessionID, entry);
}

function terminalStreamEntryForMessage(
  state: PortState,
  streamID: string,
) {
  if (!state.terminalStreamIds.has(streamID)) {
    return null;
  }
  const sessionID = state.client.terminalStreamPageSessions.get(streamID) ?? "";
  if (!sessionID) {
    return null;
  }
  return state.client.terminalStreams.get(sessionID) ?? null;
}

function handleTerminalStreamWrite(
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "terminal_stream_write" }>,
) {
  const streamID = message.stream_id.trim();
  const entry = terminalStreamEntryForMessage(state, streamID);
  if (!entry?.handle) {
    return;
  }
  const bytes = normalizeTerminalStreamBytes(message.bytes);
  if (bytes.byteLength === 0) {
    return;
  }
  const accepted = entry.handle.write(bytes);
  if (!accepted) {
    const inputState = entry.lastInputState.paused
      ? entry.lastInputState
      : {
          paused: true,
          queuedBytes: 0,
          highWaterBytes: entry.lastInputState.highWaterBytes,
          reason: "slow" as const,
        };
    for (const [pageStreamID, pageStream] of entry.pageStreams) {
      postTerminalStreamInputState(pageStream.port, pageStream.connectionID, pageStreamID, inputState);
    }
  }
}

function handleTerminalStreamResize(
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "terminal_stream_resize" }>,
) {
  const streamID = message.stream_id.trim();
  const entry = terminalStreamEntryForMessage(state, streamID);
  if (!entry?.handle) {
    return;
  }
  entry.handle.resize(message.cols, message.rows);
}

function detachTerminalStreamPage(
  state: PortState,
  streamID: string,
  fallbackSessionID: string,
) {
  const sessionID =
    state.client.terminalStreamPageSessions.get(streamID) || fallbackSessionID.trim();
  if (!sessionID) {
    return;
  }
  state.terminalStreamIds.delete(streamID);
  state.client.terminalStreamPageSessions.delete(streamID);
  const entry = state.client.terminalStreams.get(sessionID);
  if (!entry) {
    return;
  }
  entry.pageStreams.delete(streamID);
  if (entry.pageStreams.size === 0) {
    closeManagedTerminalStream(state.client, sessionID, entry);
  }
}

function scheduleManagedClientCleanup(client: ManagedClient) {
  if (client.ports.size > 0 || client.idleTimer !== null) {
    return;
  }
  client.idleTimer = setTimeout(() => {
    client.idleTimer = null;
    if (client.ports.size > 0) {
      return;
    }
    closeAllManagedTerminalStreams(client);
    client.client.dispose();
    clients.delete(client.token);
  }, MANAGED_CLIENT_WARM_WINDOW_MS);
}

function clearManagedClientCleanup(client: ManagedClient) {
  if (client.idleTimer === null) {
    return;
  }
  clearTimeout(client.idleTimer);
  client.idleTimer = null;
}

function getManagedClient(token: string) {
  const normalizedToken = token.trim();
  const existing = clients.get(normalizedToken);
  if (existing) {
    return existing;
  }

  const managed: ManagedClient = {
    token: normalizedToken,
    client: new GatewayWebSocketClient(normalizedToken),
    ports: new Set(),
    status: null,
    statusError: null,
    idleTimer: null,
    terminalSessions: new Map(),
    terminalStreams: new Map(),
    terminalStreamPageSessions: new Map(),
  };

  managed.client.subscribeStatus((status, error) => {
    managed.status = status;
    managed.statusError = error;
    if (status?.online === false) {
      managed.terminalSessions.clear();
      closeAllManagedTerminalStreams(managed);
    }
    broadcast(managed, {
      type: "event",
      event_type: "status",
      payload: { status, error },
    });
  });
  managed.client.subscribeHistory((event) => {
    broadcast(managed, {
      type: "event",
      event_type: "history",
      payload: event,
    });
  });
  managed.client.subscribeSettings((event) => {
    broadcast(managed, {
      type: "event",
      event_type: "settings",
      payload: event,
    });
  });
  managed.client.subscribeTerminal((event) => {
    applyTerminalSessionEvent(managed.terminalSessions, event);
    broadcastTerminal(managed, event);
  });
  managed.client.subscribeSftpTransfers((event) => {
    broadcast(managed, {
      type: "event",
      event_type: "sftp",
      payload: event,
    });
  });
  managed.client.subscribeChatQueue((snapshot) => {
    broadcast(managed, {
      type: "event",
      event_type: "chat_queue",
      payload: snapshot,
    });
  });

  clients.set(normalizedToken, managed);
  return managed;
}

function connectPort(
  port: MessagePort,
  message: Extract<WorkerClientRequest, { type: "connect" }>,
) {
  const client = getManagedClient(message.token);
  clearManagedClientCleanup(client);
  client.ports.add(port);
  const state: PortState = {
    connectionID: message.connection_id,
    client,
    terminalAllProjects: false,
    terminalProjectKeys: new Set(),
    terminalSessionIds: new Set(),
    terminalStreamIds: new Set(),
  };
  portStates.set(port, state);
  postToPort(port, {
    type: "ready",
    connection_id: message.connection_id,
    payload: {
      status: client.status,
      error: client.statusError,
    },
  });
  replayTerminalSessionsToPort(port, state);
}

function disconnectPort(port: MessagePort) {
  const state = portStates.get(port);
  if (!state) {
    return;
  }
  const terminalStreamIds = [...state.terminalStreamIds];
  for (const streamID of terminalStreamIds) {
    detachTerminalStreamPage(state, streamID, "");
  }
  state.client.ports.delete(port);
  portStates.delete(port);
  scheduleManagedClientCleanup(state.client);
}

async function resolveRequest(client: GatewayWebSocketClient, method: string, payload: unknown) {
  const body = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case "status.get":
      return client.getStatus();
    case "chat.prepare":
      client.noteForegroundWakeup();
      return client.prepareChatRuntime("shared-worker");
    case "fs.roots":
      return client.listFsRoots();
    case "fs.list_dirs":
      return client.listDirs(
        String(body.path ?? ""),
        typeof body.max_results === "number" ? body.max_results : undefined,
      );
    case "fs.create_project_folder":
      return client.createProjectFolder(String(body.parent ?? ""), String(body.name ?? ""));
    case "fs.list":
      return client.listFiles(
        String(body.workdir ?? ""),
        typeof body.path === "string" ? body.path : undefined,
        typeof body.depth === "number" ? body.depth : undefined,
        typeof body.offset === "number" ? body.offset : undefined,
        typeof body.max_results === "number" ? body.max_results : undefined,
      );
    case "fs.write_text":
      return client.writeTextFile({
        workdir: String(body.workdir ?? ""),
        path: String(body.path ?? ""),
        content: typeof body.content === "string" ? body.content : "",
        mode: typeof body.mode === "string" ? body.mode : undefined,
        expectedMtimeMs:
          typeof body.expected_mtime_ms === "number" ? body.expected_mtime_ms : undefined,
        expectedContentHash:
          typeof body.expected_content_hash === "string" ? body.expected_content_hash : undefined,
      });
    case "fs.read_editable_text":
      return client.readEditableTextFile(String(body.workdir ?? ""), String(body.path ?? ""));
    case "fs.read_workspace_image":
      return client.readWorkspaceImageFile(String(body.workdir ?? ""), String(body.path ?? ""));
    case "fs.create_dir":
      return client.createDir(String(body.workdir ?? ""), String(body.path ?? ""));
    case "fs.rename":
      return client.renamePath(
        String(body.workdir ?? ""),
        String(body.from_path ?? ""),
        String(body.to_path ?? ""),
      );
    case "fs.delete":
      return client.deletePath(String(body.workdir ?? ""), String(body.path ?? ""));
    case "history.list":
      return client.listHistory(
        typeof body.page === "number" ? body.page : 0,
        typeof body.page_size === "number" ? body.page_size : 0,
        {
          cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          cwdEmpty: body.cwd_empty === true,
        },
      );
    case "history.workdirs":
      return client.listHistoryWorkdirs();
    case "history.shared_list":
      return client.listSharedHistory(
        typeof body.page === "number" ? body.page : 0,
        typeof body.page_size === "number" ? body.page_size : 0,
      );
    case "history.get":
      return client.getHistory(String(body.conversation_id ?? ""), {
        maxMessages: typeof body.max_messages === "number" ? body.max_messages : undefined,
      });
    case "history.prefix":
      return client.getHistoryPrefix(
        String(body.conversation_id ?? ""),
        normalizeWorkerHistoryMessageRef(body.base_message_ref),
        {
          maxMessages: typeof body.max_messages === "number" ? body.max_messages : undefined,
        },
      );
    case "history.rename":
      return client.renameHistory(String(body.conversation_id ?? ""), String(body.title ?? ""));
    case "history.pin":
      return client.pinHistory(String(body.conversation_id ?? ""), body.is_pinned === true);
    case "history.share.get":
      return client.getHistoryShare(String(body.conversation_id ?? ""));
    case "history.share.set":
      return client.setHistoryShare(
        String(body.conversation_id ?? ""),
        body.enabled === true,
        typeof body.redact_tool_content === "boolean"
          ? { redactToolContent: body.redact_tool_content }
          : undefined,
      );
    case "history.delete":
      await client.deleteHistory(String(body.conversation_id ?? ""));
      return undefined;
    case "chat_queue.get":
      return client.chatQueueGet(String(body.conversation_id ?? ""));
    case "chat_queue.get_item":
      return client.chatQueueGetItem(
        String(body.conversation_id ?? ""),
        String(body.item_id ?? ""),
      );
    case "chat_queue.run_now":
      return client.chatQueueRunNow(
        String(body.conversation_id ?? ""),
        String(body.item_id ?? ""),
      );
    case "chat_queue.move":
      return client.chatQueueMove(
        String(body.conversation_id ?? ""),
        String(body.item_id ?? ""),
        body.direction === "down" ? "down" : "up",
      );
    case "chat_queue.remove":
      return client.chatQueueRemove(
        String(body.conversation_id ?? ""),
        String(body.item_id ?? ""),
      );
    case "chat_queue.edit_begin":
      return client.chatQueueEditBegin(
        String(body.conversation_id ?? ""),
        String(body.item_id ?? ""),
      );
    case "chat_queue.edit_commit":
      return client.chatQueueEditCommit({
        conversationId: String(body.conversation_id ?? ""),
        itemId: String(body.item_id ?? ""),
        revision: typeof body.revision === "number" ? body.revision : 0,
        draftJson: String(body.draft_json ?? ""),
        uploadedFilesJson: String(body.uploaded_files_json ?? ""),
      });
    case "chat_queue.edit_cancel":
      return client.chatQueueEditCancel(
        String(body.conversation_id ?? ""),
        String(body.item_id ?? ""),
      );
    case "providers.list":
      return client.listProviders();
    case "settings.get":
      return client.getSettings();
    case "settings.update":
      await client.updateSettings(payload as GatewaySettingsSyncUpdatePayload);
      return undefined;
    case "settings.ssh_known_host.reset": {
      const body = (payload && typeof payload === "object" ? payload : {}) as Record<
        string,
        unknown
      >;
      return client.resetSshKnownHost({
        host: String(body.host ?? ""),
        port: typeof body.port === "number" ? body.port : Number(body.port ?? 0),
      });
    }
    case "skills.list":
      return client.listSkillFiles();
    case "skills.manage":
      return client.manageSkill(payload as Record<string, unknown>);
    case "mentions.list":
      return client.listMentionFiles(
        String(body.workdir ?? ""),
        typeof body.max_results === "number" ? body.max_results : undefined,
        typeof body.query === "string" ? body.query : undefined,
      );
    case "skills.read-metadata":
      return client.readSkillMetadata(String(body.path ?? ""));
    case "skills.read-text":
      return client.readSkillText(
        String(body.path ?? ""),
        typeof body.offset === "number" ? body.offset : undefined,
        typeof body.length === "number" ? body.length : undefined,
      );
    case "files.preview":
      return client.readUploadedImagePreview(
        String(body.workdir ?? ""),
        String(body.absolute_path ?? ""),
      );
    case "cron.manage":
      return client.cronManage(payload as CronManagePayload);
    case "memory.manage":
      return client.memoryManage(payload as MemoryManagePayload);
    case "git.status":
    case "git.branches":
    case "git.init":
    case "git.switch_branch":
    case "git.create_branch":
    case "git.diff":
    case "git.log":
    case "git.commit_details":
    case "git.compare_commit_with_remote":
    case "git.commit_diff":
    case "git.stage":
    case "git.stage_all":
    case "git.unstage":
    case "git.unstage_all":
    case "git.discard":
    case "git.discard_all":
    case "git.add_to_gitignore":
    case "git.commit":
    case "git.fetch":
    case "git.pull":
    case "git.set_remote":
    case "git.push":
      return client.gitRequest(
        method.slice("git.".length),
        String(body.workdir ?? ""),
        (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>,
      );
    case "terminal.shell_options":
      return client.terminalShellOptions();
    case "terminal.list":
      return {
        sessions: await client.listTerminals(String(body.project_path_key ?? "")),
      };
    case "terminal.create":
      return client.createTerminal({
        cwd: String(body.cwd ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        shell: typeof body.shell === "string" ? body.shell : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        cols: typeof body.cols === "number" ? body.cols : undefined,
        rows: typeof body.rows === "number" ? body.rows : undefined,
      });
    case "terminal.create_ssh":
      return client.createSshTerminal({
        cwd: String(body.cwd ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        hostId: String(body.ssh_host_id ?? ""),
        title: typeof body.title === "string" ? body.title : undefined,
        cols: typeof body.cols === "number" ? body.cols : undefined,
        rows: typeof body.rows === "number" ? body.rows : undefined,
        sftpEnabled: body.sftp_enabled === true,
      });
    case "terminal.answer_ssh_prompt":
      return client.answerSshTerminalPrompt({
        promptId: String(body.prompt_id ?? ""),
        answer: typeof body.prompt_answer === "string" ? body.prompt_answer : undefined,
        trustHostKey: body.trust_host_key === true,
      });
    case "terminal.cancel_ssh_prompt":
      await client.cancelSshTerminalPrompt(String(body.prompt_id ?? ""));
      return { action: "cancel_ssh_prompt" };
    case "terminal.ssh_latency":
      return client.sshTerminalLatency(
        String(body.session_id ?? ""),
        String(body.project_path_key ?? ""),
      );
    case "terminal.ssh_tabs_list":
      return {
        ssh_tabs: await client.listSshTerminalTabs(String(body.project_path_key ?? "")),
      };
    case "terminal.ssh_tab_open":
      return {
        ssh_tabs: await client.openSshTerminalTab({
          sessionId: String(body.session_id ?? ""),
          kind: body.tab_kind === "sftp" ? "sftp" : "bash",
        }),
      };
    case "terminal.ssh_tab_close":
      return {
        ssh_tabs: await client.closeSshTerminalTab(String(body.tab_id ?? "")),
      };
    case "terminal.rename":
      return {
        session: await client.renameTerminal(
          String(body.session_id ?? ""),
          String(body.title ?? ""),
          String(body.project_path_key ?? ""),
        ),
      };
    case "terminal.close":
      return {
        session: await client.closeTerminal(
          String(body.session_id ?? ""),
          String(body.project_path_key ?? ""),
        ),
      };
    case "terminal.close_project":
      return {
        sessions: await client.closeProjectTerminals(String(body.project_path_key ?? "")),
      };
    case "sftp.list":
      return client.sftpList({
        sessionId: String(body.session_id ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        workdir: String(body.workdir ?? ""),
        side: body.side === "local" ? "local" : "remote",
        path: String(
          body.side === "local" ? (body.local_path ?? "") : (body.remote_path ?? ""),
        ),
      });
    case "sftp.stat":
      return client.sftpStat({
        sessionId: String(body.session_id ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        workdir: String(body.workdir ?? ""),
        side: body.side === "local" ? "local" : "remote",
        path: String(
          body.side === "local" ? (body.local_path ?? "") : (body.remote_path ?? ""),
        ),
      });
    case "sftp.mkdir":
      return client.sftpMkdir({
        sessionId: String(body.session_id ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        workdir: String(body.workdir ?? ""),
        side: body.side === "local" ? "local" : "remote",
        path: String(
          body.side === "local" ? (body.local_path ?? "") : (body.remote_path ?? ""),
        ),
      });
    case "sftp.rename":
      return client.sftpRename({
        sessionId: String(body.session_id ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        workdir: String(body.workdir ?? ""),
        side: body.side === "local" ? "local" : "remote",
        fromPath: String(body.from_path ?? ""),
        toPath: String(body.to_path ?? ""),
      });
    case "sftp.delete":
      return client.sftpDelete({
        sessionId: String(body.session_id ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        workdir: String(body.workdir ?? ""),
        side: body.side === "local" ? "local" : "remote",
        path: String(
          body.side === "local" ? (body.local_path ?? "") : (body.remote_path ?? ""),
        ),
        recursive: body.recursive === true,
      });
    case "sftp.transfer":
      return client.sftpTransfer({
        sessionId: String(body.session_id ?? ""),
        projectPathKey: String(body.project_path_key ?? ""),
        workdir: String(body.workdir ?? ""),
        direction: body.direction === "download" ? "download" : "upload",
        sourcePath: String(body.from_path ?? ""),
        targetPath: String(body.target_path ?? ""),
        recursive: body.recursive === true,
        overwrite: body.overwrite === true,
      });
    case "sftp.cancel":
      await client.sftpCancelTransfer({
        sessionId: String(body.session_id ?? ""),
        transferId: String(body.from_path ?? ""),
      });
      return undefined;
    case "tunnel.list":
      return {
        tunnels: await client.listTunnels(),
      };
    case "tunnel.create": {
      const projectPathKey =
        typeof body.projectPathKey === "string"
          ? body.projectPathKey.trim()
          : typeof body.project_path_key === "string"
            ? body.project_path_key.trim()
            : "";
      return {
        tunnel: await client.createTunnel({
          targetUrl: String(body.targetUrl ?? body.target_url ?? ""),
          ttlSeconds:
            body.ttlSeconds === 0 ||
            body.ttlSeconds === 900 ||
            body.ttlSeconds === 3600 ||
            body.ttlSeconds === 14400
              ? body.ttlSeconds
              : body.ttl_seconds === 0 ||
                  body.ttl_seconds === 900 ||
                  body.ttl_seconds === 3600 ||
                  body.ttl_seconds === 14400
                ? body.ttl_seconds
                : 3600,
          name: typeof body.name === "string" ? body.name : undefined,
          ...(projectPathKey ? { projectPathKey } : {}),
        }),
      };
    }
    case "tunnel.update": {
      const projectPathKey =
        typeof body.projectPathKey === "string"
          ? body.projectPathKey.trim()
          : typeof body.project_path_key === "string"
            ? body.project_path_key.trim()
            : "";
      return {
        tunnel: await client.updateTunnel({
          id: String(body.id ?? body.tunnelId ?? body.tunnel_id ?? body.slug ?? ""),
          targetUrl: String(body.targetUrl ?? body.target_url ?? ""),
          ttlSeconds:
            body.ttlSeconds === 0 ||
            body.ttlSeconds === 900 ||
            body.ttlSeconds === 3600 ||
            body.ttlSeconds === 14400
              ? body.ttlSeconds
              : body.ttl_seconds === 0 ||
                  body.ttl_seconds === 900 ||
                  body.ttl_seconds === 3600 ||
                  body.ttl_seconds === 14400
                ? body.ttl_seconds
                : 3600,
          name: typeof body.name === "string" ? body.name : undefined,
          ...(projectPathKey ? { projectPathKey } : {}),
        }),
      };
    }
    case "tunnel.close":
      return {
        tunnel: await client.closeTunnel(
          String(body.id ?? body.tunnelId ?? body.tunnel_id ?? body.slug ?? ""),
        ),
      };
    case "provider.models":
      return client.getProviderModels(
        String(body.type ?? ""),
        String(body.base_url ?? ""),
        String(body.api_key ?? ""),
      );
    default:
      throw new Error(`Unsupported Gateway SharedWorker method: ${method}`);
  }
}

function terminalPayloadProjectPathKey(payload: unknown) {
  const body = (payload ?? {}) as Record<string, unknown>;
  return typeof body.project_path_key === "string" ? body.project_path_key.trim() : "";
}

function terminalPayloadSessionId(payload: unknown) {
  const body = (payload ?? {}) as Record<string, unknown>;
  return typeof body.session_id === "string" ? body.session_id.trim() : "";
}

function terminalResponseSession(payload: unknown): TerminalSession | null {
  const maybeSnapshot = payload as Partial<TerminalSnapshot> | null | undefined;
  const session = maybeSnapshot?.session;
  return session && typeof session.id === "string" ? session : null;
}

function updatePortTerminalInterest(
  state: PortState,
  method: string,
  requestPayload: unknown,
  responsePayload: unknown,
) {
  if (!method.startsWith("terminal.")) {
    return;
  }

  const requestProjectPathKey = terminalPayloadProjectPathKey(requestPayload);
  const requestSessionId = terminalPayloadSessionId(requestPayload);
  const responseSession = terminalResponseSession(responsePayload);
  const responseProjectPathKey = responseSession?.projectPathKey.trim() ?? "";
  const responseSessionId = responseSession?.id.trim() ?? "";
  const projectPathKey = requestProjectPathKey || responseProjectPathKey;
  const sessionId = requestSessionId || responseSessionId;

  switch (method) {
    case "terminal.list":
      if (!projectPathKey) {
        state.terminalAllProjects = true;
        return;
      }
      state.terminalProjectKeys.add(projectPathKey);
      return;
    case "terminal.create":
    case "terminal.close_project":
      if (projectPathKey) {
        state.terminalProjectKeys.add(projectPathKey);
      }
      return;
    case "terminal.close":
      if (sessionId) {
        state.terminalSessionIds.delete(sessionId);
      }
      return;
  }
}

function respond(
  port: MessagePort,
  connectionID: string,
  requestID: string,
  payload?: unknown,
  error?: string,
) {
  postToPort(port, {
    type: "response",
    connection_id: connectionID,
    request_id: requestID,
    payload,
    error,
  });
}

async function handleRequest(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "request" }>,
) {
  try {
    const payload = await resolveRequest(state.client.client, message.method, message.payload);
    updatePortTerminalInterest(state, message.method, message.payload, payload);
    respond(port, state.connectionID, message.request_id, payload);
  } catch (error) {
    respond(
      port,
      state.connectionID,
      message.request_id,
      undefined,
      asErrorMessage(error, "Gateway SharedWorker request failed"),
    );
  }
}

function handlePortMessage(port: MessagePort, raw: unknown) {
  const message = raw as WorkerClientRequest;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "connect") {
    connectPort(port, message);
    return;
  }
  if (message.type === "dispose") {
    disconnectPort(port);
    port.close();
    return;
  }

  const state = portStates.get(port);
  if (!state || state.connectionID !== message.connection_id) {
    return;
  }
  switch (message.type) {
    case "request":
      void handleRequest(port, state, message);
      return;
    case "wakeup":
      state.client.client.noteForegroundWakeup();
      return;
    case "terminal_stream_attach":
      handleTerminalStreamAttach(port, state, message);
      return;
    case "terminal_stream_write":
      handleTerminalStreamWrite(state, message);
      return;
    case "terminal_stream_resize":
      handleTerminalStreamResize(state, message);
      return;
    case "terminal_stream_detach":
      detachTerminalStreamPage(state, message.stream_id.trim(), message.session_id);
      return;
  }
}

const workerScope = globalThis as unknown as SharedWorkerScope;
workerScope.onconnect = (event) => {
  const port = event.ports[0];
  if (!port) {
    return;
  }
  port.onmessage = (message) => handlePortMessage(port, message.data);
  port.onmessageerror = () => disconnectPort(port);
  port.start();
};
