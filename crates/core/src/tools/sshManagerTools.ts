import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { callBackend } from "../backendClient";
import { Type } from "typebox";

import type { SshHostConfig } from "../settings";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";
import {
  createToolRunId,
  invokeWithAbort,
  requestRuntimeCancel,
  throwIfToolInvocationAborted,
} from "./invokeWithAbort";
import { ToolPathResolver } from "./pathUtils";

type SSHManagerAction =
  | "list_hosts"
  | "list_sessions"
  | "create_session"
  | "read_session"
  | "send_input"
  | "resize_session"
  | "close_session"
  | "exec"
  | "sftp_list"
  | "sftp_stat"
  | "sftp_read_text"
  | "sftp_write_text"
  | "sftp_mkdir"
  | "sftp_rename"
  | "sftp_delete"
  | "sftp_upload"
  | "sftp_download"
  | "sftp_transfer_status"
  | "sftp_cancel_transfer";

type RawTerminalSession = {
  id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  cwd?: string;
  shell?: string;
  title?: string;
  kind?: string;
  ssh?: {
    hostId?: string;
    host_id?: string;
    hostName?: string;
    host_name?: string;
    username?: string;
    host?: string;
    port?: number;
    authType?: string;
    auth_type?: string;
    status?: string;
    sftpEnabled?: boolean;
    sftp_enabled?: boolean;
  } | null;
  cols?: number;
  rows?: number;
  createdAt?: number;
  created_at?: number;
  updatedAt?: number;
  updated_at?: number;
  running?: boolean;
};

type RawTerminalListResponse = {
  sessions?: RawTerminalSession[];
};

type RawTerminalSnapshotResponse = {
  session?: RawTerminalSession;
  bytes?: unknown;
  output?: string;
  truncated?: boolean;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
  sshPrompt?: unknown;
  ssh_prompt?: unknown;
};

function normalizeTerminalBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((item) => Number(item) & 0xff));
  }
  if (typeof value === "string" && value.length > 0) {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array();
}

export type SshManagerSessionSummary = {
  session_id: string;
  host_id: string;
  status: string;
  sftpEnabled: boolean;
  title: string;
  running: boolean;
  created_at: number;
  updated_at: number;
};

export type SshManagerSessionChange = {
  action: "create";
  projectPathKey: string;
  session?: SshManagerSessionSummary;
};

type SshSessionStrategy = "reuse_or_create" | "new" | "require_existing";

type ResolvedSshSession = {
  session: SshManagerSessionSummary;
  reused: boolean;
  created: boolean;
  strategy: SshSessionStrategy | "session_id";
};

