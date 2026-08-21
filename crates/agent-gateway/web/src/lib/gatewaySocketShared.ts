import { buildHistoryMessageRefPayload } from "@liveagent/ui/lib/chat/historyMessageRef";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { GatewaySettingsSyncPayload } from "@liveagent/ui/lib/settings/sync";
import type { SftpTransferEvent } from "@liveagent/ui/lib/sftp/types";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { errorMessageWithFallback as asErrorMessage } from "@liveagent/ui/lib/shared/value";
import {
  normalizeTerminalByteContainer,
  type RawSshTerminalTabsSnapshot,
  type RawTerminalSession,
  type RawTerminalShellOptionsResponse,
  type RawTerminalSnapshot,
  type RawTerminalSshLatency,
  type RawTerminalEvent as SharedRawTerminalEvent,
} from "@liveagent/ui/lib/terminal/normalization";
import type {
  RawSshLocalForwardAction,
  RawSshLocalForwardEvent,
  RawSshLocalForwardSnapshot,
} from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import type { TerminalEvent, TerminalSession } from "@liveagent/ui/lib/terminal/types";
import type {
  TunnelHealth,
  TunnelStateSnapshot,
  TunnelStatus,
} from "@liveagent/ui/lib/tunnels/constants";
import type {
  WorkspaceActivity,
  WorkspaceActivityEventPayload,
} from "@liveagent/ui/lib/workspace-activity/types";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { ChatCommandUpdate, ConversationActivityEvent } from "@/lib/chat/stream/streamTypes";
import type {
  AgentStatus,
  ChatQueueResponse,
  ChatQueueSnapshot,
  GatewayChatRuntimeControls,
  GatewayHistoryEvent,
  GatewaySelectedModel,
  MemoryManagePayload,
} from "./gatewayTypes";

export type StatusListener = (status: AgentStatus | null, error: string | null) => void;
export type HistoryListener = (event: GatewayHistoryEvent) => void;
export type SettingsListener = (event: GatewaySettingsSyncPayload) => void;
export type GatewaySettingsUpdateResponse = {
  accepted?: boolean;
  message?: string;
};
export type TerminalListener = (event: TerminalEvent) => void;
export type SftpTransferListener = (event: SftpTransferEvent) => void;
export type ChatQueueListener = (snapshot: ChatQueueSnapshot) => void;
export type ChatActivityListener = (event: ConversationActivityEvent) => void;
export type ChatCommandUpdateListener = (update: ChatCommandUpdate) => void;
export type WorkspaceActivityListener = (event: WorkspaceActivityEventPayload) => void;

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

export type GatewayRequestOptions = {
  timeoutMs?: number;
};

export type GatewayChatSystemSettings = {
  executionMode?: string;
  workdir?: string;
  commandSafetyMode?: string;
};

export type GatewayChatCommandInput = {
  type: "chat.submit" | "chat.edit_resend";
  message: string;
  conversationId?: string;
  selectedModel?: GatewaySelectedModel;
  systemSettings?: GatewayChatSystemSettings;
  signal?: AbortSignal;
  uploadedFiles?: PendingUploadedFile[];
  clientRequestId?: string;
  runtimeControls?: GatewayChatRuntimeControls;
  baseMessageRef?: HistoryMessageRef;
  queuePolicy?: "auto" | "append" | "interrupt";
};

export type SkillListResponse = {
  rootDir: string;
  paths: string[];
  truncated: boolean;
};

export type SshKnownHostResetResult = {
  deleted: number;
};

export type MentionListResponse = {
  entries: Array<{ path: string; kind: "file" | "dir"; hidden: boolean }>;
  truncated: boolean;
};

export type FsRoot = {
  id: string;
  path: string;
  kind: "home" | "root" | "drive";
  label: string;
};

export type FsRootsResponse = {
  roots: FsRoot[];
};

export type GatewayWorkspaceRootGrant = {
  id: string;
  projectId: string;
  projectPathKey: string;
  alias: string;
  displayPath: string;
  canonicalPath: string;
  access: "read" | "write";
  state: "active" | "missing" | "changed";
  createdAt: number;
  updatedAt: number;
};

