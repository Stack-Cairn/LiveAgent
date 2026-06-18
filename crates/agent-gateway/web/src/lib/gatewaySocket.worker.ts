import type {
  GatewaySettingsSyncPayload,
  GatewaySettingsSyncUpdatePayload,
} from "@/lib/settings/sync";
import type { TerminalEvent, TerminalSession, TerminalSnapshot } from "@/lib/terminal/types";

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
  terminalSessions: Map<string, TerminalSession>;
};

type PortState = {
  connectionID: string;
  client: ManagedClient;
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
    terminalDetachTimers: new Map(),
    terminalSessions: new Map(),
  };

  managed.client.subscribeStatus((status, error) => {
    managed.status = status;
    managed.statusError = error;
    if (status?.online === false) {
      managed.terminalSessions.clear();
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
  const terminalSessionIds = [...state.terminalSessionIds];
  const terminalProjectKeys = [...state.terminalProjectKeys];
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