const SSH_MANAGER_TOOL: Tool = {
  name: "SSHManager",
  description:
    'Manage SSH sessions and remote SFTP files for SSH hosts explicitly associated with the current project. Use host_id from list_hosts. If list_hosts reports credential=saved, LiveAgent already has the configured password/private key/passphrase; do not ask the user to paste credentials into chat, and call create_session, exec, or SFTP actions directly. If list_hosts reports credential=missing, ask the user to configure credentials in Settings > SSH instead of requesting secrets in chat. If list_hosts reports credential=interactive, the host uses keyboard-interactive login: SSHManager never connects such hosts itself — create_session fails, and exec/SFTP only reuse a session the user already opened; if none is running, ask the user to connect in the SSH Tunnel tab first. Default session strategy is reuse_or_create: exec and SFTP reuse the same running session for that host before LiveAgent creates a visible session. To intentionally run multiple SSH sessions, call create_session or set session_strategy="new", then use the returned session_id for follow-up operations. Use session_strategy="require_existing" when you want to fail instead of implicitly creating a session. Do not combine session_id with session_strategy="new". Authentication prompts, unknown host keys, changed host keys, and MFA must be completed by the user in the SSH Tunnel tab before retrying.',
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("list_hosts"),
        Type.Literal("list_sessions"),
        Type.Literal("create_session"),
        Type.Literal("read_session"),
        Type.Literal("send_input"),
        Type.Literal("resize_session"),
        Type.Literal("close_session"),
        Type.Literal("exec"),
        Type.Literal("sftp_list"),
        Type.Literal("sftp_stat"),
        Type.Literal("sftp_read_text"),
        Type.Literal("sftp_write_text"),
        Type.Literal("sftp_mkdir"),
        Type.Literal("sftp_rename"),
        Type.Literal("sftp_delete"),
        Type.Literal("sftp_upload"),
        Type.Literal("sftp_download"),
        Type.Literal("sftp_transfer_status"),
        Type.Literal("sftp_cancel_transfer"),
      ],
      { description: "SSH/SFTP action to perform." },
    ),
    host_id: Type.Optional(
      Type.String({
        description:
          "Authorized SSH host id from list_hosts. Required when no session_id is supplied.",
      }),
    ),
    session_id: Type.Optional(
      Type.String({
        description: "SSH session id from list_sessions or create_session.",
      }),
    ),
    session_strategy: Type.Optional(
      Type.Union(
        [Type.Literal("reuse_or_create"), Type.Literal("new"), Type.Literal("require_existing")],
        {
          description:
            'Session resolution strategy for exec and SFTP actions when session_id is omitted. Defaults to "reuse_or_create". Use "new" only when an additional SSH session is intentional; use "require_existing" to avoid implicit creation.',
        },
      ),
    ),
    title: Type.Optional(Type.String({ description: "Optional title for create_session." })),
    cols: Type.Optional(Type.Number({ description: "PTY columns for create/resize." })),
    rows: Type.Optional(Type.Number({ description: "PTY rows for create/resize." })),
    sftp_enabled: Type.Optional(
      Type.Boolean({
        description: "Whether to enable SFTP for create_session. Defaults to true.",
      }),
    ),
    data: Type.Optional(
      Type.String({
        description: "Raw PTY input for send_input, including newlines/control chars.",
      }),
    ),
    command: Type.Optional(Type.String({ description: "Remote command for exec." })),
    cwd: Type.Optional(Type.String({ description: "Optional remote working directory for exec." })),
    timeout_ms: Type.Optional(Type.Number({ description: "Exec timeout in milliseconds." })),
    max_bytes: Type.Optional(Type.Number({ description: "Maximum captured bytes for output." })),
    path: Type.Optional(Type.String({ description: "Remote SFTP path." })),
    from_path: Type.Optional(Type.String({ description: "Source path for rename." })),
    to_path: Type.Optional(Type.String({ description: "Target path for rename." })),
    content: Type.Optional(Type.String({ description: "Text content for sftp_write_text." })),
    offset: Type.Optional(Type.Number({ description: "Byte offset for sftp_read_text." })),
    limit: Type.Optional(Type.Number({ description: "Byte limit for sftp_read_text." })),
    overwrite: Type.Optional(
      Type.Boolean({ description: "Whether upload/download/write may overwrite existing files." }),
    ),
    recursive: Type.Optional(Type.Boolean({ description: "Recursive directory transfer/delete." })),
    local_path: Type.Optional(
      Type.String({
        description:
          "Local workspace path for upload/download. Accepts workspace-relative paths exactly as returned by file tools, absolute paths inside the workspace, ~/..., or file:// values.",
      }),
    ),
    remote_path: Type.Optional(Type.String({ description: "Remote path for upload/download." })),
    transfer_id: Type.Optional(Type.String({ description: "SFTP transfer id." })),
  }),
};

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function normalizeAction(value: unknown): SSHManagerAction {
  const action = typeof value === "string" ? value.trim() : "";
  const actions = new Set<SSHManagerAction>([
    "list_hosts",
    "list_sessions",
    "create_session",
    "read_session",
    "send_input",
    "resize_session",
    "close_session",
    "exec",
    "sftp_list",
    "sftp_stat",
    "sftp_read_text",
    "sftp_write_text",
    "sftp_mkdir",
    "sftp_rename",
    "sftp_delete",
    "sftp_upload",
    "sftp_download",
    "sftp_transfer_status",
    "sftp_cancel_transfer",
  ]);
  if (actions.has(action as SSHManagerAction)) {
    return action as SSHManagerAction;
  }
  throw new Error("SSHManager.action is invalid.");
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function requireString(args: Record<string, unknown>, key: string) {
  const value = normalizeOptionalString(args[key]);
  if (!value) {
    throw new Error(`SSHManager.${key} is required.`);
  }
  return value;
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeOptionalPositiveInt(value: unknown, min: number, max: number) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeBool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeSessionStrategy(value: unknown): SshSessionStrategy {
  const strategy = typeof value === "string" ? value.trim() : "";
  if (!strategy) return "reuse_or_create";
  if (strategy === "reuse_or_create" || strategy === "new" || strategy === "require_existing") {
    return strategy;
  }
  throw new Error("SSHManager.session_strategy is invalid.");
}

function normalizeSession(input: RawTerminalSession): SshManagerSessionSummary | null {
  if (input.kind !== "ssh" || !input.ssh) return null;
  const sessionId = input.id?.trim() ?? "";
  const hostId = (input.ssh.hostId ?? input.ssh.host_id ?? "").trim();
  if (!sessionId || !hostId) return null;
  return {
    session_id: sessionId,
    host_id: hostId,
    status: input.ssh.status ?? (input.running === true ? "connected" : "disconnected"),
    sftpEnabled: input.ssh.sftpEnabled ?? input.ssh.sftp_enabled ?? false,
    title: input.title ?? "SSH",
    running: input.running === true,
    created_at: input.createdAt ?? input.created_at ?? 0,
    updated_at: input.updatedAt ?? input.updated_at ?? 0,
  };
}

function hostCredentialConfigured(host: SshHostConfig) {
  if (host.authType === "keyboardInteractive") return true;
  if (host.authType === "privateKey") {
    return (
      host.privateKey.trim().length > 0 ||
      host.privateKeyPath.trim().length > 0 ||
      host.privateKeyConfigured === true
    );
  }
  return host.password.trim().length > 0 || host.passwordConfigured === true;
}

function hostSummary(host: SshHostConfig) {
  const credentialConfigured = hostCredentialConfigured(host);
  return {
    host_id: host.id,
    name: host.name,
    endpoint: `${host.username}@${host.host}:${host.port || 22}`,
    username: host.username,
    host: host.host,
    port: host.port || 22,
    authType: host.authType,
    credentialConfigured,
    credentialStatus:
      host.authType === "keyboardInteractive"
        ? "interactive"
        : credentialConfigured
          ? "saved"
          : "missing",
  };
}

function formatHostLine(host: ReturnType<typeof hostSummary>) {
  return `- ${host.host_id} · ${host.name || host.endpoint} · ${host.endpoint} · auth=${host.authType} · credential=${host.credentialStatus}`;
}

function formatSessionLine(session: SshManagerSessionSummary) {
  return `- ${session.session_id} · host=${session.host_id} · ${session.status} · sftp=${session.sftpEnabled ? "true" : "false"} · running=${session.running ? "true" : "false"} · created_at=${session.created_at} · updated_at=${session.updated_at} · ${session.title}`;
}

function promptErrorMessage() {
  return "请先在 SSH 隧道 Tab 手动完成连接/信任/MFA 后重试。";
}

function keyboardInteractiveConnectErrorMessage() {
  return "该主机使用键盘交互登录，SSHManager 不会自行发起连接；请先在 SSH 隧道 Tab 建立连接，再复用运行中的会话。";
}

function okResult(params: {
  toolCall: ToolCall;
  action: SSHManagerAction;
  text: string;
  details?: Record<string, unknown>;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text: params.text }],
    details: {
      kind: "ssh_manager",
      action: params.action,
      ...(params.details ?? {}),
    },
    isError: false,
    timestamp: Date.now(),
  };
}