export type GatewayWorkspaceRootGrantDraft = Pick<
  GatewayWorkspaceRootGrant,
  "alias" | "displayPath" | "access"
> & { id?: string };

export type GatewayWorkspaceRootGrantsResponse = {
  grants: GatewayWorkspaceRootGrant[];
};

// 检查点回退的载荷类型:UI 层 checkpointRewind 是唯一真源,这里只做转发,
// 保证 socket 层调用方(gatewaySocket/gatewaySocketRpc)不直接跨层 import。
export type {
  CheckpointDiffStats,
  CheckpointRewindClient,
  CheckpointRewindResult,
  CheckpointTurnSummary,
} from "@liveagent/ui/lib/chat/checkpointRewind";

export type FsListDirsResponse = {
  path: string;
  entries: Array<{ path: string; name: string }>;
  truncated: boolean;
};

export type FsListResponse = {
  path?: string | null;
  depth: number;
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  entries: Array<{ path: string; kind: "file" | "dir"; hidden: boolean }>;
};

export type FsWriteTextResponse = {
  path: string;
  mode: string;
  existedBefore: boolean;
  bytesWritten: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
};

export type FsReadEditableTextResponse = {
  path: string;
  content: string;
  mtimeMs: number;
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
};

export type FsReadWorkspaceImageResponse = {
  path: string;
  mimeType: string;
  data: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
};

export type ChatFileOpenResponse = {
  action: "directory" | "editor" | "opened" | "preview" | "revealed";
  kind: "directory" | "file";
  workdir?: string;
  path?: string;
  line?: number;
  endLine?: number;
  column?: number;
  outsideWorkspace: boolean;
};

export type FsCreateDirResponse = {
  path: string;
  kind: "dir";
};

export type FsRenameResponse = {
  fromPath: string;
  path: string;
  kind: "file" | "dir" | "symlink";
};

export type FsDeleteResponse = {
  path: string;
  kind: "file" | "dir" | "symlink";
};

export type UploadedImagePreviewResponse = {
  mimeType: string;
  data: string;
};

export type {
  LocalTunnelClient,
  TunnelCreateInput,
  TunnelHealth,
  TunnelStateSnapshot,
  TunnelStatus,
  TunnelTtlSeconds,
  TunnelUpdateInput,
} from "@liveagent/ui/lib/tunnels/constants";

export type TunnelStateListener = (snapshot: TunnelStateSnapshot) => void;

export type ManagedProcessRecordPayload = {
  id: string;
  label: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number;
  logPath: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  running: boolean;
  isolated: boolean;
  restored: boolean;
};

export type ManagedProcessStatePayload = {
  revision: number;
  agentOnline: boolean;
  processes: ManagedProcessRecordPayload[];
};

export type ManagedProcessLogPayload = {
  content: string;
  logPath: string;
  truncated: boolean;
};

export type ManagedProcessStateListener = (state: ManagedProcessStatePayload) => void;

export type RawManagedProcessRecord = {
  id?: string;
  label?: string;
  command?: string;
  cwd?: string;
  shell?: string;
  pid?: number;
  log_path?: string;
  started_at?: number;
  finished_at?: number;
  exit_code?: number;
  running?: boolean;
  isolated?: boolean;
  restored?: boolean;
};

export type RawManagedProcessStatePayload = {
  revision?: number;
  agent_online?: boolean;
  processes?: RawManagedProcessRecord[];
};

export type RawManagedProcessOpPayload = {
  action?: string;
  stopped?: boolean;
  state?: RawManagedProcessStatePayload;
  log_content?: string;
  log_path?: string;
  log_truncated?: boolean;
};

export type RawTunnelHealth = {
  status?: string;
  http_status?: number;
  error?: string;
  checked_at?: number;
  rtt_ms?: number;
};

export type RawTunnelStatus = {
  id?: string;
  slug?: string;
  name?: string;
  target_url?: string;
  public_path?: string;
  created_at?: number;
  expires_at?: number;
  active_connections?: number;
  project_path_key?: string;
  local?: RawTunnelHealth | null;
};

export type RawTunnelStatePayload = {
  revision?: number;
  agent_online?: boolean;
  relay?: RawTunnelHealth | null;
  tunnels?: RawTunnelStatus[];
};

