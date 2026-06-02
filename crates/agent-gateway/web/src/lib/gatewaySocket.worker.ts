import type { GatewaySettingsSyncPayload } from "@/lib/settings/sync";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import type { TerminalEvent, TerminalSession, TerminalSnapshot } from "@/lib/terminal/types";

import { GatewayWebSocketClient } from "./gatewaySocket";
import type {
  AgentStatus,
  CronManagePayload,
  GatewayChatRuntimeControls,
  GatewaySelectedModel,
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
      type: "chat.start";
      connection_id: string;
      request_id: string;
      stream_id: string;
      payload: {
        message: string;
        conversation_id?: string;
        client_request_id?: string;
        selected_model?: GatewaySelectedModel;
        runtime_controls?: GatewayChatRuntimeControls;
        system_settings?: {
          executionMode?: string;
          workdir?: string;
          selectedSystemTools?: string[];
        };
        uploaded_files?: PendingUploadedFile[];
      };
    }
  | {
      type: "chat.cancel";
      connection_id: string;
      stream_id: string;
      conversation_id?: string;
    }
  | {
      type: "chat.attach";
      connection_id: string;
      request_id: string;
      stream_id: string;
      conversation_id: string;
      after_seq?: number;
    }
  | {
      type: "chat.detach";
      connection_id: string;
      stream_id: string;
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
  terminalDetachTimers: Map<string, ReturnType<typeof setTimeout>>;
};

type PortState = {
  connectionID: string;
  client: ManagedClient;
  streams: Map<string, AbortController>;
  terminalAllProjects: boolean;
  terminalProjectKeys: Set<string>;
  terminalSessionIds: Set<string>;
};

type SharedWorkerScope = {
  onconnect: ((event: MessageEvent & { ports: MessagePort[] }) => void) | null;
};

const clients = new Map<string, ManagedClient>();
const portStates = new Map<MessagePort, PortState>();
const TERMINAL_DETACH_GRACE_MS = 250;

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
  const sessionID = event.sessionId.trim();
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

function terminalDetachKey(sessionID: string, projectPathKey: string) {
  if (sessionID) {
    return `session:${sessionID}`;
  }
  if (projectPathKey) {
    return `project:${projectPathKey}`;
  }
  return "";
}

function clearPendingTerminalDetach(
  client: ManagedClient,
  sessionID: string,
  projectPathKey: string,
) {
  const key = terminalDetachKey(sessionID, projectPathKey);
  if (!key) return;
  const timer = client.terminalDetachTimers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    client.terminalDetachTimers.delete(key);
  }
}

function hasPortTerminalInterest(client: ManagedClient, sessionID: string, projectPathKey: string) {
  for (const port of [...client.ports]) {
    const state = portStates.get(port);
    if (!state || state.client !== client) {
      client.ports.delete(port);
      continue;
    }
    if (sessionID && state.terminalSessionIds.has(sessionID)) {
      return true;
    }
    if (!sessionID && projectPathKey) {
      if (state.terminalAllProjects || state.terminalProjectKeys.has(projectPathKey)) {
        return true;
      }
    }
  }
  return false;
}

function scheduleTerminalDetach(client: ManagedClient, sessionID: string, projectPathKey: string) {
  const key = terminalDetachKey(sessionID, projectPathKey);
  if (!key || hasPortTerminalInterest(client, sessionID, projectPathKey)) {
    return;
  }
  clearPendingTerminalDetach(client, sessionID, projectPathKey);
  const timer = setTimeout(() => {
    client.terminalDetachTimers.delete(key);
    if (hasPortTerminalInterest(client, sessionID, projectPathKey)) {
      return;
    }
    void client.client.detachTerminal(sessionID, projectPathKey).catch(() => undefined);
  }, TERMINAL_DETACH_GRACE_MS);
  client.terminalDetachTimers.set(key, timer);
}