function errorResult(
  toolCall: ToolCall,
  action: SSHManagerAction,
  message: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: `SSHManager failed: ${message}` }],
    details: {
      kind: "ssh_manager",
      action,
      errors: [message],
    },
    isError: true,
    timestamp: Date.now(),
  };
}

async function listProjectSessions(projectPathKey: string, signal?: AbortSignal) {
  const response = await invokeWithAbort<RawTerminalListResponse>(
    "terminal_list",
    { project_path_key: projectPathKey },
    signal,
  );
  return (response.sessions ?? [])
    .map(normalizeSession)
    .filter((session): session is SshManagerSessionSummary => Boolean(session));
}

function createAllowedHostMap(hosts: SshHostConfig[], associatedHostIds: readonly string[]) {
  const allowedIds = new Set(associatedHostIds.map((id) => id.trim()).filter(Boolean));
  return new Map(
    hosts.filter((host) => allowedIds.has(host.id)).map((host) => [host.id, host] as const),
  );
}

async function validateSession(params: {
  sessionId: string;
  projectPathKey: string;
  allowedHostIds: Set<string>;
  needsSftp?: boolean;
  signal?: AbortSignal;
}) {
  const session = (await listProjectSessions(params.projectPathKey, params.signal)).find(
    (candidate) => candidate.session_id === params.sessionId,
  );
  if (!session) {
    throw new Error("SSH session not found in the current project.");
  }
  if (!params.allowedHostIds.has(session.host_id)) {
    throw new Error("SSH session host is not authorized for the current project.");
  }
  if (params.needsSftp && !session.sftpEnabled) {
    throw new Error(
      "SSH session does not have SFTP enabled. Use host_id to reuse or create an SFTP-enabled session.",
    );
  }
  return session;
}