export type RawWorkspaceActivityPayload = {
  workdir?: string;
  revision?: number;
  fs?: boolean;
  git?: boolean;
  changedPaths?: unknown;
  truncated?: boolean;
};

export type HistoryGetOptions = {
  maxMessages?: number;
};

export type SkillMetadataResponse = {
  name?: string | null;
  description?: string | null;
};

export type SkillTextResponse = {
  content: string;
  truncated: boolean;
};

export type SkillManagePayload = Record<string, unknown>;

export type RawTerminalResponse = RawTerminalSnapshot &
  RawTerminalShellOptionsResponse &
  RawTerminalSshLatency & {
    action?: string;
    sessions?: RawTerminalSession[];
    sshTabs?: RawSshTerminalTabsSnapshot | null;
    ssh_tabs?: RawSshTerminalTabsSnapshot | null;
    sshLocalForwards?: RawSshLocalForwardSnapshot | null;
    ssh_local_forwards?: RawSshLocalForwardSnapshot | null;
    sshLocalForward?: RawSshLocalForwardAction | null;
    ssh_local_forward?: RawSshLocalForwardAction | null;
    sshLocalForwardPortAvailable?: boolean;
    ssh_local_forward_port_available?: boolean;
  };

export type RawTerminalEvent = SharedRawTerminalEvent<RawSshLocalForwardEvent>;