function forgetPortTerminalInterest(state: PortState, sessionID: string, projectPathKey: string) {
  if (sessionID) {
    state.terminalSessionIds.delete(sessionID);
  } else if (projectPathKey) {
    state.terminalProjectKeys.delete(projectPathKey);
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

function scheduleManagedClientCleanup(client: ManagedClient) {
  if (client.ports.size > 0 || client.idleTimer !== null) {
    return;
  }
  client.idleTimer = setTimeout(() => {
    client.idleTimer = null;
    if (client.ports.size > 0) {
      return;
    }
    for (const timer of client.terminalDetachTimers.values()) {
      clearTimeout(timer);
    }
    client.terminalDetachTimers.clear();
    client.client.dispose();
    clients.delete(client.token);
  }, 60_000);
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
    terminalDetachTimers: new Map(),
  };

  managed.client.subscribeStatus((status, error) => {
    managed.status = status;
    managed.statusError = error;
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
  managed.client.subscribeConversation((event) => {
    broadcast(managed, {
      type: "event",
      event_type: "conversation",
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
    broadcastTerminal(managed, event);
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
  portStates.set(port, {
    connectionID: message.connection_id,
    client,
    streams: new Map(),
    terminalAllProjects: false,
    terminalProjectKeys: new Set(),
    terminalSessionIds: new Set(),
  });
  postToPort(port, {
    type: "ready",
    connection_id: message.connection_id,
    payload: {
      status: client.status,
      error: client.statusError,
    },
  });
}

function disconnectPort(port: MessagePort) {
  const state = portStates.get(port);
  if (!state) {
    return;
  }
  const terminalSessionIds = [...state.terminalSessionIds];
  const terminalProjectKeys = [...state.terminalProjectKeys];
  for (const controller of state.streams.values()) {
    controller.abort();
  }
  state.streams.clear();
  state.client.ports.delete(port);
  portStates.delete(port);
  for (const sessionID of terminalSessionIds) {
    scheduleTerminalDetach(state.client, sessionID, "");
  }
  if (!state.terminalAllProjects) {
    for (const projectPathKey of terminalProjectKeys) {
      scheduleTerminalDetach(state.client, "", projectPathKey);
    }
  }
  scheduleManagedClientCleanup(state.client);
}

async function resolveRequest(client: GatewayWebSocketClient, method: string, payload: unknown) {
  const body = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case "status.get":
      return client.getStatus();
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
    case "history.truncate":
      return client.truncateHistory(
        String(body.conversation_id ?? ""),
        {
          segmentIndex: typeof body.segment_index === "number" ? body.segment_index : 0,
          messageIndex: typeof body.message_index === "number" ? body.message_index : 0,
        } satisfies HistoryMessageRef,
        { omitMessagesJson: body.omit_messages_json === true },
      );
    case "providers.list":
      return client.listProviders();
    case "settings.get":
      return client.getSettings();
    case "settings.update":
      await client.updateSettings(payload as GatewaySettingsSyncPayload);
      return undefined;
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
    case "terminal.attach":
      return client.snapshotTerminal(
        String(body.session_id ?? ""),
        typeof body.max_bytes === "number" ? body.max_bytes : undefined,
        String(body.project_path_key ?? ""),
      );
    case "terminal.input":
      await client.inputTerminal(
        String(body.session_id ?? ""),
        String(body.data ?? ""),
        String(body.project_path_key ?? ""),
      );
      return undefined;
    case "terminal.resize":
      await client.resizeTerminal(
        String(body.session_id ?? ""),
        typeof body.cols === "number" ? body.cols : 80,
        typeof body.rows === "number" ? body.rows : 24,
        String(body.project_path_key ?? ""),
      );
      return undefined;
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
    case "terminal.detach":
      await client.detachTerminal(
        String(body.session_id ?? ""),
        String(body.project_path_key ?? ""),
      );
      return undefined;
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
    case "terminal.attach":
      if (projectPathKey) {
        state.terminalProjectKeys.add(projectPathKey);
      }
      if (sessionId) {
        state.terminalSessionIds.add(sessionId);
      }
      return;
    case "terminal.detach":
      if (sessionId) {
        state.terminalSessionIds.delete(sessionId);
      } else if (projectPathKey) {
        state.terminalProjectKeys.delete(projectPathKey);
      }
      return;
    case "terminal.close":
      if (sessionId) {
        state.terminalSessionIds.delete(sessionId);
      }
      return;
  }
}

function primePortTerminalInterestForRequest(
  state: PortState,
  method: string,
  requestPayload: unknown,
) {
  if (method !== "terminal.attach") {
    return;
  }
  const sessionId = terminalPayloadSessionId(requestPayload);
  const projectPathKey = terminalPayloadProjectPathKey(requestPayload);
  if (sessionId) {
    state.terminalSessionIds.add(sessionId);
  }
  if (projectPathKey) {
    state.terminalProjectKeys.add(projectPathKey);
  }
  clearPendingTerminalDetach(state.client, sessionId, projectPathKey);
}

function handleTerminalDetachRequest(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "request" }>,
) {
  const sessionId = terminalPayloadSessionId(message.payload);
  const projectPathKey = terminalPayloadProjectPathKey(message.payload);
  forgetPortTerminalInterest(state, sessionId, projectPathKey);
  scheduleTerminalDetach(state.client, sessionId, projectPathKey);
  respond(port, state.connectionID, message.request_id, { action: "detach" });
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
    if (message.method === "terminal.detach") {
      handleTerminalDetachRequest(port, state, message);
      return;
    }
    primePortTerminalInterestForRequest(state, message.method, message.payload);
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

function handleChatStart(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.start" }>,
) {
  const controller = new AbortController();
  state.streams.set(message.stream_id, controller);
  respond(port, state.connectionID, message.request_id, { ok: true });

  void (async () => {
    try {
      const stream = state.client.client.chat(
        message.payload.message,
        message.payload.conversation_id,
        message.payload.selected_model,
        message.payload.system_settings,
        controller.signal,
        message.payload.uploaded_files,
        message.payload.client_request_id,
        message.payload.runtime_controls,
      );
      for await (const event of stream) {
        postToPort(port, {
          type: "chat-event",
          connection_id: state.connectionID,
          stream_id: message.stream_id,
          payload: event,
        });
      }
      postToPort(port, {
        type: "chat-closed",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
      });
    } catch (error) {
      postToPort(port, {
        type: "chat-error",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
        error: asErrorMessage(error, "Gateway SharedWorker chat stream failed"),
      });
    } finally {
      state.streams.delete(message.stream_id);
    }
  })();
}

function handleChatAttach(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.attach" }>,
) {
  const controller = new AbortController();
  state.streams.set(message.stream_id, controller);
  respond(port, state.connectionID, message.request_id, { ok: true });

  void (async () => {
    try {
      const stream = state.client.client.attachChat(message.conversation_id, {
        afterSeq: message.after_seq,
        signal: controller.signal,
      });
      for await (const event of stream) {
        postToPort(port, {
          type: "chat-event",
          connection_id: state.connectionID,
          stream_id: message.stream_id,
          payload: event,
        });
      }
      postToPort(port, {
        type: "chat-closed",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
      });
    } catch (error) {
      postToPort(port, {
        type: "chat-error",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
        error: asErrorMessage(error, "Gateway SharedWorker chat attach failed"),
      });
    } finally {
      state.streams.delete(message.stream_id);
    }
  })();
}

function handleChatCancel(
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.cancel" }>,
) {
  const controller = state.streams.get(message.stream_id);
  controller?.abort();
  state.streams.delete(message.stream_id);
  const conversationID = message.conversation_id?.trim();
  if (conversationID) {
    void state.client.client.cancelChat(conversationID).catch(() => undefined);
  }
}

function handleChatDetach(
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.detach" }>,
) {
  const controller = state.streams.get(message.stream_id);
  controller?.abort();
  state.streams.delete(message.stream_id);
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
    case "chat.start":
      handleChatStart(port, state, message);
      return;
    case "chat.cancel":
      handleChatCancel(state, message);
      return;
    case "chat.attach":
      handleChatAttach(port, state, message);
      return;
    case "chat.detach":
      handleChatDetach(state, message);
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