function findReusableSession(params: {
  sessions: SshManagerSessionSummary[];
  hostId: string;
  needsSftp: boolean;
}) {
  return params.sessions
    .filter((session) => {
      if (session.host_id !== params.hostId || !session.running) return false;
      return !params.needsSftp || session.sftpEnabled;
    })
    .sort((left, right) => {
      const connectedDelta =
        Number(right.status === "connected") - Number(left.status === "connected");
      if (connectedDelta !== 0) return connectedDelta;
      const sftpDelta = Number(right.sftpEnabled) - Number(left.sftpEnabled);
      if (sftpDelta !== 0) return sftpDelta;
      const createdDelta = left.created_at - right.created_at;
      if (createdDelta !== 0) return createdDelta;
      return left.session_id.localeCompare(right.session_id);
    })[0];
}

async function createSession(params: {
  host: SshHostConfig;
  workdir: string;
  projectPathKey: string;
  title?: string;
  cols?: number;
  rows?: number;
  sftpEnabled?: boolean;
  signal?: AbortSignal;
}) {
  const response = await invokeWithAbort<RawTerminalSnapshotResponse>(
    "terminal_create_ssh",
    {
      cwd: params.workdir,
      project_path_key: params.projectPathKey,
      ssh_host_id: params.host.id,
      title: params.title,
      cols: params.cols,
      rows: params.rows,
      sftp_enabled: params.sftpEnabled ?? true,
    },
    params.signal,
  );
  if (response.sshPrompt || response.ssh_prompt) {
    throw new Error(promptErrorMessage());
  }
  if (!response.session) {
    throw new Error("SSH session was not created.");
  }
  const session = normalizeSession(response.session);
  if (!session) {
    throw new Error("SSH create response did not include an SSH session.");
  }
  return session;
}