export class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T) {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  fail(error: Error) {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    const waiters = [...this.waiters];
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const waiters = [...this.waiters];
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.values.length > 0) {
      return { value: this.values.shift() as T, done: false };
    }
    if (this.closed) {
      return { value: undefined as T, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { value: undefined as T, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

// Single source of truth for error-message coercion lives in the shared UI
// lib; re-exported here so the transport/rpc layers keep one import path.
export { asErrorMessage };

export function buildWebSocketUrl() {
  const origin = getRuntimeOrigin();
  if (!origin) {
    throw new Error("Gateway WebSocket origin is unavailable");
  }
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // v2 统一线协议端点（WebSocket + Protobuf 二进制帧）。
  url.pathname = "/ws/v2";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function createChatClientRequestId(input: GatewayChatCommandInput) {
  const commandType = input.type.trim() || "chat.command";
  const conversationId = input.conversationId?.trim() || "new";
  return `webui-${commandType.replace(/[^a-z0-9._-]/gi, "_")}-${conversationId.replace(
    /[^a-z0-9._-]/gi,
    "_",
  )}-${createUuid()}`;
}

export function buildChatCommandPayload(input: GatewayChatCommandInput) {
  const systemSettings = input.systemSettings;
  const clientRequestId = input.clientRequestId?.trim() || createChatClientRequestId(input);
  return {
    type: input.type,
    payload: {
      message: input.message,
      conversation_id: input.conversationId ?? "",
      client_request_id: clientRequestId,
      execution_mode: systemSettings?.executionMode?.trim() || "text",
      workdir: systemSettings?.workdir?.trim() || "",
      command_safety_mode: systemSettings?.commandSafetyMode?.trim() || "",
      uploaded_files:
        input.uploadedFiles?.map((file) => ({
          relative_path: file.relativePath,
          absolute_path: file.absolutePath,
          file_name: file.fileName,
          kind: file.kind,
          size_bytes: file.sizeBytes,
        })) ?? [],
      selected_model: input.selectedModel
        ? {
            custom_provider_id: input.selectedModel.customProviderId,
            model: input.selectedModel.model,
            provider_type: input.selectedModel.providerType,
          }
        : undefined,
      runtime_controls: input.runtimeControls
        ? {
            thinking_enabled: input.runtimeControls.thinkingEnabled,
            native_web_search_enabled: input.runtimeControls.nativeWebSearchEnabled,
            reasoning: input.runtimeControls.reasoning,
            plan_mode_enabled: input.runtimeControls.planModeEnabled === true,
          }
        : undefined,
      queue_policy: input.queuePolicy ?? "auto",
      base_message_ref: input.baseMessageRef
        ? buildHistoryMessageRefPayload(input.baseMessageRef)
        : undefined,
    },
  };
}

export type RawChatCommandResponse = {
  run_id?: string;
  conversation_id?: string;
  accepted_seq?: number;
};

export type RawChatQueueResponse = {
  accepted?: boolean;
  message?: string;
  snapshot_json?: string;
  item_json?: string;
  error_code?: string;
  revision?: number;
};

export type RawChatQueueEvent = {
  conversation_id?: string;
  snapshot_json?: string;
  revision?: number;
};

export function parseJsonPayload<T>(raw: string | undefined, fallback: T): T {
  const text = raw?.trim() ?? "";
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function normalizeChatQueueResponse(input: RawChatQueueResponse): ChatQueueResponse {
  const normalized = input as RawChatQueueResponse & Partial<ChatQueueResponse>;
  return {
    accepted: input.accepted === true,
    message: input.message,
    snapshot:
      normalized.snapshot ??
      parseJsonPayload<ChatQueueSnapshot | undefined>(input.snapshot_json, undefined),
    item: normalized.item ?? parseJsonPayload(input.item_json, undefined),
    errorCode: normalized.errorCode ?? input.error_code,
    revision: input.revision,
  };
}

export function normalizeChatQueueSnapshot(
  input: unknown,
  fallbackConversationId?: string,
  fallbackRevision?: number,
): ChatQueueSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<ChatQueueSnapshot>;
  const conversationId =
    typeof raw.conversationId === "string" && raw.conversationId.trim()
      ? raw.conversationId
      : (fallbackConversationId ?? "");
  if (!conversationId) return null;
  const revision =
    typeof raw.revision === "number" && Number.isFinite(raw.revision)
      ? raw.revision
      : (fallbackRevision ?? 0);
  return {
    conversationId,
    revision,
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

export function normalizeChatQueueEvent(
  input: RawChatQueueEvent | ChatQueueSnapshot,
): ChatQueueSnapshot | null {
  const direct = normalizeChatQueueSnapshot(input);
  if (direct) return direct;
  const raw = input as RawChatQueueEvent;
  return normalizeChatQueueSnapshot(
    parseJsonPayload<ChatQueueSnapshot | null>(raw.snapshot_json, null),
    raw.conversation_id,
    raw.revision,
  );
}

export const RECONNECT_INITIAL_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 10_000;
export const RECONNECT_NOTICE_DELAY_MS = 15_000;
export const SOCKET_INBOUND_STALL_MS = 45_000;
export const FOREGROUND_SOCKET_RECYCLE_IDLE_MS = 20_000;
export const FOREGROUND_WAKEUP_RECENCY_MS = 15_000;
export const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const SOCKET_AUTH_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const CHAT_PREPARE_REQUEST_TIMEOUT_MS = 2_500;
export const CHAT_COMMAND_ACK_TIMEOUT_MS = 4_000;
// Fallback only: agent online/offline transitions arrive as pushed
// status.event frames, so the poll exists to reconcile missed pushes and
// TTL-derived fields (chat_runtime_ready), not to detect liveness. While the
// pill shows offline the poll IS the recovery path against a gateway that
// does not push (rollback), so it speeds up.
export const STATUS_POLL_INTERVAL_MS = 30_000;
export const STATUS_POLL_OFFLINE_INTERVAL_MS = 5_000;

export type RuntimeHost = {
  location?: {
    origin?: string;
    href?: string;
  };
  // Explicit browser-timer signatures rather than typeof setTimeout/etc: this
  // code only ever runs against window/globalThis in a browser, but `typeof
  // setTimeout` resolves ambiently and flips to NodeJS.Timeout if any
  // dependency's types pull in @types/node, breaking the `number`-typed
  // timer handle fields below.
  setTimeout: (handler: () => void, timeout?: number) => number;
  clearTimeout: (handle: number) => void;
  setInterval: (handler: () => void, timeout?: number) => number;
  clearInterval: (handle: number) => void;
};

export const DEFAULT_HISTORY_LIST_PAGE = 1;
export const DEFAULT_HISTORY_LIST_PAGE_SIZE = 80;
export const MAX_HISTORY_LIST_PAGE_SIZE = 200;

export function getRuntimeHost(): RuntimeHost {
  if (typeof window !== "undefined") {
    return window as unknown as RuntimeHost;
  }
  return globalThis as unknown as RuntimeHost;
}

export function getRuntimeOrigin() {
  const host = getRuntimeHost();
  const origin = host.location?.origin;
  if (typeof origin === "string" && origin.trim()) {
    return origin;
  }
  const href = host.location?.href;
  if (typeof href === "string" && href.trim()) {
    return new URL(href).origin;
  }
  return "";
}

export function isDocumentHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function isForegroundWakeupEvent(event?: Event) {
  const type = event?.type ?? "";
  if (type === "pagehide" || type === "freeze") {
    return false;
  }
  if (typeof document !== "undefined" && type === "visibilitychange") {
    return document.visibilityState === "visible";
  }
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden" &&
    type !== "online"
  ) {
    return false;
  }
  return true;
}

export function normalizePositiveInteger(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

export function sftpPathPayload(side: "local" | "remote", path = "") {
  return {
    side,
    direction: side,
    local_path: side === "local" ? String(path) : "",
    remote_path: side === "remote" ? String(path) : "",
  };
}

export function normalizeTerminalBytes(value: unknown, fallbackText?: string): Uint8Array {
  const bytes = normalizeTerminalByteContainer(value, (text) => {
    try {
      return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
    } catch {
      return new TextEncoder().encode(text);
    }
  });
  return bytes.byteLength > 0 || !fallbackText ? bytes : new TextEncoder().encode(fallbackText);
}

export function applyTerminalSnapshotEvent(
  snapshot: Map<string, TerminalSession>,
  event: TerminalEvent,
) {
  if (event.kind === "output") return;

  const sessionId = (event.sessionId || event.session?.id || "").trim();
  if (event.kind === "closed") {
    if (sessionId) {
      snapshot.delete(sessionId);
    }
    return;
  }

  const session = event.session;
  if (session?.id) {
    snapshot.set(session.id, session);
  }
}

export function replayTerminalSnapshot(
  snapshot: Map<string, TerminalSession>,
  listener: TerminalListener,
) {
  const sessions = [...snapshot.values()].sort((a, b) => {
    const leftProject = (a.projectPathKey || a.cwd || "").trim();
    const rightProject = (b.projectPathKey || b.cwd || "").trim();
    return leftProject.localeCompare(rightProject) || a.createdAt - b.createdAt;
  });
  for (const session of sessions) {
    listener({
      kind: "created",
      sessionId: session.id,
      projectPathKey: session.projectPathKey,
      session,
    });
  }
}

export function normalizeTunnelHealthStatus(input: unknown): TunnelHealth["status"] {
  return input === "ok" || input === "failed" ? input : "unknown";
}

export function normalizeTunnelHealth(
  input: RawTunnelHealth | null | undefined,
): TunnelHealth | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    status: normalizeTunnelHealthStatus(input.status),
    httpStatus: Number(input.http_status ?? 0),
    error: (input.error ?? "").trim(),
    checkedAt: Number(input.checked_at ?? 0),
    rttMs: Number(input.rtt_ms ?? 0),
  };
}

export function normalizeTunnelStatus(input: RawTunnelStatus): TunnelStatus {
  return {
    id: input.id?.trim() ?? "",
    slug: input.slug?.trim() ?? "",
    name: input.name?.trim() ?? "",
    targetUrl: input.target_url ?? "",
    publicPath: input.public_path ?? "",
    createdAt: Number(input.created_at ?? 0),
    expiresAt: Number(input.expires_at ?? 0),
    activeConnections: Number(input.active_connections ?? 0),
    projectPathKey: (input.project_path_key ?? "").trim(),
    local: normalizeTunnelHealth(input.local),
  };
}

export function normalizeManagedProcessState(
  input: RawManagedProcessStatePayload,
): ManagedProcessStatePayload {
  const processes = Array.isArray(input.processes) ? input.processes : [];
  return {
    revision: Number(input.revision ?? 0),
    agentOnline: input.agent_online === true,
    processes: processes.map((record) => ({
      id: String(record.id ?? ""),
      label: String(record.label ?? ""),
      command: String(record.command ?? ""),
      cwd: String(record.cwd ?? ""),
      shell: String(record.shell ?? ""),
      pid: Number(record.pid ?? 0),
      logPath: String(record.log_path ?? ""),
      startedAt: Number(record.started_at ?? 0),
      finishedAt: typeof record.finished_at === "number" ? record.finished_at : null,
      exitCode: typeof record.exit_code === "number" ? record.exit_code : null,
      running: record.running === true,
      isolated: record.isolated === true,
      restored: record.restored === true,
    })),
  };
}

export function normalizeTunnelStateSnapshot(input: RawTunnelStatePayload): TunnelStateSnapshot {
  return {
    revision: Number(input.revision ?? 0),
    agentOnline: input.agent_online === true,
    relay: normalizeTunnelHealth(input.relay),
    tunnels: (input.tunnels ?? []).map(normalizeTunnelStatus),
  };
}

export function normalizeWorkspaceActivity(
  input: RawWorkspaceActivityPayload,
): WorkspaceActivity | null {
  const workdir = typeof input.workdir === "string" ? input.workdir : "";
  if (!workdir) {
    return null;
  }
  return {
    workdir,
    revision: Number(input.revision ?? 0),
    fs: input.fs === true,
    git: input.git === true,
    changedPaths: Array.isArray(input.changedPaths)
      ? input.changedPaths.filter((path): path is string => typeof path === "string")
      : [],
    truncated: input.truncated === true,
  };
}

export function normalizeHistoryListPage(page: number) {
  return normalizePositiveInteger(page, DEFAULT_HISTORY_LIST_PAGE);
}

export function normalizeHistoryListPageSize(pageSize: number) {
  return Math.min(
    normalizePositiveInteger(pageSize, DEFAULT_HISTORY_LIST_PAGE_SIZE),
    MAX_HISTORY_LIST_PAGE_SIZE,
  );
}

export function isRecoverableGatewayTransportError(error: unknown) {
  const message = asErrorMessage(error, "");
  return (
    message.startsWith("Gateway WebSocket disconnected") ||
    message === "Gateway WebSocket is not connected" ||
    message.startsWith("Gateway transport stalled")
  );
}

export function isRequestTimeoutError(error: unknown) {
  return asErrorMessage(error, "").startsWith("Gateway WebSocket request timed out");
}

export function isConnectionSetupTimeoutError(error: unknown) {
  const message = asErrorMessage(error, "");
  return (
    message === "Gateway WebSocket connection timed out" ||
    message === "Gateway WebSocket auth timed out"
  );
}

export function isUnsupportedChatPrepareError(error: unknown) {
  const message = asErrorMessage(error, "").toLowerCase();
  return (
    message.includes("unsupported request type") ||
    message.includes("unsupported chat.prepare") ||
    message.includes("unknown request type")
  );
}

export const RECOVERABLE_MEMORY_MANAGE_COMMANDS = new Set([
  "memory_list",
  "memory_read",
  "memory_search",
  "memory_organize_run_create",
  "memory_organize_run_update",
  "memory_organize_run_list",
  "memory_organize_run_read",
  "memory_organize_due_claim",
  "memory_organize_due_complete",
  "memory_index_overview",
  "memory_recent_rejections",
  "memory_paths_info",
  "memory_today_local_date",
  "memory_today_daily",
]);

export function shouldRecoverMemoryManageRequest(payload: MemoryManagePayload) {
  const command = typeof payload.command === "string" ? payload.command.trim() : "";
  return RECOVERABLE_MEMORY_MANAGE_COMMANDS.has(command);
}

export const ACTIVE_AGENT_STORAGE_KEY = "liveagent.gateway.activeAgent";
export const AGENT_ID_OPTIONAL_REQUEST_TYPES = new Set(["agent.list", "chat.activities"]);

export function requestRequiresAgentId(type: string): boolean {
  return !AGENT_ID_OPTIONAL_REQUEST_TYPES.has(type);
}

export function loadPersistedActiveAgent(): string {
  try {
    return (globalThis.localStorage?.getItem(ACTIVE_AGENT_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function persistActiveAgent(agentId: string) {
  try {
    if (agentId) {
      globalThis.localStorage?.setItem(ACTIVE_AGENT_STORAGE_KEY, agentId);
    } else {
      globalThis.localStorage?.removeItem(ACTIVE_AGENT_STORAGE_KEY);
    }
  } catch {
    // 隐私模式等场景不可写：选择只在本页生命周期内生效。
  }
}