async function resolveSession(params: {
  args: Record<string, unknown>;
  workdir: string;
  projectPathKey: string;
  allowedHosts: Map<string, SshHostConfig>;
  allowedHostIds: Set<string>;
  needsSftp?: boolean;
  onNewConnectionStarted?: () => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<ResolvedSshSession> {
  const sessionId = normalizeOptionalString(params.args.session_id);
  const strategy = normalizeSessionStrategy(params.args.session_strategy);
  if (sessionId) {
    if (strategy === "new") {
      throw new Error("SSHManager.session_strategy=new cannot be combined with session_id.");
    }
    const session = await validateSession({
      sessionId,
      projectPathKey: params.projectPathKey,
      allowedHostIds: params.allowedHostIds,
      needsSftp: params.needsSftp === true,
      signal: params.signal,
    });
    return { session, reused: true, created: false, strategy: "session_id" };
  }
  const hostId = requireString(params.args, "host_id");
  const host = params.allowedHosts.get(hostId);
  if (!host) {
    throw new Error("SSH host is not associated with the current project.");
  }
  if (strategy !== "new") {
    const reusable = findReusableSession({
      sessions: await listProjectSessions(params.projectPathKey, params.signal),
      hostId,
      needsSftp: params.needsSftp === true,
    });
    if (reusable) {
      return { session: reusable, reused: true, created: false, strategy };
    }
    if (strategy === "require_existing") {
      throw new Error("No reusable SSH session exists for this host in the current project.");
    }
  }
  // Keyboard-interactive login needs the user to answer server prompts, which
  // the tool path cannot do: never dial such hosts, only reuse sessions the
  // user already opened in the SSH Tunnel tab (handled above).
  if (host.authType === "keyboardInteractive") {
    throw new Error(keyboardInteractiveConnectErrorMessage());
  }
  await params.onNewConnectionStarted?.();
  throwIfToolInvocationAborted(params.signal);
  const session = await createSession({
    host,
    workdir: params.workdir,
    projectPathKey: params.projectPathKey,
    title:
      normalizeOptionalString(params.args.title) ||
      `SSHManager: ${host.name || host.host || host.id}`,
    sftpEnabled: true,
    signal: params.signal,
  });
  return { session, reused: false, created: true, strategy };
}

async function executeSSHManager(
  toolCall: ToolCall,
  params: {
    workdir: string;
    projectPathKey: string;
    hosts: SshHostConfig[];
    associatedHostIds: string[];
    pathResolver: ToolPathResolver;
    onSshSessionsChanged?: (change: SshManagerSessionChange) => void | Promise<void>;
  },
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  const args = asArgs(toolCall.arguments);
  const invokeTool = <T = unknown>(command: string, input: Record<string, unknown>) =>
    invokeWithAbort<T>(command, input, signal);
  let action: SSHManagerAction = "list_hosts";
  try {
    const resolveLocalTransferPath = async (
      input: unknown,
      intent: "read" | "write",
      label: string,
    ) => {
      const resolved = await params.pathResolver.resolvePath(input, {
        label,
        intent,
        required: true,
      });
      throwIfToolInvocationAborted(signal);
      if (resolved.scope !== "workspace") {
        throw new Error(
          `${label} must resolve inside the workspace (workspace root: ${params.workdir}). Got: ${String(input)}. Use a workspace-relative path.`,
        );
      }
      return resolved.relativePath ?? "";
    };

    if (signal?.aborted) {
      return errorResult(toolCall, action, "Cancelled");
    }
    action = normalizeAction(args.action);
    const allowedHosts = createAllowedHostMap(params.hosts, params.associatedHostIds);
    const allowedHostIds = new Set(allowedHosts.keys());
    if (!params.projectPathKey.trim()) {
      throw new Error("No current project is selected.");
    }
    if (allowedHosts.size === 0) {
      throw new Error("No SSH hosts are associated with the current project.");
    }

    if (action === "list_hosts") {
      const hosts = Array.from(allowedHosts.values()).map(hostSummary);
      return okResult({
        toolCall,
        action,
        text: hosts.length
          ? [
              "Authorized SSH hosts:",
              "credential=saved means LiveAgent already has the configured SSH credential; use create_session directly and do not ask the user for that password/key.",
              "credential=interactive means the host logs in via keyboard-interactive prompts: SSHManager will not connect it itself; ask the user to open the session in the SSH Tunnel tab, then reuse the running session for exec and SFTP.",
              ...hosts.map(formatHostLine),
            ].join("\n")
          : "No authorized SSH hosts.",
        details: { hosts },
      });
    }

    if (action === "list_sessions") {
      const hostId = normalizeOptionalString(args.host_id);
      if (hostId && !allowedHostIds.has(hostId)) {
        throw new Error("SSH host is not associated with the current project.");
      }
      const sessions = (await listProjectSessions(params.projectPathKey, signal)).filter(
        (session) => allowedHostIds.has(session.host_id) && (!hostId || session.host_id === hostId),
      );
      return okResult({
        toolCall,
        action,
        text: sessions.length
          ? ["Project SSH sessions:", ...sessions.map(formatSessionLine)].join("\n")
          : "No SSH sessions are open for the current project.",
        details: { sessions },
      });
    }

    if (action === "create_session") {
      const hostId = requireString(args, "host_id");
      const host = allowedHosts.get(hostId);
      if (!host) {
        throw new Error("SSH host is not associated with the current project.");
      }
      if (host.authType === "keyboardInteractive") {
        throw new Error(keyboardInteractiveConnectErrorMessage());
      }
      const title = normalizeOptionalString(args.title) || undefined;
      const cols = normalizeOptionalPositiveInt(args.cols, 20, 400);
      const rows = normalizeOptionalPositiveInt(args.rows, 6, 200);
      const sftpEnabled = normalizeBool(args.sftp_enabled, true);
      await params.onSshSessionsChanged?.({
        action: "create",
        projectPathKey: params.projectPathKey,
      });
      const session = await createSession({
        host,
        workdir: params.workdir,
        projectPathKey: params.projectPathKey,
        title,
        cols,
        rows,
        sftpEnabled,
        signal,
      });
      return okResult({
        toolCall,
        action,
        text: ["Created SSH session:", formatSessionLine(session)].join("\n"),
        details: {
          session,
          session_strategy: "new",
          session_reused: false,
          session_created: true,
        },
      });
    }

    if (action === "read_session") {
      const session = await validateSession({
        sessionId: requireString(args, "session_id"),
        projectPathKey: params.projectPathKey,
        allowedHostIds,
        signal,
      });
      const response = await invokeTool<RawTerminalSnapshotResponse>("terminal_stream_attach", {
        session_id: session.session_id,
        max_bytes: normalizePositiveInt(args.max_bytes, 32 * 1024, 4 * 1024, 128 * 1024),
      });
      const output =
        typeof response.output === "string"
          ? response.output
          : new TextDecoder().decode(normalizeTerminalBytes(response.bytes));
      return okResult({
        toolCall,
        action,
        text: [
          `session_id: ${session.session_id}`,
          `host_id: ${session.host_id}`,
          `truncated: ${response.truncated === true ? "true" : "false"}`,
          "",
          output || "(empty output)",
        ].join("\n"),
        details: {
          session,
          output,
          truncated: response.truncated === true,
        },
      });
    }

    if (action === "send_input") {
      const session = await validateSession({
        sessionId: requireString(args, "session_id"),
        projectPathKey: params.projectPathKey,
        allowedHostIds,
        signal,
      });
      const data = typeof args.data === "string" ? args.data : "";
      if (data.length === 0) {
        throw new Error("SSHManager.data is required.");
      }
      await invokeTool("terminal_stream_input", {
        session_id: session.session_id,
        bytes: Array.from(new TextEncoder().encode(data)),
      });
      return okResult({
        toolCall,
        action,
        text: `Sent ${data.length} characters to SSH session ${session.session_id}.`,
        details: { session, bytes: data.length },
      });
    }

    if (action === "resize_session") {
      const session = await validateSession({
        sessionId: requireString(args, "session_id"),
        projectPathKey: params.projectPathKey,
        allowedHostIds,
        signal,
      });
      const cols = normalizePositiveInt(args.cols, 80, 20, 400);
      const rows = normalizePositiveInt(args.rows, 24, 6, 200);
      await invokeTool("terminal_stream_resize", { session_id: session.session_id, cols, rows });
      return okResult({
        toolCall,
        action,
        text: `Resized SSH session ${session.session_id} to ${cols}x${rows}.`,
        details: { session, cols, rows },
      });
    }

    if (action === "close_session") {
      const session = await validateSession({
        sessionId: requireString(args, "session_id"),
        projectPathKey: params.projectPathKey,
        allowedHostIds,
        signal,
      });
      await invokeTool("terminal_close", { session_id: session.session_id });
      return okResult({
        toolCall,
        action,
        text: `Closed SSH session ${session.session_id}.`,
        details: { session },
      });
    }

    if (action === "exec") {
      const resolvedSession = await resolveSession({
        args,
        workdir: params.workdir,
        projectPathKey: params.projectPathKey,
        allowedHosts,
        allowedHostIds,
        onNewConnectionStarted: () =>
          params.onSshSessionsChanged?.({
            action: "create",
            projectPathKey: params.projectPathKey,
          }),
        signal,
      });
      const { session } = resolvedSession;
      const command = requireString(args, "command");
      const runId = createToolRunId("ssh-exec", toolCall.id);
      const result = await invokeWithAbort<Record<string, unknown>>(
        "terminal_ssh_exec",
        {
          session_id: session.session_id,
          command,
          cwd: normalizeOptionalString(args.cwd) || undefined,
          timeout_ms: normalizeOptionalPositiveInt(args.timeout_ms, 1_000, 300_000),
          max_bytes: normalizeOptionalPositiveInt(args.max_bytes, 4 * 1024, 256 * 1024),
          run_id: runId,
        },
        signal,
        { onAbort: () => requestRuntimeCancel(runId) },
      );
      return okResult({
        toolCall,
        action,
        text: [
          `session_id: ${session.session_id}`,
          `session_strategy: ${resolvedSession.strategy}`,
          `session_reused: ${resolvedSession.reused ? "true" : "false"}`,
          `session_created: ${resolvedSession.created ? "true" : "false"}`,
          `exit_code: ${result.exitCode ?? result.exit_code ?? "unknown"}`,
          `timed_out: ${result.timedOut === true || result.timed_out === true ? "true" : "false"}`,
          "",
          "stdout:",
          String(result.stdout ?? "") || "(empty)",
          "",
          "stderr:",
          String(result.stderr ?? "") || "(empty)",
        ].join("\n"),
        details: {
          session,
          session_strategy: resolvedSession.strategy,
          session_reused: resolvedSession.reused,
          session_created: resolvedSession.created,
          result,
        },
      });
    }

    if (action === "sftp_transfer_status") {
      const session = await validateSession({
        sessionId: requireString(args, "session_id"),
        projectPathKey: params.projectPathKey,
        allowedHostIds,
        signal,
      });
      const result = await invokeTool("sftp_transfer_status", {
        session_id: session.session_id,
        transfer_id: requireString(args, "transfer_id"),
      });
      return okResult({
        toolCall,
        action,
        text: JSON.stringify(result, null, 2),
        details: { session, result },
      });
    }

    if (action === "sftp_cancel_transfer") {
      const session = await validateSession({
        sessionId: requireString(args, "session_id"),
        projectPathKey: params.projectPathKey,
        allowedHostIds,
        signal,
      });
      const transferId = requireString(args, "transfer_id");
      await invokeTool("sftp_cancel_transfer", {
        session_id: session.session_id,
        transfer_id: transferId,
      });
      return okResult({
        toolCall,
        action,
        text: `Cancelled SFTP transfer ${transferId}.`,
        details: { session, transfer_id: transferId },
      });
    }

    const resolvedSession = await resolveSession({
      args,
      workdir: params.workdir,
      projectPathKey: params.projectPathKey,
      allowedHosts,
      allowedHostIds,
      needsSftp: true,
      onNewConnectionStarted: () =>
        params.onSshSessionsChanged?.({
          action: "create",
          projectPathKey: params.projectPathKey,
        }),
      signal,
    });
    const { session } = resolvedSession;

    if (action === "sftp_list" || action === "sftp_stat") {
      const command = action === "sftp_list" ? "sftp_list" : "sftp_stat";
      const result = await invokeTool(command, {
        session_id: session.session_id,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: "remote",
        path: normalizeOptionalString(args.path) || undefined,
      });
      return okResult({
        toolCall,
        action,
        text: JSON.stringify(result, null, 2),
        details: {
          session,
          session_strategy: resolvedSession.strategy,
          session_reused: resolvedSession.reused,
          session_created: resolvedSession.created,
          result,
        },
      });
    }

    if (action === "sftp_mkdir" || action === "sftp_delete") {
      const command = action === "sftp_mkdir" ? "sftp_mkdir" : "sftp_delete";
      const result = await invokeTool(command, {
        session_id: session.session_id,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: "remote",
        path: requireString(args, "path"),
        ...(action === "sftp_delete" ? { recursive: normalizeBool(args.recursive, false) } : {}),
      });
      return okResult({
        toolCall,
        action,
        text: JSON.stringify(result, null, 2),
        details: {
          session,
          session_strategy: resolvedSession.strategy,
          session_reused: resolvedSession.reused,
          session_created: resolvedSession.created,
          result,
        },
      });
    }

    if (action === "sftp_rename") {
      const result = await invokeTool("sftp_rename", {
        session_id: session.session_id,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: "remote",
        from_path: requireString(args, "from_path"),
        to_path: requireString(args, "to_path"),
      });
      return okResult({
        toolCall,
        action,
        text: JSON.stringify(result, null, 2),
        details: {
          session,
          session_strategy: resolvedSession.strategy,
          session_reused: resolvedSession.reused,
          session_created: resolvedSession.created,
          result,
        },
      });
    }

    if (action === "sftp_upload" || action === "sftp_download") {
      const direction = action === "sftp_upload" ? "upload" : "download";
      const localPath =
        direction === "upload"
          ? await resolveLocalTransferPath(args.local_path, "read", "SSHManager.local_path")
          : await resolveLocalTransferPath(args.local_path, "write", "SSHManager.local_path");
      const remotePath = requireString(args, "remote_path");
      const cancelTransferById = (transferId: string) => {
        void callBackend<void>("sftp_cancel_transfer", {
          session_id: session.session_id,
          transfer_id: transferId,
        }).catch(() => undefined);
      };
      const result = await invokeWithAbort<{ transfer?: { id?: string } }>(
        "sftp_transfer",
        {
          session_id: session.session_id,
          project_path_key: params.projectPathKey,
          workdir: params.workdir,
          direction,
          source_path: direction === "upload" ? localPath : remotePath,
          target_path: direction === "upload" ? remotePath : localPath,
          recursive: normalizeBool(args.recursive, false),
          overwrite: normalizeBool(args.overwrite, false),
        },
        signal,
        {
          // An abort during the start call releases the caller before the
          // transfer id is known; cancel it as soon as the late result
          // surfaces the id — the Rust-side transfer keeps running otherwise.
          onLateResult: (lateResult) => {
            const lateTransferId = lateResult?.transfer?.id?.trim();
            if (lateTransferId) cancelTransferById(lateTransferId);
          },
        },
      );
      const transferId = result.transfer?.id?.trim() ?? "";
      if (signal?.aborted && transferId) {
        cancelTransferById(transferId);
      }
      return okResult({
        toolCall,
        action,
        text: JSON.stringify(result, null, 2),
        details: {
          session,
          session_strategy: resolvedSession.strategy,
          session_reused: resolvedSession.reused,
          session_created: resolvedSession.created,
          result,
        },
      });
    }

    if (action === "sftp_read_text") {
      const result = await invokeTool("sftp_read_text", {
        session_id: session.session_id,
        project_path_key: params.projectPathKey,
        path: requireString(args, "path"),
        offset: normalizeOptionalPositiveInt(args.offset, 0, Number.MAX_SAFE_INTEGER),
        max_bytes: normalizeOptionalPositiveInt(
          args.limit ?? args.max_bytes,
          4 * 1024,
          1024 * 1024,
        ),
      });
      return okResult({
        toolCall,
        action,
        text: JSON.stringify(result, null, 2),
        details: {
          session,
          session_strategy: resolvedSession.strategy,
          session_reused: resolvedSession.reused,
          session_created: resolvedSession.created,
          result,
        },
      });
    }

    if (action === "sftp_write_text") {
      const result = await invokeTool("sftp_write_text", {
        session_id: session.session_id,
        project_path_key: params.projectPathKey,
        path: requireString(args, "path"),
        content: typeof args.content === "string" ? args.content : "",
        overwrite: normalizeBool(args.overwrite, true),
        create_parent_dirs: true,
      });
      return okResult({
        toolCall,
        action,
        text: JSON.stringify(result, null, 2),
        details: {
          session,
          session_strategy: resolvedSession.strategy,
          session_reused: resolvedSession.reused,
          session_created: resolvedSession.created,
          result,
        },
      });
    }

    throw new Error("Unsupported SSHManager action.");
  } catch (err) {
    return errorResult(toolCall, action, asErrorMessage(err));
  }
}

export function createSSHManagerTools(params: {
  enabled: boolean;
  runtimeScope: "chat" | "cron_auto_prompt";
  workdir: string;
  projectPathKey?: string;
  hosts?: SshHostConfig[];
  associatedHostIds?: string[];
  resolveHomeDir?: () => Promise<string>;
  onSshSessionsChanged?: (change: SshManagerSessionChange) => void | Promise<void>;
}): BuiltinToolBundle {
  const projectPathKey = params.projectPathKey?.trim() || params.workdir.trim();
  const hosts = params.hosts ?? [];
  const associatedHostIds = params.associatedHostIds ?? [];
  const pathResolver = new ToolPathResolver({
    workdir: params.workdir,
    resolveHomeDir: params.resolveHomeDir,
  });
  const tools =
    params.enabled &&
    params.runtimeScope === "chat" &&
    projectPathKey.trim() &&
    associatedHostIds.length > 0
      ? [SSH_MANAGER_TOOL]
      : [];

  return {
    groupId: "system",
    tools,
    executeToolCall: (toolCall, signal) =>
      executeSSHManager(
        toolCall,
        {
          workdir: params.workdir,
          projectPathKey,
          hosts,
          associatedHostIds,
          pathResolver,
          onSshSessionsChanged: params.onSshSessionsChanged,
        },
        signal,
      ),
    metadataByName: createBuiltinMetadataMap(
      tools.map((tool) => [
        tool.name,
        {
          groupId: "system" as const,
          kind: "ssh_manager",
          isReadOnly: false,
          displayCategory: "terminal" as const,
        },
      ]),
    ),
  };
}
