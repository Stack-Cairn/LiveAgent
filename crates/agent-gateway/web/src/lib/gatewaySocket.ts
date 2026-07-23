import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import { ConversationStreamClient } from "@/lib/chat/stream/conversationStreamClient";
import type {
  ChatCommandAccepted,
  ChatCommandUpdate,
  ConversationActivityEvent,
  ConversationStreamHandlers,
} from "@/lib/chat/stream/streamTypes";
import { normalizeActivityEvent, normalizeCommandUpdate } from "@/lib/chat/stream/streamTypes";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import type {
  GatewaySettingsSyncPayload,
  GatewaySettingsSyncUpdatePayload,
} from "@/lib/settings/sync";
import type {
  SftpActionResponse,
  SftpEntry,
  SftpListResponse,
  SftpStatResponse,
  SftpTransfer,
  SftpTransferEvent,
  SftpTransferResponse,
} from "@/lib/sftp/types";
import { createUuid } from "@/lib/shared/id";
import { BrowserGatewayTerminalStreamClient } from "@/lib/terminal/gatewayTerminalStreamClient";
import type {
  SshTerminalTab,
  SshTerminalTabKind,
  SshTerminalTabsSnapshot,
  TerminalEvent,
  TerminalSession,
  TerminalShellOptions,
  TerminalSnapshot,
  TerminalSshCreateResult,
  TerminalSshLatency,
  TerminalSshMetadata,
  TerminalSshPrompt,
  TerminalStreamClient,
} from "@/lib/terminal/types";
import type {
  TunnelCreateInput,
  TunnelHealth,
  TunnelStateSnapshot,
  TunnelStatus,
  TunnelUpdateInput,
} from "@/lib/tunnels/constants";
import type {
  WorkspaceActivity,
  WorkspaceActivityEventPayload,
} from "@/lib/workspace-activity/types";
import type { DecodedServerFrame } from "./gatewaySocketV2/adapters";
import {
  decodeServerFrame,
  decodeServerFrameBinary,
  encodeHelloFrame,
  encodePongFrame,
  encodeRequestFrame,
  GATEWAY_V2_SUBPROTOCOL,
} from "./gatewaySocketV2/adapters";
import type {
  AgentStatus,
  ChatQueueResponse,
  ChatQueueSnapshot,
  ConversationSummary,
  CreateProjectFolderResponse,
  CronManagePayload,
  CronManageResponse,
  GatewayChatRuntimeControls,
  GatewayHistoryEvent,
  GatewayProviderSummary,
  GatewaySelectedModel,
  HistoryDetail,
  HistoryList,
  HistoryListFilter,
  HistoryShareStatus,
  HistoryWorkdirsResponse,
  MemoryManagePayload,
  RunningConversationSummary,
} from "./gatewayTypes";

type StatusListener = (status: AgentStatus | null, error: string | null) => void;
type HistoryListener = (event: GatewayHistoryEvent) => void;
type SettingsListener = (event: GatewaySettingsSyncPayload) => void;
type GatewaySettingsUpdateResponse = {
  accepted?: boolean;
  message?: string;
};
type TerminalListener = (event: TerminalEvent) => void;
type SftpTransferListener = (event: SftpTransferEvent) => void;
type ChatQueueListener = (snapshot: ChatQueueSnapshot) => void;
type ChatActivityListener = (event: ConversationActivityEvent) => void;
type ChatCommandUpdateListener = (update: ChatCommandUpdate) => void;
type WorkspaceActivityListener = (event: WorkspaceActivityEventPayload) => void;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

type GatewayRequestOptions = {
  timeoutMs?: number;
};

type GatewayChatSystemSettings = {
  executionMode?: string;
  workdir?: string;
  selectedSystemTools?: string[];
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

type SkillListResponse = {
  rootDir: string;
  paths: string[];
  truncated: boolean;
};

export type SshKnownHostResetResult = {
  deleted: number;
};

type MentionListResponse = {
  entries: Array<{ path: string; kind: "file" | "dir"; hidden: boolean }>;
  truncated: boolean;
};

type FsRoot = {
  id: string;
  path: string;
  kind: "home" | "root" | "drive";
  label: string;
};

type FsRootsResponse = {
  roots: FsRoot[];
};

type FsListDirsResponse = {
  path: string;
  entries: Array<{ path: string; name: string }>;
  truncated: boolean;
};

type FsListResponse = {
  path?: string | null;
  depth: number;
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  entries: Array<{ path: string; kind: "file" | "dir"; hidden: boolean }>;
};

type FsWriteTextResponse = {
  path: string;
  mode: string;
  existedBefore: boolean;
  bytesWritten: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
};

type FsReadEditableTextResponse = {
  path: string;
  content: string;
  mtimeMs: number;
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
};

type FsReadWorkspaceImageResponse = {
  path: string;
  mimeType: string;
  data: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
};

type FsCreateDirResponse = {
  path: string;
  kind: "dir";
};

type FsRenameResponse = {
  fromPath: string;
  path: string;
  kind: "file" | "dir" | "symlink";
};

type FsDeleteResponse = {
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
} from "@/lib/tunnels/constants";

type TunnelStateListener = (snapshot: TunnelStateSnapshot) => void;

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

type ManagedProcessStateListener = (state: ManagedProcessStatePayload) => void;

type RawManagedProcessRecord = {
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

type RawManagedProcessStatePayload = {
  revision?: number;
  agent_online?: boolean;
  processes?: RawManagedProcessRecord[];
};

type RawManagedProcessOpPayload = {
  action?: string;
  stopped?: boolean;
  state?: RawManagedProcessStatePayload;
  log_content?: string;
  log_path?: string;
  log_truncated?: boolean;
};

type RawTunnelHealth = {
  status?: string;
  http_status?: number;
  error?: string;
  checked_at?: number;
  rtt_ms?: number;
};

type RawTunnelStatus = {
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

type RawTunnelStatePayload = {
  revision?: number;
  agent_online?: boolean;
  relay?: RawTunnelHealth | null;
  tunnels?: RawTunnelStatus[];
};

type RawWorkspaceActivityPayload = {
  workdir?: string;
  revision?: number;
  fs?: boolean;
  git?: boolean;
  changedPaths?: unknown;
  truncated?: boolean;
};

type HistoryGetOptions = {
  maxMessages?: number;
};

type SkillMetadataResponse = {
  name?: string | null;
  description?: string | null;
};

type SkillTextResponse = {
  content: string;
  truncated: boolean;
};

type SkillManagePayload = Record<string, unknown>;

type RawTerminalSession = {
  id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  cwd?: string;
  shell?: string;
  title?: string;
  pid?: number | null;
  cols?: number;
  rows?: number;
  createdAt?: number;
  created_at?: number;
  updatedAt?: number;
  updated_at?: number;
  finishedAt?: number | null;
  finished_at?: number | null;
  exitCode?: number | null;
  exit_code?: number | null;
  running?: boolean;
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

type RawTerminalResponse = {
  action?: string;
  sessions?: RawTerminalSession[];
  session?: RawTerminalSession;
  snapshot?: TerminalSnapshot;
  prompt?: TerminalSshPrompt;
  output?: string;
  outputBytes?: unknown;
  output_bytes?: unknown;
  truncated?: boolean;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
  options?: Array<{ id?: string; label?: string; command?: string }>;
  shellOptions?: Array<{ id?: string; label?: string; command?: string }>;
  shell_options?: Array<{ id?: string; label?: string; command?: string }>;
  defaultShell?: string;
  default_shell?: string;
  sshPrompt?: RawTerminalSshPrompt | null;
  ssh_prompt?: RawTerminalSshPrompt | null;
  sshTabs?: RawSshTerminalTabsSnapshot | null;
  ssh_tabs?: RawSshTerminalTabsSnapshot | null;
  latencyMs?: number;
  latency_ms?: number;
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

type RawSftpEntry = Partial<SftpEntry> & {
  size_bytes?: number;
};

type RawSftpTransfer = Partial<SftpTransfer> & {
  session_id?: string;
  source_path?: string;
  target_path?: string;
  current_path?: string;
  bytes_done?: number;
  bytes_total?: number;
  files_done?: number;
  files_total?: number;
};

type RawSftpResponse = Partial<SftpListResponse & SftpStatResponse & SftpActionResponse> & {
  entries?: RawSftpEntry[];
  entry?: RawSftpEntry | null;
  transfer?: RawSftpTransfer | null;
};

type RawSftpEvent = {
  kind?: string;
  transfer?: RawSftpTransfer | null;
};

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
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

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const text = String(error ?? "").trim();
  return text || fallback;
}

function buildWebSocketUrl() {
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

function createChatClientRequestId(input: GatewayChatCommandInput) {
  const commandType = input.type.trim() || "chat.command";
  const conversationId = input.conversationId?.trim() || "new";
  return `webui-${commandType.replace(/[^a-z0-9._-]/gi, "_")}-${conversationId.replace(
    /[^a-z0-9._-]/gi,
    "_",
  )}-${createUuid()}`;
}

function buildChatCommandPayload(input: GatewayChatCommandInput) {
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
      selected_system_tools:
        systemSettings?.selectedSystemTools?.map((item) => item.trim()).filter(Boolean) ?? [],
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
          }
        : undefined,
      queue_policy: input.queuePolicy ?? "auto",
      base_message_ref: input.baseMessageRef
        ? buildHistoryMessageRefPayload(input.baseMessageRef)
        : undefined,
    },
  };
}

function buildHistoryMessageRefPayload(ref: HistoryMessageRef) {
  return {
    segment_index: ref.segmentIndex,
    message_index: ref.messageIndex,
    segment_id: ref.segmentId,
    message_id: ref.messageId,
    role: ref.role,
    content_hash: ref.contentHash,
  };
}

type RawChatCommandResponse = {
  run_id?: string;
  conversation_id?: string;
  accepted_seq?: number;
};

type RawChatQueueResponse = {
  accepted?: boolean;
  message?: string;
  snapshot_json?: string;
  item_json?: string;
  error_code?: string;
  revision?: number;
};

type RawChatQueueEvent = {
  conversation_id?: string;
  snapshot_json?: string;
  revision?: number;
};

function parseJsonPayload<T>(raw: string | undefined, fallback: T): T {
  const text = raw?.trim() ?? "";
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function normalizeChatQueueResponse(input: RawChatQueueResponse): ChatQueueResponse {
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

function normalizeChatQueueSnapshot(
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

function normalizeChatQueueEvent(
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

const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_NOTICE_DELAY_MS = 15_000;
const SOCKET_INBOUND_STALL_MS = 45_000;
const FOREGROUND_SOCKET_RECYCLE_IDLE_MS = 20_000;
const FOREGROUND_WAKEUP_RECENCY_MS = 15_000;
const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_AUTH_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CHAT_PREPARE_REQUEST_TIMEOUT_MS = 2_500;
const CHAT_COMMAND_ACK_TIMEOUT_MS = 4_000;
// Fallback only: agent online/offline transitions arrive as pushed
// status.event frames, so the poll exists to reconcile missed pushes and
// TTL-derived fields (chat_runtime_ready), not to detect liveness. While the
// pill shows offline the poll IS the recovery path against a gateway that
// does not push (rollback), so it speeds up.
const STATUS_POLL_INTERVAL_MS = 30_000;
const STATUS_POLL_OFFLINE_INTERVAL_MS = 5_000;

type RuntimeHost = {
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

const DEFAULT_HISTORY_LIST_PAGE = 1;
const DEFAULT_HISTORY_LIST_PAGE_SIZE = 80;
const MAX_HISTORY_LIST_PAGE_SIZE = 200;

function getRuntimeHost(): RuntimeHost {
  if (typeof window !== "undefined") {
    return window as unknown as RuntimeHost;
  }
  return globalThis as unknown as RuntimeHost;
}

function getRuntimeOrigin() {
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

function isDocumentHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function isForegroundWakeupEvent(event?: Event) {
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

function normalizePositiveInteger(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeTerminalSession(input: RawTerminalSession): TerminalSession {
  const kind = input.kind === "ssh" ? "ssh" : "local";
  return {
    id: input.id ?? "",
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    cwd: input.cwd ?? "",
    shell: input.shell ?? "",
    title: input.title ?? "Terminal",
    kind,
    ssh: input.ssh ? normalizeTerminalSshMetadata(input.ssh) : null,
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

function normalizeTerminalSshMetadata(input: RawTerminalSshMetadata): TerminalSshMetadata {
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

function normalizeTerminalSshPrompt(
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

function normalizeSftpEntry(entry: RawSftpEntry): SftpEntry {
  return {
    path: entry.path ?? "",
    name: entry.name ?? "",
    kind: entry.kind ?? "file",
    sizeBytes: Number(entry.sizeBytes ?? entry.size_bytes ?? 0),
    mtime: Number(entry.mtime ?? 0),
  };
}

function normalizeSftpTransfer(transfer: RawSftpTransfer): SftpTransfer {
  return {
    id: transfer.id ?? "",
    sessionId: transfer.sessionId ?? transfer.session_id ?? "",
    direction: transfer.direction ?? "",
    status: transfer.status ?? "",
    sourcePath: transfer.sourcePath ?? transfer.source_path ?? "",
    targetPath: transfer.targetPath ?? transfer.target_path ?? "",
    currentPath: transfer.currentPath ?? transfer.current_path ?? "",
    bytesDone: Number(transfer.bytesDone ?? transfer.bytes_done ?? 0),
    bytesTotal: Number(transfer.bytesTotal ?? transfer.bytes_total ?? 0),
    filesDone: Number(transfer.filesDone ?? transfer.files_done ?? 0),
    filesTotal: Number(transfer.filesTotal ?? transfer.files_total ?? 0),
    error: transfer.error ?? null,
  };
}

function normalizeSftpListResponse(response: RawSftpResponse): SftpListResponse {
  return {
    path: response.path ?? "",
    entries: (response.entries ?? []).map(normalizeSftpEntry),
  };
}

function normalizeSftpStatResponse(response: RawSftpResponse): SftpStatResponse {
  return {
    exists: response.exists === true,
    entry: response.entry ? normalizeSftpEntry(response.entry) : null,
  };
}

function normalizeSftpActionResponse(response: RawSftpResponse): SftpActionResponse {
  return {
    action: response.action ?? "",
    path: response.path ?? "",
    entry: response.entry ? normalizeSftpEntry(response.entry) : null,
    transfer: response.transfer ? normalizeSftpTransfer(response.transfer) : null,
  };
}

function normalizeSftpTransferResponse(response: RawSftpResponse): SftpTransferResponse {
  if (!response.transfer) {
    throw new Error("SFTP transfer response did not include a transfer");
  }
  return { transfer: normalizeSftpTransfer(response.transfer) };
}

function normalizeSftpTransferEvent(event: RawSftpEvent): SftpTransferEvent | null {
  if (!event.transfer) return null;
  return {
    kind: event.kind ?? "",
    transfer: normalizeSftpTransfer(event.transfer),
  };
}

function sftpPathPayload(side: "local" | "remote", path = "") {
  return {
    side,
    direction: side,
    local_path: side === "local" ? String(path) : "",
    remote_path: side === "remote" ? String(path) : "",
  };
}

function normalizeTerminalSnapshot(input: RawTerminalResponse): TerminalSnapshot {
  if (!input.session) {
    throw new Error("Terminal response did not include a session");
  }
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    session: normalizeTerminalSession(input.session),
    output: input.output ?? "",
    outputBytes: normalizeTerminalBytes(input.outputBytes ?? input.output_bytes, input.output),
    truncated: input.truncated === true,
    outputStartOffset,
    outputEndOffset,
  };
}

function normalizeTerminalBytes(value: unknown, fallbackText?: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item) & 0xff));
  if (typeof value === "string" && value.length > 0) {
    try {
      return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    } catch {
      return new TextEncoder().encode(value);
    }
  }
  return fallbackText ? new TextEncoder().encode(fallbackText) : new Uint8Array();
}

function normalizeTerminalSshCreateResult(input: RawTerminalResponse): TerminalSshCreateResult {
  return {
    snapshot: input.snapshot ?? (input.session ? normalizeTerminalSnapshot(input) : undefined),
    prompt: input.prompt ?? normalizeTerminalSshPrompt(input.sshPrompt ?? input.ssh_prompt),
  };
}

function normalizeTerminalSshLatency(input: RawTerminalResponse): TerminalSshLatency {
  const latencyMs = Number(input.latencyMs ?? input.latency_ms ?? 0);
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
    throw new Error("SSH latency response did not include latency");
  }
  return {
    sessionId: input.session?.id ?? "",
    latencyMs: Math.round(latencyMs),
  };
}

function normalizeTerminalShellOptions(input: RawTerminalResponse): TerminalShellOptions {
  const options = (input.options ?? input.shellOptions ?? input.shell_options ?? [])
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
  const kind: SshTerminalTabKind = input.kind === "sftp" ? "sftp" : "bash";
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

function normalizeTerminalEvent(input: RawTerminalEvent): TerminalEvent | null {
  const hasSshTabs = Boolean(input.sshTabs || input.ssh_tabs);
  if (!input.session && !hasSshTabs) return null;
  const session = input.session ? normalizeTerminalSession(input.session) : undefined;
  const sshTabs = hasSshTabs
    ? normalizeSshTerminalTabsSnapshot(input.sshTabs ?? input.ssh_tabs)
    : undefined;
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
      sshTabs?.projectPathKey ??
      "",
    session,
    outputStartOffset,
    outputEndOffset,
    sshTabs,
  };
}

function applyTerminalSnapshotEvent(snapshot: Map<string, TerminalSession>, event: TerminalEvent) {
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

function replayTerminalSnapshot(
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

function normalizeTunnelHealthStatus(input: unknown): TunnelHealth["status"] {
  return input === "ok" || input === "failed" ? input : "unknown";
}

function normalizeTunnelHealth(input: RawTunnelHealth | null | undefined): TunnelHealth | null {
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

function normalizeTunnelStatus(input: RawTunnelStatus): TunnelStatus {
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

function normalizeManagedProcessState(
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

function normalizeTunnelStateSnapshot(input: RawTunnelStatePayload): TunnelStateSnapshot {
  return {
    revision: Number(input.revision ?? 0),
    agentOnline: input.agent_online === true,
    relay: normalizeTunnelHealth(input.relay),
    tunnels: (input.tunnels ?? []).map(normalizeTunnelStatus),
  };
}

function normalizeWorkspaceActivity(input: RawWorkspaceActivityPayload): WorkspaceActivity | null {
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

function normalizeOptionalOffset(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function normalizeHistoryListPage(page: number) {
  return normalizePositiveInteger(page, DEFAULT_HISTORY_LIST_PAGE);
}

function normalizeHistoryListPageSize(pageSize: number) {
  return Math.min(
    normalizePositiveInteger(pageSize, DEFAULT_HISTORY_LIST_PAGE_SIZE),
    MAX_HISTORY_LIST_PAGE_SIZE,
  );
}

function isRecoverableGatewayTransportError(error: unknown) {
  const message = asErrorMessage(error, "");
  return (
    message.startsWith("Gateway WebSocket disconnected") ||
    message === "Gateway WebSocket is not connected" ||
    message.startsWith("Gateway transport stalled")
  );
}

function isRequestTimeoutError(error: unknown) {
  return asErrorMessage(error, "").startsWith("Gateway WebSocket request timed out");
}

function isConnectionSetupTimeoutError(error: unknown) {
  const message = asErrorMessage(error, "");
  return (
    message === "Gateway WebSocket connection timed out" ||
    message === "Gateway WebSocket auth timed out"
  );
}

function isUnsupportedChatPrepareError(error: unknown) {
  const message = asErrorMessage(error, "").toLowerCase();
  return (
    message.includes("unsupported request type") ||
    message.includes("unsupported chat.prepare") ||
    message.includes("unknown request type")
  );
}

const RECOVERABLE_MEMORY_MANAGE_COMMANDS = new Set([
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

function shouldRecoverMemoryManageRequest(payload: MemoryManagePayload) {
  const command = typeof payload.command === "string" ? payload.command.trim() : "";
  return RECOVERABLE_MEMORY_MANAGE_COMMANDS.has(command);
}

const ACTIVE_AGENT_STORAGE_KEY = "liveagent.gateway.activeAgent";
const AGENT_ID_OPTIONAL_REQUEST_TYPES = new Set(["agent.list", "chat.activities"]);

function requestRequiresAgentId(type: string): boolean {
  return !AGENT_ID_OPTIONAL_REQUEST_TYPES.has(type);
}

function loadPersistedActiveAgent(): string {
  try {
    return (globalThis.localStorage?.getItem(ACTIVE_AGENT_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

function persistActiveAgent(agentId: string) {
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

export class GatewayWebSocketClient {
  readonly terminalStream: BrowserGatewayTerminalStreamClient;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private authenticated = false;
  private requestSeq = 0;
  private pending = new Map<string, PendingRequest>();
  private disposed = false;
  private statusListeners = new Set<StatusListener>();
  private historyListeners = new Set<HistoryListener>();
  private settingsListeners = new Set<SettingsListener>();
  private terminalListeners = new Set<TerminalListener>();
  private sftpTransferListeners = new Set<SftpTransferListener>();
  private chatQueueListeners = new Set<ChatQueueListener>();
  private chatActivityListeners = new Set<ChatActivityListener>();
  private chatCommandUpdateListeners = new Set<ChatCommandUpdateListener>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private connectionState = false;
  private tunnelStateListeners = new Set<TunnelStateListener>();
  private workspaceActivityListeners = new Map<string, Set<WorkspaceActivityListener>>();
  private lastTunnelState: TunnelStateSnapshot | null = null;
  // Server tunnel.state revisions are only monotonic within one gateway
  // process; this guard is reset on disconnect so a restarted gateway's
  // snapshots are not dropped. Subscribers see a client-side monotonic
  // revision instead.
  private lastTunnelStateServerRevision = 0;
  private tunnelStateRevisionCounter = 0;
  private processStateListeners = new Set<ManagedProcessStateListener>();
  private lastProcessState: ManagedProcessStatePayload | null = null;
  readonly conversationStreams = new ConversationStreamClient({
    request: (type, payload, options) => this.request(type, payload, options),
  });
  private terminalSessionSnapshot = new Map<string, TerminalSession>();
  private statusPollTimer: number | null = null;
  private statusPollingActive = false;
  private statusRefreshInFlight = false;
  private lastStatus: AgentStatus | null = null;
  private lastStatusError: string | null = null;
  private lastInboundAt = 0;
  private reconnectTimer: number | null = null;
  private reconnectNoticeTimer: number | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  // hello 判定鉴权失败（随后 4401 关闭）：置位抑制自动重连，显式新连接尝试会清除。
  private authRejected = false;
  private lastForegroundWakeupAt = 0;
  // A hidden tab must not paint offline state the user cannot see from
  // throttled timers; the verdict is deferred until a foreground recheck.
  private offlineReassessmentPending = false;
  private prepareRuntimePromise: Promise<AgentStatus> | null = null;
  private readonly reconnectWakeup = (event?: Event) => {
    this.noteForegroundWakeup(event);
  };

  // activeAgentId 始终是明确目标；首次连接从 Agent 目录自动选择并持久化。
  private activeAgentId = "";
  private activeAgentSelectionPromise: Promise<string> | null = null;
  // agents 目录：由打标 status 事件与 agent_list 响应维护，含离线条目。
  private agents = new Map<string, AgentStatus>();
  private agentsListeners = new Set<(agents: AgentStatus[]) => void>();
  private pendingAgentEvents = new Map<string, Array<{ type: string; payload: unknown }>>();

  constructor(private readonly token: string) {
    this.activeAgentId = loadPersistedActiveAgent();
    this.terminalStream = new BrowserGatewayTerminalStreamClient(token, () => this.activeAgentId);
    this.installReconnectWakeups();
  }

  getActiveAgent(): string {
    return this.activeAgentId;
  }

  // setActiveAgent 只接受明确目标；切换后重连，以目标 Agent 的快照重画状态。
  setActiveAgent(agentId: string): void {
    const next = agentId.trim();
    if (!next) {
      throw new Error("agent_id is required");
    }
    this.switchActiveAgent(next, true);
  }

  private switchActiveAgent(agentId: string, reconnect: boolean): void {
    if (agentId === this.activeAgentId) {
      return;
    }
    this.activeAgentId = agentId;
    persistActiveAgent(agentId);
    if (reconnect && this.socket && this.authenticated) {
      this.handleDisconnect(new Error("active agent switched"));
    } else if (!reconnect && this.socket && this.authenticated) {
      this.flushPendingAgentEvents(agentId);
      this.conversationStreams.handleConnected();
      this.handleWorkspaceActivityConnected();
    }
  }

  // listAgents 拉取 Agent 目录（含离线与仅签发凭证的条目）。
  async listAgents(): Promise<AgentStatus[]> {
    if (!this.activeAgentId) {
      await this.ensureConnected();
      await this.ensureActiveAgent();
      await this.ensureConnected();
      return this.snapshotAgents();
    }
    const result = await this.requestWithRecovery<{ agents: AgentStatus[] }>("agent.list", {});
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    this.updateAgentDirectory(agents);
    this.reconcileActiveAgent(agents);
    return this.snapshotAgents();
  }

  subscribeAgents(listener: (agents: AgentStatus[]) => void): () => void {
    this.agentsListeners.add(listener);
    if (this.agents.size > 0) {
      listener(this.snapshotAgents());
    }
    return () => {
      this.agentsListeners.delete(listener);
    };
  }

  private updateAgentDirectory(agents: AgentStatus[]): void {
    this.agents.clear();
    for (const agent of agents) {
      const agentId = (agent.agent_id ?? "").trim();
      if (agentId) {
        this.agents.set(agentId, agent);
      }
    }
    this.emitAgents();
  }

  private reconcileActiveAgent(agents: AgentStatus[], reconnect = true): string {
    const current = this.activeAgentId;
    if (current && agents.some((agent) => (agent.agent_id ?? "").trim() === current)) {
      return current;
    }
    const preferred = [...agents]
      .filter((agent) => (agent.agent_id ?? "").trim() !== "")
      .sort((left, right) => {
        if (left.online !== right.online) {
          return left.online ? -1 : 1;
        }
        return (left.agent_id ?? "").localeCompare(right.agent_id ?? "");
      })[0];
    const agentId = (preferred?.agent_id ?? "").trim();
    if (agentId) {
      this.switchActiveAgent(agentId, reconnect);
    } else if (current) {
      this.switchActiveAgent("", reconnect);
    }
    return agentId;
  }

  private async ensureActiveAgent(): Promise<string> {
    if (this.activeAgentId) {
      return this.activeAgentId;
    }
    if (this.activeAgentSelectionPromise) {
      return this.activeAgentSelectionPromise;
    }
    this.activeAgentSelectionPromise = (async () => {
      const result = await this.sendConnectedRequest<{ agents: AgentStatus[] }>(
        "agent.list",
        {},
        undefined,
        "",
      );
      const agents = Array.isArray(result?.agents) ? result.agents : [];
      this.updateAgentDirectory(agents);
      const agentId = this.reconcileActiveAgent(agents, false);
      if (!agentId) {
        throw new Error("No Agent is available");
      }
      return agentId;
    })().finally(() => {
      this.activeAgentSelectionPromise = null;
    });
    return this.activeAgentSelectionPromise;
  }

  private matchesActiveAgent(agentId: string): boolean {
    return this.activeAgentId !== "" && agentId === this.activeAgentId;
  }

  private bufferAgentEvent(agentId: string, type: string, payload: unknown): void {
    const buffered = this.pendingAgentEvents.get(agentId) ?? [];
    if (buffered.length >= 256) {
      buffered.shift();
    }
    buffered.push({ type, payload });
    this.pendingAgentEvents.set(agentId, buffered);
  }

  private flushPendingAgentEvents(agentId: string): void {
    const buffered = this.pendingAgentEvents.get(agentId) ?? [];
    this.pendingAgentEvents.clear();
    for (const event of buffered) {
      this.handleEvent(event.type, event.payload);
    }
  }

  private snapshotAgents(): AgentStatus[] {
    return [...this.agents.values()].sort((a, b) =>
      (a.agent_id ?? "").localeCompare(b.agent_id ?? ""),
    );
  }

  private emitAgents() {
    if (this.agentsListeners.size === 0) {
      return;
    }
    const snapshot = this.snapshotAgents();
    for (const listener of this.agentsListeners) {
      listener(snapshot);
    }
  }

  noteForegroundWakeup(event?: Event) {
    if (this.disposed || !isForegroundWakeupEvent(event)) {
      return;
    }
    const now = Date.now();
    this.lastForegroundWakeupAt = now;
    const reassess = this.offlineReassessmentPending;
    this.offlineReassessmentPending = false;
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.authenticated &&
      this.shouldRecycleAuthenticatedSocket(now)
    ) {
      this.handleDisconnect(this.buildTransportStallError("after page restore"));
      this.scheduleReconnectNotice();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      // Healthy socket: reconcile the status truth immediately so a verdict
      // deferred while hidden resolves to fresh state, not a stale banner.
      if (this.statusListeners.size > 0) {
        void this.refreshStatus();
      }
      return;
    }
    if (reassess || this.reconnectNoticeTimer !== null) {
      // The existing notice delay doubles as the post-wake grace: nothing
      // paints offline until a reconnect attempt has had its 15s to settle.
      // A notice armed before (or while) hidden restarts from wake — it must
      // not fire seconds after refocus with most of its window pre-spent.
      this.clearReconnectNoticeTimer();
      this.scheduleReconnectNotice();
    }
    this.scheduleReconnect(0);
  }

  async getStatus(): Promise<AgentStatus> {
    const status = await this.requestWithRecovery<AgentStatus>("status.get", {});
    this.lastStatus = status;
    this.lastStatusError = null;
    return status;
  }

  async prepareChatRuntime(reason?: string): Promise<AgentStatus> {
    if (this.prepareRuntimePromise) {
      return this.prepareRuntimePromise;
    }
    this.noteForegroundWakeup();
    this.prepareRuntimePromise = (async () => {
      await this.ensureConnected();
      let status: AgentStatus;
      try {
        status = await this.request<AgentStatus>(
          "chat.prepare",
          {
            reason: reason?.trim() || "",
          },
          { timeoutMs: CHAT_PREPARE_REQUEST_TIMEOUT_MS },
        );
      } catch (error) {
        if (!isUnsupportedChatPrepareError(error)) {
          throw error;
        }
        // Rolling-upgrade compatibility: old gateways do not expose the real
        // prepare route. A status read preserves the old behavior until the
        // server is upgraded, while new gateways actively wake the runtime.
        status = await this.getStatus();
      }
      this.emitStatus(status, null);
      return status;
    })().finally(() => {
      this.prepareRuntimePromise = null;
    });
    return this.prepareRuntimePromise;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    if (this.lastStatus || this.lastStatusError) {
      listener(this.lastStatus, this.lastStatusError);
    }
    if (this.statusListeners.size === 1) {
      this.startStatusPolling();
    }
    return () => {
      this.statusListeners.delete(listener);
      if (this.statusListeners.size === 0) {
        this.stopStatusPolling();
      }
    };
  }

  subscribeHistory(listener: HistoryListener): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  subscribeSettings(listener: SettingsListener): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  subscribeTerminal(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    replayTerminalSnapshot(this.terminalSessionSnapshot, listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  subscribeTunnelState(listener: TunnelStateListener): () => void {
    this.tunnelStateListeners.add(listener);
    if (this.lastTunnelState) {
      listener(this.lastTunnelState);
    }
    return () => {
      this.tunnelStateListeners.delete(listener);
    };
  }

  subscribeProcessState(listener: ManagedProcessStateListener): () => void {
    this.processStateListeners.add(listener);
    if (this.lastProcessState) {
      listener(this.lastProcessState);
    }
    return () => {
      this.processStateListeners.delete(listener);
    };
  }

  subscribeSftpTransfers(listener: SftpTransferListener): () => void {
    this.sftpTransferListeners.add(listener);
    return () => {
      this.sftpTransferListeners.delete(listener);
    };
  }

  // Per-workdir workspace activity subscription. The first listener of a
  // workdir sends workspace.subscribe; the last one leaving sends
  // workspace.unsubscribe. On reconnect every registered workdir is
  // re-subscribed and its listeners receive `{ kind: "reset" }` because
  // events may have been missed while the socket was down.
  subscribeWorkspaceActivity(workdir: string, listener: WorkspaceActivityListener): () => void {
    const normalized = workdir.trim();
    if (!normalized) {
      return () => {};
    }
    let listeners = this.workspaceActivityListeners.get(normalized);
    const isFirst = !listeners;
    if (!listeners) {
      listeners = new Set();
      this.workspaceActivityListeners.set(normalized, listeners);
    }
    listeners.add(listener);
    if (isFirst) {
      if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
        void this.sendWorkspaceSubscribe(normalized);
      } else {
        // The post-auth replay issues the subscribe for every registered
        // workdir, this one included.
        void this.ensureConnected().catch(() => {
          this.scheduleReconnect();
        });
      }
    }
    return () => {
      const current = this.workspaceActivityListeners.get(normalized);
      if (!current?.delete(listener)) {
        return;
      }
      if (current.size === 0) {
        this.workspaceActivityListeners.delete(normalized);
        void this.sendWorkspaceUnsubscribe(normalized);
      }
    };
  }

  private async sendWorkspaceSubscribe(workdir: string) {
    try {
      await this.request("workspace.subscribe", { workdir });
    } catch {
      // The post-auth replay retries every registered subscription.
    }
  }

  private async sendWorkspaceUnsubscribe(workdir: string) {
    // Never resurrect a connection just to unsubscribe: a dead socket already
    // dropped the server-side subscription.
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authenticated) {
      return;
    }
    try {
      await this.request("workspace.unsubscribe", { workdir });
    } catch {
      // Connection loss clears server-side subscriptions anyway.
    }
  }

  private handleWorkspaceActivityConnected() {
    const reset: WorkspaceActivityEventPayload = { kind: "reset" };
    for (const [workdir, listeners] of this.workspaceActivityListeners) {
      void this.sendWorkspaceSubscribe(workdir);
      for (const listener of [...listeners]) {
        listener(reset);
      }
    }
  }

  private emitWorkspaceActivity(activity: WorkspaceActivity) {
    const listeners = this.workspaceActivityListeners.get(activity.workdir);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(activity);
    }
  }

  subscribeChatQueue(listener: ChatQueueListener): () => void {
    this.chatQueueListeners.add(listener);
    return () => {
      this.chatQueueListeners.delete(listener);
    };
  }

  async chatQueueGet(conversationId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.get", {
        conversation_id: conversationId,
      }),
    );
  }

  async chatQueueGetItem(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.get_item", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  async chatQueueRunNow(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.run_now", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  async chatQueueMove(
    conversationId: string,
    itemId: string,
    direction: "up" | "down",
  ): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.move", {
        conversation_id: conversationId,
        item_id: itemId,
        direction,
      }),
    );
  }

  async chatQueueRemove(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.remove", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  async chatQueueEditBegin(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.edit_begin", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  async chatQueueEditCommit(input: {
    conversationId: string;
    itemId: string;
    revision: number;
    draftJson: string;
    uploadedFilesJson: string;
  }): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.edit_commit", {
        conversation_id: input.conversationId,
        item_id: input.itemId,
        revision: input.revision,
        draft_json: input.draftJson,
        uploaded_files_json: input.uploadedFilesJson,
      }),
    );
  }

  async chatQueueEditCancel(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.edit_cancel", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  /** 应答桌面端挂起的 AskUserQuestion：item_id 为 toolCallId，request_json 为选择数组。 */
  async chatQueueToolAnswer(
    conversationId: string,
    toolCallId: string,
    answersJson: string,
  ): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.tool_answer", {
        conversation_id: conversationId,
        item_id: toolCallId,
        request_json: answersJson,
      }),
    );
  }

  // Submit a chat command. Streaming does not hang off the command: the
  // conversation subscription (persistent, run-agnostic) carries the reply.
  async chatCommand(input: GatewayChatCommandInput): Promise<ChatCommandAccepted> {
    if (this.token.trim() === "") {
      throw new Error("Gateway token is required");
    }
    // Build exactly once: the gateway deduplicates by client_request_id, so a
    // lost acknowledgement can be retried after reconnect without dispatching
    // a second desktop run. Rebuilding here could generate a different id for
    // callers that omitted one and would defeat that guarantee.
    const payload = buildChatCommandPayload(input);
    const request = () =>
      this.request<RawChatCommandResponse>("chat.command", payload, {
        timeoutMs: CHAT_COMMAND_ACK_TIMEOUT_MS,
      });
    let response: RawChatCommandResponse;
    try {
      response = await request();
    } catch (error) {
      if (
        this.disposed ||
        (!isRecoverableGatewayTransportError(error) &&
          !isRequestTimeoutError(error) &&
          !isConnectionSetupTimeoutError(error))
      ) {
        throw error;
      }
      if (this.socket || this.connectPromise) {
        this.handleDisconnect(
          this.buildTransportStallError("while recovering chat command acknowledgement"),
        );
      }
      try {
        await this.ensureConnected();
      } catch {
        // The forced disconnect may have rejected an in-flight connect
        // attempt whose settled promise ensureConnected replays; one fresh
        // attempt follows it so the retry actually reaches the wire.
        await this.ensureConnected();
      }
      response = await request();
    }
    const runId = String(response.run_id ?? "").trim();
    if (!runId) {
      throw new Error("Gateway chat command returned no run_id");
    }
    return {
      runId,
      conversationId:
        String(response.conversation_id ?? "").trim() || input.conversationId?.trim() || "",
      acceptedSeq:
        typeof response.accepted_seq === "number" && Number.isFinite(response.accepted_seq)
          ? response.accepted_seq
          : 0,
    };
  }

  // Persistent per-conversation stream subscription with built-in resume.
  subscribeConversationStream(
    conversationId: string,
    handlers: ConversationStreamHandlers,
  ): () => void {
    const cleanup = this.conversationStreams.subscribe(conversationId, handlers);
    // Establish the connection (and thereby the subscription) eagerly.
    // Authentication is the single connection notification point; subscribe()
    // handles the already-connected case itself, so replaying handleConnected
    // here would issue every chat.subscribe twice.
    void this.ensureConnected().catch(() => {
      this.scheduleReconnect();
    });
    return cleanup;
  }

  subscribeChatActivity(listener: ChatActivityListener): () => void {
    this.chatActivityListeners.add(listener);
    return () => {
      this.chatActivityListeners.delete(listener);
    };
  }

  // Authenticated-connection state: `true` fires when auth completes (the
  // same point conversation streams resume), `false` when the socket drops.
  // Late subscribers immediately receive the current state.
  subscribeConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  // On-demand snapshot of every active run (same items as history.list's
  // running_conversations, without the list).
  async listChatActivities(): Promise<RunningConversationSummary[]> {
    const response = await this.requestWithRecovery<{
      running_conversations?: RunningConversationSummary[];
    }>("chat.activities", {});
    return Array.isArray(response?.running_conversations) ? response.running_conversations : [];
  }

  // Re-issue chat.subscribe for a subscribed conversation from its cursor
  // (gap-recovery path); no-op when the conversation is not subscribed.
  resyncConversation(conversationId: string): void {
    this.conversationStreams.resync(conversationId);
  }

  subscribeChatCommandUpdates(listener: ChatCommandUpdateListener): () => void {
    this.chatCommandUpdateListeners.add(listener);
    return () => {
      this.chatCommandUpdateListeners.delete(listener);
    };
  }

  async cancelChat(conversationId: string, runId?: string): Promise<void> {
    const normalized = conversationId.trim();
    if (!normalized) {
      return;
    }
    await this.request("chat.cancel", {
      conversation_id: normalized,
      run_id: runId?.trim() || undefined,
    });
  }

  async processSnapshot(): Promise<ManagedProcessStatePayload> {
    const payload = await this.requestWithRecovery<RawManagedProcessStatePayload>(
      "process.snapshot",
      {},
    );
    const state = normalizeManagedProcessState(payload ?? {});
    this.emitProcessState(state);
    return state;
  }

  async processStop(processId: string): Promise<ManagedProcessStatePayload | null> {
    const payload = await this.requestWithRecovery<RawManagedProcessOpPayload>("process.stop", {
      process_id: processId,
    });
    return payload?.state ? normalizeManagedProcessState(payload.state) : null;
  }

  async processClear(processId?: string): Promise<ManagedProcessStatePayload | null> {
    const payload = await this.requestWithRecovery<RawManagedProcessOpPayload>(
      "process.clear",
      processId ? { process_id: processId } : {},
    );
    return payload?.state ? normalizeManagedProcessState(payload.state) : null;
  }

  async processReadLog(processId: string, maxBytes?: number): Promise<ManagedProcessLogPayload> {
    const payload = await this.requestWithRecovery<RawManagedProcessOpPayload>(
      "process.read_log",
      maxBytes ? { process_id: processId, max_bytes: maxBytes } : { process_id: processId },
    );
    return {
      content: String(payload?.log_content ?? ""),
      logPath: String(payload?.log_path ?? ""),
      truncated: payload?.log_truncated === true,
    };
  }

  async cronManage(payload: CronManagePayload): Promise<CronManageResponse> {
    return this.request<CronManageResponse>("cron.manage", payload);
  }

  async memoryManage<T = unknown>(payload: MemoryManagePayload): Promise<T> {
    if (shouldRecoverMemoryManageRequest(payload)) {
      return this.requestWithRecovery<T>("memory.manage", payload);
    }
    return this.request<T>("memory.manage", payload);
  }

  async gitRequest<T = unknown>(
    action: string,
    workdir: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const requestType = `git.${action}`;
    if (
      action === "status" ||
      action === "branches" ||
      action === "diff" ||
      action === "log" ||
      action === "commit_details" ||
      action === "compare_commit_with_remote" ||
      action === "commit_diff"
    ) {
      return this.requestWithRecovery<T>(requestType, { workdir, args });
    }
    return this.request<T>(requestType, { workdir, args });
  }

  async sftpList(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpListResponse> {
    return normalizeSftpListResponse(
      await this.request<RawSftpResponse>("sftp.list", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path ?? ""),
      }),
    );
  }

  async sftpStat(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpStatResponse> {
    return normalizeSftpStatResponse(
      await this.request<RawSftpResponse>("sftp.stat", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path ?? ""),
      }),
    );
  }

  async sftpMkdir(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
  }): Promise<SftpActionResponse> {
    return normalizeSftpActionResponse(
      await this.request<RawSftpResponse>("sftp.mkdir", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path),
      }),
    );
  }

  async sftpRename(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    fromPath: string;
    toPath: string;
  }): Promise<SftpActionResponse> {
    return normalizeSftpActionResponse(
      await this.request<RawSftpResponse>("sftp.rename", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: params.side,
        direction: params.side,
        from_path: params.fromPath,
        to_path: params.toPath,
      }),
    );
  }

  async sftpDelete(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
    recursive?: boolean;
  }): Promise<SftpActionResponse> {
    return normalizeSftpActionResponse(
      await this.request<RawSftpResponse>("sftp.delete", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path),
        recursive: params.recursive ?? false,
      }),
    );
  }

  async sftpTransfer(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    direction: "upload" | "download";
    sourcePath: string;
    targetPath: string;
    recursive?: boolean;
    overwrite?: boolean;
  }): Promise<SftpTransferResponse> {
    return normalizeSftpTransferResponse(
      await this.request<RawSftpResponse>("sftp.transfer", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        direction: params.direction,
        from_path: params.sourcePath,
        target_path: params.targetPath,
        recursive: params.recursive ?? false,
        overwrite: params.overwrite ?? false,
      }),
    );
  }

  async sftpCancelTransfer(params: { sessionId: string; transferId: string }): Promise<void> {
    await this.request("sftp.cancel", {
      session_id: params.sessionId,
      from_path: params.transferId,
    });
  }

  async terminalShellOptions(): Promise<TerminalShellOptions> {
    return normalizeTerminalShellOptions(
      await this.requestWithRecovery<RawTerminalResponse>("terminal.shell_options", {}),
    );
  }

  async listTerminals(projectPathKey?: string): Promise<TerminalSession[]> {
    const projectKey = projectPathKey?.trim() ?? "";
    const response = await this.requestWithRecovery<RawTerminalResponse>(
      "terminal.list",
      projectKey ? { project_path_key: projectKey } : {},
    );
    return (response.sessions ?? []).map(normalizeTerminalSession);
  }

  async createTerminal(params: {
    cwd: string;
    projectPathKey: string;
    shell?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSnapshot> {
    return normalizeTerminalSnapshot(
      await this.request<RawTerminalResponse>("terminal.create", {
        cwd: params.cwd,
        project_path_key: params.projectPathKey,
        shell: params.shell,
        title: params.title,
        cols: params.cols,
        rows: params.rows,
      }),
    );
  }

  async createSshTerminal(params: {
    cwd: string;
    projectPathKey: string;
    hostId: string;
    title?: string;
    cols?: number;
    rows?: number;
    sftpEnabled?: boolean;
  }): Promise<TerminalSshCreateResult> {
    return normalizeTerminalSshCreateResult(
      await this.request<RawTerminalResponse>("terminal.create_ssh", {
        cwd: params.cwd,
        project_path_key: params.projectPathKey,
        ssh_host_id: params.hostId,
        title: params.title,
        cols: params.cols,
        rows: params.rows,
        sftp_enabled: params.sftpEnabled ?? false,
      }),
    );
  }

  async answerSshTerminalPrompt(params: {
    promptId: string;
    answer?: string;
    trustHostKey?: boolean;
  }): Promise<TerminalSshCreateResult> {
    return normalizeTerminalSshCreateResult(
      await this.request<RawTerminalResponse>("terminal.answer_ssh_prompt", {
        prompt_id: params.promptId,
        prompt_answer: params.answer,
        trust_host_key: params.trustHostKey,
      }),
    );
  }

  async cancelSshTerminalPrompt(promptId: string): Promise<void> {
    await this.request("terminal.cancel_ssh_prompt", {
      prompt_id: promptId,
    });
  }

  async sshTerminalLatency(
    sessionId: string,
    projectPathKey?: string,
  ): Promise<TerminalSshLatency> {
    const latency = normalizeTerminalSshLatency(
      await this.request<RawTerminalResponse>("terminal.ssh_latency", {
        session_id: sessionId,
        project_path_key: projectPathKey,
      }),
    );
    return { ...latency, sessionId };
  }

  async listSshTerminalTabs(projectPathKey: string): Promise<SshTerminalTabsSnapshot> {
    const response = await this.requestWithRecovery<RawTerminalResponse>("terminal.ssh_tabs_list", {
      project_path_key: projectPathKey,
    });
    return normalizeSshTerminalTabsSnapshot(response.sshTabs ?? response.ssh_tabs);
  }

  async openSshTerminalTab(params: {
    sessionId: string;
    kind: SshTerminalTabKind;
  }): Promise<SshTerminalTabsSnapshot> {
    const response = await this.request<RawTerminalResponse>("terminal.ssh_tab_open", {
      session_id: params.sessionId,
      tab_kind: params.kind,
    });
    return normalizeSshTerminalTabsSnapshot(response.sshTabs ?? response.ssh_tabs);
  }

  async closeSshTerminalTab(tabId: string): Promise<SshTerminalTabsSnapshot> {
    const response = await this.request<RawTerminalResponse>("terminal.ssh_tab_close", {
      tab_id: tabId,
    });
    return normalizeSshTerminalTabsSnapshot(response.sshTabs ?? response.ssh_tabs);
  }

  async renameTerminal(
    sessionId: string,
    title: string,
    projectPathKey?: string,
  ): Promise<TerminalSession> {
    const response = await this.request<RawTerminalResponse>("terminal.rename", {
      session_id: sessionId,
      project_path_key: projectPathKey,
      title,
    });
    if (!response.session) {
      throw new Error("Terminal response did not include a session");
    }
    return normalizeTerminalSession(response.session);
  }

  async closeTerminal(sessionId: string, projectPathKey?: string): Promise<TerminalSession> {
    const response = await this.request<RawTerminalResponse>("terminal.close", {
      session_id: sessionId,
      project_path_key: projectPathKey,
    });
    if (!response.session) {
      throw new Error("Terminal response did not include a session");
    }
    return normalizeTerminalSession(response.session);
  }

  async closeProjectTerminals(projectPathKey: string): Promise<TerminalSession[]> {
    const response = await this.request<RawTerminalResponse>("terminal.close_project", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeTerminalSession);
  }

  async createTunnel(input: TunnelCreateInput): Promise<void> {
    const payload: Record<string, unknown> = {
      target_url: input.targetUrl,
      ttl_seconds: input.ttlSeconds,
    };
    const name = input.name?.trim();
    if (name) {
      payload.name = name;
    }
    const projectPathKey = input.projectPathKey?.trim();
    if (projectPathKey) {
      payload.project_path_key = projectPathKey;
    }
    await this.request("tunnel.create", payload);
  }

  async updateTunnel(input: TunnelUpdateInput): Promise<void> {
    const payload: Record<string, unknown> = {
      tunnel_id: input.id,
      target_url: input.targetUrl,
    };
    // Omitting ttl_seconds keeps the current expiry; sending it re-buckets
    // the expiry from now.
    if (input.ttlSeconds !== undefined) {
      payload.ttl_seconds = input.ttlSeconds;
    }
    const name = input.name?.trim();
    if (name) {
      payload.name = name;
    }
    const projectPathKey = input.projectPathKey?.trim();
    if (projectPathKey) {
      payload.project_path_key = projectPathKey;
    }
    await this.request("tunnel.update", payload);
  }

  async closeTunnel(id: string): Promise<void> {
    await this.request("tunnel.close", { tunnel_id: id });
  }

  async checkTunnel(id?: string): Promise<void> {
    const payload: Record<string, unknown> = {};
    const tunnelId = id?.trim();
    if (tunnelId) {
      payload.tunnel_id = tunnelId;
    }
    await this.request("tunnel.check", payload);
  }

  async listHistory(
    page: number,
    pageSize: number,
    filter?: HistoryListFilter,
  ): Promise<HistoryList> {
    const payload: { page: number; page_size: number; cwd?: string; cwd_empty?: boolean } = {
      page: normalizeHistoryListPage(page),
      page_size: normalizeHistoryListPageSize(pageSize),
    };
    const cwd = filter?.cwd?.trim();
    if (cwd) {
      payload.cwd = cwd;
    }
    if (filter?.cwdEmpty === true) {
      payload.cwd_empty = true;
    }
    // running_conversations 由 chat_activities 帧提供：并行取回合并，返回形状不变。
    const [list, runningConversations] = await Promise.all([
      this.requestWithRecovery<HistoryList>("history.list", payload),
      this.listChatActivities().catch(() => [] as RunningConversationSummary[]),
    ]);
    return { ...list, running_conversations: runningConversations };
  }

  async listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse> {
    const response = await this.requestWithRecovery<{
      workdirs?: Array<{ path?: string; conversation_count?: number; updated_at?: number }>;
    }>("history.workdirs", {});
    return {
      workdirs: (response.workdirs ?? []).map((item) => ({
        path: item.path ?? "",
        conversationCount: item.conversation_count ?? 0,
        updatedAt: item.updated_at ?? 0,
      })),
    };
  }

  async listSharedHistory(page: number, pageSize: number): Promise<HistoryList> {
    return this.requestWithRecovery<HistoryList>("history.shared_list", {
      page: normalizeHistoryListPage(page),
      page_size: normalizeHistoryListPageSize(pageSize),
    });
  }

  async getHistory(conversationId: string, options?: HistoryGetOptions): Promise<HistoryDetail> {
    return this.requestWithRecovery<HistoryDetail>("history.get", {
      conversation_id: conversationId,
      max_messages: options?.maxMessages,
    });
  }

  async getHistoryPrefix(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
    options?: HistoryGetOptions,
  ): Promise<HistoryDetail> {
    return this.requestWithRecovery<HistoryDetail>("history.prefix", {
      conversation_id: conversationId,
      max_messages: options?.maxMessages,
      base_message_ref: buildHistoryMessageRefPayload(baseMessageRef),
    });
  }

  async renameHistory(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.rename", {
      conversation_id: conversationId,
      title,
    });
  }

  async branchHistory(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
  ): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.branch", {
      conversation_id: conversationId,
      base_message_ref: buildHistoryMessageRefPayload(baseMessageRef),
    });
  }

  async pinHistory(conversationId: string, isPinned: boolean): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.pin", {
      conversation_id: conversationId,
      is_pinned: isPinned,
    });
  }

  async getHistoryShare(conversationId: string): Promise<HistoryShareStatus> {
    return this.requestWithRecovery<HistoryShareStatus>("history.share.get", {
      conversation_id: conversationId,
    });
  }

  async setHistoryShare(
    conversationId: string,
    enabled: boolean,
    options?: { redactToolContent?: boolean },
  ): Promise<HistoryShareStatus> {
    const payload: Record<string, unknown> = {
      conversation_id: conversationId,
      enabled,
    };
    if (typeof options?.redactToolContent === "boolean") {
      payload.redact_tool_content = options.redactToolContent;
    }
    return this.request<HistoryShareStatus>("history.share.set", payload);
  }

  async deleteHistory(conversationId: string): Promise<void> {
    await this.request("history.delete", {
      conversation_id: conversationId,
    });
  }

  async listProviders(): Promise<GatewayProviderSummary[]> {
    return this.requestWithRecovery<GatewayProviderSummary[]>("providers.list", {});
  }

  async getSettings(): Promise<GatewaySettingsSyncPayload> {
    return this.requestWithRecovery<GatewaySettingsSyncPayload>("settings.get", {});
  }

  async updateSettings(payload: GatewaySettingsSyncUpdatePayload): Promise<void> {
    const response = await this.request<GatewaySettingsUpdateResponse>("settings.update", payload);
    if (response?.accepted === false) {
      throw new Error(
        response.message?.trim() || "SSH 设置已在另一端更新，已刷新为最新状态，请重新提交。",
      );
    }
  }

  async resetSshKnownHost(params: {
    host: string;
    port: number;
  }): Promise<SshKnownHostResetResult> {
    return this.request<SshKnownHostResetResult>("settings.ssh_known_host.reset", {
      host: params.host,
      port: params.port,
    });
  }

  async listSkillFiles(): Promise<SkillListResponse> {
    return this.requestWithRecovery<SkillListResponse>("skills.list", {});
  }

  async manageSkill<T = unknown>(payload: SkillManagePayload): Promise<T> {
    return this.request<T>("skills.manage", payload);
  }

  async listMentionFiles(
    workdir: string,
    maxResults?: number,
    query?: string,
    showHidden?: boolean,
  ): Promise<MentionListResponse> {
    return this.requestWithRecovery<MentionListResponse>("mentions.list", {
      workdir,
      max_results: maxResults,
      query,
      show_hidden: showHidden,
    });
  }

  async listFsRoots(): Promise<FsRootsResponse> {
    return this.requestWithRecovery<FsRootsResponse>("fs.roots", {});
  }

  async listDirs(path: string, maxResults?: number): Promise<FsListDirsResponse> {
    return this.requestWithRecovery<FsListDirsResponse>("fs.list_dirs", {
      path,
      max_results: maxResults,
    });
  }

  async createProjectFolder(parent: string, name: string): Promise<CreateProjectFolderResponse> {
    return this.request<CreateProjectFolderResponse>("fs.create_project_folder", {
      parent,
      name,
    });
  }

  async listFiles(
    workdir: string,
    path?: string,
    depth?: number,
    offset?: number,
    maxResults?: number,
    showHidden?: boolean,
  ): Promise<FsListResponse> {
    return this.requestWithRecovery<FsListResponse>("fs.list", {
      workdir,
      path,
      depth,
      offset,
      max_results: maxResults,
      show_hidden: showHidden,
    });
  }

  async writeTextFile(params: {
    workdir: string;
    path: string;
    content: string;
    mode?: string;
    expectedMtimeMs?: number;
    expectedContentHash?: string;
  }): Promise<FsWriteTextResponse> {
    return this.request<FsWriteTextResponse>("fs.write_text", {
      workdir: params.workdir,
      path: params.path,
      content: params.content,
      mode: params.mode ?? "rewrite",
      expected_mtime_ms: params.expectedMtimeMs,
      expected_content_hash: params.expectedContentHash,
    });
  }

  async readEditableTextFile(workdir: string, path: string): Promise<FsReadEditableTextResponse> {
    return this.request<FsReadEditableTextResponse>("fs.read_editable_text", {
      workdir,
      path,
    });
  }

  async readWorkspaceImageFile(
    workdir: string,
    path: string,
  ): Promise<FsReadWorkspaceImageResponse> {
    return this.request<FsReadWorkspaceImageResponse>("fs.read_workspace_image", {
      workdir,
      path,
    });
  }

  async createDir(workdir: string, path: string): Promise<FsCreateDirResponse> {
    return this.request<FsCreateDirResponse>("fs.create_dir", { workdir, path });
  }

  async renamePath(workdir: string, fromPath: string, toPath: string): Promise<FsRenameResponse> {
    return this.request<FsRenameResponse>("fs.rename", {
      workdir,
      from_path: fromPath,
      to_path: toPath,
    });
  }

  async deletePath(workdir: string, path: string): Promise<FsDeleteResponse> {
    return this.request<FsDeleteResponse>("fs.delete", { workdir, path });
  }

  async readUploadedImagePreview(
    workdir: string,
    absolutePath: string,
  ): Promise<UploadedImagePreviewResponse> {
    return this.requestWithRecovery<UploadedImagePreviewResponse>("files.preview", {
      workdir,
      absolute_path: absolutePath,
    });
  }

  async readSkillMetadata(path: string): Promise<SkillMetadataResponse> {
    return this.requestWithRecovery<SkillMetadataResponse>("skills.read-metadata", { path });
  }

  async readSkillText(path: string, offset?: number, length?: number): Promise<SkillTextResponse> {
    return this.requestWithRecovery<SkillTextResponse>("skills.read-text", {
      path,
      offset,
      length,
    });
  }

  async getProviderModels(
    type: string,
    baseUrl: string,
    apiKey: string,
    useSystemProxy = false,
  ): Promise<unknown> {
    return this.requestWithRecovery("provider.models", {
      type,
      base_url: baseUrl,
      api_key: apiKey,
      use_system_proxy: useSystemProxy,
    });
  }

  dispose() {
    this.disposed = true;
    this.terminalStream.dispose();
    this.uninstallReconnectWakeups();
    this.clearReconnectTimer();
    this.clearReconnectNoticeTimer();
    this.stopStatusPolling();
    this.handleDisconnect(new Error("Gateway WebSocket client disposed"));
  }

  private startStatusPolling() {
    this.stopStatusPolling();
    this.statusPollingActive = true;
    void this.refreshStatus();
    this.scheduleNextStatusPoll();
  }

  private stopStatusPolling() {
    this.statusPollingActive = false;
    if (this.statusPollTimer !== null) {
      const host = getRuntimeHost();
      host.clearTimeout(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  private scheduleNextStatusPoll() {
    if (this.disposed || !this.statusPollingActive || this.statusPollTimer !== null) {
      return;
    }
    const host = getRuntimeHost();
    const delay =
      this.lastStatus !== null && this.lastStatus.online === false
        ? STATUS_POLL_OFFLINE_INTERVAL_MS
        : STATUS_POLL_INTERVAL_MS;
    this.statusPollTimer = host.setTimeout(() => {
      this.statusPollTimer = null;
      void this.refreshStatus().finally(() => this.scheduleNextStatusPoll());
    }, delay);
  }

  private installReconnectWakeups() {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", this.reconnectWakeup);
      window.addEventListener("focus", this.reconnectWakeup);
      window.addEventListener("pageshow", this.reconnectWakeup);
      window.addEventListener("pagehide", this.reconnectWakeup);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.reconnectWakeup);
      document.addEventListener("freeze", this.reconnectWakeup as EventListener);
      document.addEventListener("resume", this.reconnectWakeup as EventListener);
    }
  }

  private uninstallReconnectWakeups() {
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", this.reconnectWakeup);
      window.removeEventListener("focus", this.reconnectWakeup);
      window.removeEventListener("pageshow", this.reconnectWakeup);
      window.removeEventListener("pagehide", this.reconnectWakeup);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.reconnectWakeup);
      document.removeEventListener("freeze", this.reconnectWakeup as EventListener);
      document.removeEventListener("resume", this.reconnectWakeup as EventListener);
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      const host = getRuntimeHost();
      host.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearReconnectNoticeTimer() {
    if (this.reconnectNoticeTimer !== null) {
      const host = getRuntimeHost();
      host.clearTimeout(this.reconnectNoticeTimer);
      this.reconnectNoticeTimer = null;
    }
  }

  private scheduleReconnectNotice() {
    if (this.reconnectNoticeTimer !== null || this.disposed || this.statusListeners.size === 0) {
      return;
    }
    const host = getRuntimeHost();
    this.reconnectNoticeTimer = host.setTimeout(() => {
      this.reconnectNoticeTimer = null;
      if (
        this.disposed ||
        this.statusListeners.size === 0 ||
        (this.socket?.readyState === WebSocket.OPEN && this.authenticated)
      ) {
        return;
      }
      if (isDocumentHidden()) {
        // Deferred: the wakeup handler re-arms this notice and only a failed
        // post-wake reconnect gets to paint the offline banner.
        this.offlineReassessmentPending = true;
        return;
      }
      this.emitStatus(
        this.lastStatus
          ? {
              ...this.lastStatus,
              online: false,
            }
          : null,
        "Gateway 正在重新连接...",
      );
    }, RECONNECT_NOTICE_DELAY_MS);
  }

  private shouldMaintainConnection() {
    return (
      !this.disposed &&
      this.token.trim() !== "" &&
      (this.pending.size > 0 ||
        this.statusListeners.size > 0 ||
        this.historyListeners.size > 0 ||
        this.settingsListeners.size > 0 ||
        this.terminalListeners.size > 0 ||
        this.sftpTransferListeners.size > 0 ||
        this.chatActivityListeners.size > 0 ||
        this.tunnelStateListeners.size > 0 ||
        this.workspaceActivityListeners.size > 0 ||
        this.conversationStreams.size > 0)
    );
  }

  private scheduleReconnect(delayMs?: number) {
    if (!this.shouldMaintainConnection()) {
      return;
    }
    // 鉴权已被服务端拒绝：坏 token 的自动重连只会撞上同一个 4401。
    if (this.authRejected) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      return;
    }
    if (this.connectPromise || this.reconnecting || this.reconnectTimer !== null) {
      return;
    }

    const baseDelay =
      typeof delayMs === "number"
        ? delayMs
        : Math.min(
            RECONNECT_MAX_DELAY_MS,
            RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(this.reconnectAttempt, 5),
          );
    const jitter =
      baseDelay > 0 ? Math.floor(Math.random() * Math.min(500, Math.max(1, baseDelay))) : 0;
    const host = getRuntimeHost();
    this.reconnectTimer = host.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow();
    }, baseDelay + jitter);
  }

  private async reconnectNow() {
    if (!this.shouldMaintainConnection()) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      return;
    }
    if (this.reconnecting) {
      return;
    }

    this.reconnecting = true;
    try {
      await this.ensureConnected();
      this.clearReconnectNoticeTimer();
      this.reconnectAttempt = 0;
      if (this.statusListeners.size > 0) {
        void this.refreshStatus();
      }
    } catch {
      this.reconnectAttempt += 1;
      this.scheduleReconnect();
    } finally {
      this.reconnecting = false;
      if (
        this.shouldMaintainConnection() &&
        !(this.socket?.readyState === WebSocket.OPEN && this.authenticated)
      ) {
        this.scheduleReconnect();
      }
    }
  }

  // The transport is demonstrably alive while frames keep arriving; a starved
  // status.get during a chat.event burst must not flip the UI to offline.
  private hasFreshInboundActivity() {
    return (
      this.socket !== null &&
      this.authenticated &&
      this.socket.readyState === WebSocket.OPEN &&
      this.lastInboundAt > 0 &&
      Date.now() - this.lastInboundAt < SOCKET_INBOUND_STALL_MS
    );
  }

  private async refreshStatus() {
    if (this.statusRefreshInFlight) {
      return;
    }
    this.statusRefreshInFlight = true;
    try {
      const status = await this.getStatus();
      this.clearReconnectNoticeTimer();
      this.emitStatus(status, null);
    } catch (error) {
      if (isRecoverableGatewayTransportError(error) && this.shouldMaintainConnection()) {
        this.scheduleReconnect();
        this.scheduleReconnectNotice();
        return;
      }
      if (isRequestTimeoutError(error) && this.hasFreshInboundActivity()) {
        // Keep the last known status; the next poll retries.
        return;
      }
      if (isDocumentHidden()) {
        // Keep the last visible status; the foreground wakeup rechecks
        // before any offline verdict is painted.
        this.offlineReassessmentPending = true;
        return;
      }
      const message = asErrorMessage(error, "status request failed");
      const offlineStatus =
        this.lastStatus !== null
          ? {
              ...this.lastStatus,
              online: false,
            }
          : null;
      this.lastStatus = offlineStatus;
      this.lastStatusError = message;
      this.emitStatus(offlineStatus, message);
    } finally {
      this.statusRefreshInFlight = false;
    }
  }

  private emitStatus(status: AgentStatus | null, error: string | null) {
    // Whatever gets painted is the verdict; any deferred reassessment is moot.
    this.offlineReassessmentPending = false;
    this.lastStatus = status;
    this.lastStatusError = error;
    if (status?.online === false) {
      this.terminalSessionSnapshot.clear();
      // Switch a pending slow poll to the offline fast cadence right away
      // rather than after its remaining (up to 30s) delay.
      if (this.statusPollTimer !== null) {
        const host = getRuntimeHost();
        host.clearTimeout(this.statusPollTimer);
        this.statusPollTimer = null;
        this.scheduleNextStatusPoll();
      }
    }
    for (const listener of this.statusListeners) {
      listener(status, error);
    }
  }

  private emitHistory(event: GatewayHistoryEvent) {
    for (const listener of this.historyListeners) {
      listener(event);
    }
  }

  private emitSettings(event: GatewaySettingsSyncPayload) {
    for (const listener of this.settingsListeners) {
      listener(event);
    }
  }

  private emitTerminal(event: TerminalEvent) {
    applyTerminalSnapshotEvent(this.terminalSessionSnapshot, event);
    for (const listener of this.terminalListeners) {
      listener(event);
    }
  }

  private emitSftpTransfer(event: SftpTransferEvent) {
    for (const listener of this.sftpTransferListeners) {
      listener(event);
    }
  }

  // No server-revision guard here: managed-process revisions are stamped by
  // the desktop agent and persisted across restarts; the mirrored store does
  // its own monotonic filtering.
  private emitProcessState(state: ManagedProcessStatePayload) {
    this.lastProcessState = state;
    for (const listener of this.processStateListeners) {
      listener(state);
    }
  }

  private emitTunnelState(snapshot: TunnelStateSnapshot) {
    // Drop stale/reordered snapshots from the current gateway process.
    if (snapshot.revision <= this.lastTunnelStateServerRevision) {
      return;
    }
    this.lastTunnelStateServerRevision = snapshot.revision;
    this.tunnelStateRevisionCounter += 1;
    const next: TunnelStateSnapshot = {
      ...snapshot,
      revision: this.tunnelStateRevisionCounter,
    };
    this.lastTunnelState = next;
    for (const listener of this.tunnelStateListeners) {
      listener(next);
    }
  }

  private async requestWithRecovery<T>(
    type: string,
    payload: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    try {
      return await this.request<T>(type, payload, options);
    } catch (error) {
      if (!isRecoverableGatewayTransportError(error) || this.disposed) {
        throw error;
      }
      await this.recoverTransport();
      return this.request<T>(type, payload, options);
    }
  }

  private async request<T>(
    type: string,
    payload: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    await this.ensureConnected();
    let agentId = this.activeAgentId;
    if (requestRequiresAgentId(type)) {
      agentId = await this.ensureActiveAgent();
      // 首次自动选中会主动重连，以便只回放目标 Agent 的快照。
      await this.ensureConnected();
    }
    return this.sendConnectedRequest<T>(type, payload, options, agentId);
  }

  private sendConnectedRequest<T>(
    type: string,
    payload: unknown,
    options: GatewayRequestOptions | undefined,
    agentId: string,
  ): Promise<T> {
    const requestId = this.nextRequestId(type);
    return new Promise<T>((resolve, reject) => {
      const host = getRuntimeHost();
      const requestStartedAt = Date.now();
      const timeoutId = host.setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }

        if (this.shouldTreatRequestTimeoutAsTransportStall(requestStartedAt)) {
          this.handleDisconnect(this.buildTransportStallError(`while waiting for ${type}`));
          return;
        }

        this.pending.delete(requestId);
        reject(new Error(`Gateway WebSocket request timed out: ${type}`));
      }, options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve,
        reject,
        timeoutId,
      });

      try {
        this.sendFrame(encodeRequestFrame(requestId, type, payload, agentId));
      } catch (error) {
        host.clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new Error("Gateway WebSocket client has been disposed");
    }
    if (this.token.trim() === "") {
      throw new Error("Gateway token is required");
    }
    if (this.socket && this.authenticated && this.socket.readyState === WebSocket.OPEN) {
      if (this.shouldRecycleAuthenticatedSocket()) {
        this.handleDisconnect(this.buildTransportStallError("before sending a new request"));
      } else {
        return;
      }
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    const socketUrl = buildWebSocketUrl();
    let reconnectAfterTimeout = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      // 显式连接尝试清除鉴权失败标记；自动重连循环不会反复敲门坏 token。
      this.authRejected = false;
      const socket = new WebSocket(socketUrl, GATEWAY_V2_SUBPROTOCOL);
      socket.binaryType = "arraybuffer";
      const host = getRuntimeHost();
      let settled = false;
      let authTimeoutId: number | null = null;
      const clearAttemptTimers = () => {
        host.clearTimeout(connectionTimeoutId);
        if (authTimeoutId !== null) {
          host.clearTimeout(authTimeoutId);
          authTimeoutId = null;
        }
      };
      const rejectOnce = (error: Error) => {
        clearAttemptTimers();
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const connectionTimeoutId = host.setTimeout(() => {
        const error = new Error("Gateway WebSocket connection timed out");
        reconnectAfterTimeout = true;
        rejectOnce(error);
        if (this.socket === socket) {
          this.handleDisconnect(error);
          return;
        }
        socket.onopen = null;
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          // The browser may reject close() while the handshake is between
          // internal states; the detached attempt is still abandoned.
        }
      }, SOCKET_CONNECT_TIMEOUT_MS);

      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      socket.onerror = () => {
        // onclose will drive the actual error propagation
      };
      socket.onclose = (event) => {
        clearAttemptTimers();
        const reason = event.reason.trim() ? ` reason=${event.reason.trim()}` : "";
        const error = new Error(
          `Gateway WebSocket disconnected (code=${event.code} clean=${event.wasClean}${reason})`,
        );
        // A rejected attempt can close after its caller has already opened a
        // replacement socket. Only the socket still owned by this client may
        // tear down shared state; a detached attempt merely settles itself.
        if (this.socket === socket) {
          this.handleDisconnect(error);
        }
        rejectOnce(error);
      };
      socket.onopen = () => {
        if (settled) {
          socket.close();
          return;
        }
        // The transport phase is over: hand the deadline to the auth timer.
        // Left running, the connect timer would always preempt the (longer)
        // auth timeout and cap connect+auth at the connect budget.
        host.clearTimeout(connectionTimeoutId);
        this.socket = socket;
        this.authenticated = false;
        this.lastInboundAt = 0;
        this.clearReconnectTimer();

        const authId = this.nextRequestId("auth");
        authTimeoutId = host.setTimeout(() => {
          this.pending.delete(authId);
          const error = new Error("Gateway WebSocket auth timed out");
          rejectOnce(error);
          if (this.socket === socket) {
            this.handleDisconnect(error);
          } else {
            socket.close();
          }
        }, SOCKET_AUTH_TIMEOUT_MS);

        this.pending.set(authId, {
          resolve: () => {
            clearAttemptTimers();
            this.authenticated = true;
            this.clearReconnectNoticeTimer();
            this.reconnectAttempt = 0;
            this.setConnectionState(true);
            if (this.activeAgentId) {
              this.conversationStreams.handleConnected();
              this.handleWorkspaceActivityConnected();
            } else {
              void this.ensureActiveAgent().catch(() => {
                // 没有可选 Agent 时由具体业务请求展示错误。
              });
            }
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          reject: (reason) => {
            const error = reason instanceof Error ? reason : new Error(String(reason));
            rejectOnce(error);
            if (this.socket === socket) {
              this.handleDisconnect(error);
            } else {
              socket.onclose = null;
              socket.close();
            }
          },
          timeoutId: authTimeoutId,
        });

        this.sendFrame(encodeHelloFrame(authId, this.token));
      };
    }).finally(() => {
      this.connectPromise = null;
      if (reconnectAfterTimeout && !this.disposed) {
        this.scheduleReconnect(0);
      }
    });

    await this.connectPromise;
  }

  // sendFrame 发送一帧已编码的 v2 二进制帧。
  private sendFrame(frame: Uint8Array<ArrayBuffer>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway WebSocket is not connected");
    }
    this.socket.send(frame);
  }

  private handleMessage(raw: unknown) {
    this.markInboundActivity();
    // v2 链路只承载二进制帧；文本帧仅计入存活。
    if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
      return;
    }
    let decoded: DecodedServerFrame | null;
    try {
      decoded = decodeServerFrame(
        decodeServerFrameBinary(raw instanceof ArrayBuffer ? raw : (raw as Uint8Array)),
        { agentOnline: this.lastStatus?.online === true },
      );
    } catch {
      return;
    }
    if (!decoded) {
      return;
    }

    if (decoded.kind === "hello") {
      const pending = this.pending.get(decoded.requestId);
      if (!pending) {
        return;
      }
      const host = getRuntimeHost();
      host.clearTimeout(pending.timeoutId);
      this.pending.delete(decoded.requestId);
      if (decoded.ok) {
        pending.resolve({ ok: true });
      } else {
        // 服务端将以 4401 关闭：标记鉴权失败并阻断自动重连，交由上层展示鉴权错误。
        this.authRejected = true;
        pending.reject(new Error(decoded.message || "unauthorized"));
      }
      return;
    }

    if (decoded.kind === "ping") {
      // 应用层心跳：回送 protobuf pong。
      try {
        this.sendFrame(encodePongFrame(decoded.timestamp || Date.now()));
      } catch {
        // The close handler will drive reconnect if the socket is already gone.
      }
      return;
    }

    if (decoded.kind === "event") {
      if (decoded.type === "status.event" && decoded.agentId) {
        // 打标状态帧始终更新目录；业务监听只接收当前明确目标。
        const nextStatus = decoded.payload as AgentStatus;
        const name = this.agents.get(decoded.agentId)?.name?.trim();
        this.agents.set(decoded.agentId, name ? { ...nextStatus, name } : nextStatus);
        this.emitAgents();
      }
      if (decoded.agentId && !this.activeAgentId) {
        this.bufferAgentEvent(decoded.agentId, decoded.type, decoded.payload);
        return;
      }
      if (decoded.agentId && !this.matchesActiveAgent(decoded.agentId)) {
        return;
      }
      this.handleEvent(decoded.type, decoded.payload);
      return;
    }

    const pending = decoded.requestId ? this.pending.get(decoded.requestId) : null;
    if (!pending) {
      return;
    }
    const host = getRuntimeHost();
    host.clearTimeout(pending.timeoutId);
    this.pending.delete(decoded.requestId);
    if (decoded.kind === "error") {
      pending.reject(new Error(decoded.message || "Request failed"));
      return;
    }
    pending.resolve(decoded.payload);
  }

  // 分发广播事件；payload 已由适配层还原为既有归一化器需要的对象形状。
  private handleEvent(type: string, payload: unknown) {
    if (type === "history.event") {
      const event = payload as GatewayHistoryEvent;
      if (event?.kind === "upsert" || event?.kind === "delete") {
        this.emitHistory(event);
      }
      return;
    }

    if (type === "settings.event") {
      const event = payload as GatewaySettingsSyncPayload;
      if (event && typeof event === "object") {
        this.emitSettings(event);
      }
      return;
    }

    if (type === "terminal.event") {
      const event = normalizeTerminalEvent(payload as RawTerminalEvent);
      if (event) {
        this.emitTerminal(event);
      }
      return;
    }

    if (type === "sftp.event") {
      const event = normalizeSftpTransferEvent(payload as RawSftpEvent);
      if (event) {
        this.emitSftpTransfer(event);
      }
      return;
    }

    if (type === "process.state") {
      const statePayload =
        payload && typeof payload === "object" ? (payload as RawManagedProcessStatePayload) : null;
      if (statePayload) {
        this.emitProcessState(normalizeManagedProcessState(statePayload));
      }
      return;
    }

    if (type === "tunnel.state") {
      const statePayload =
        payload && typeof payload === "object" ? (payload as RawTunnelStatePayload) : null;
      if (statePayload) {
        this.emitTunnelState(normalizeTunnelStateSnapshot(statePayload));
      }
      return;
    }

    if (type === "status.event") {
      const statusPayload =
        payload && typeof payload === "object" ? (payload as AgentStatus) : null;
      if (statusPayload && typeof statusPayload.online === "boolean") {
        this.clearReconnectNoticeTimer();
        this.emitStatus(statusPayload, null);
      }
      return;
    }

    if (type === "workspace.activity") {
      const activityPayload =
        payload && typeof payload === "object" ? (payload as RawWorkspaceActivityPayload) : null;
      const activity = activityPayload ? normalizeWorkspaceActivity(activityPayload) : null;
      if (activity) {
        this.emitWorkspaceActivity(activity);
      }
      return;
    }

    if (type === "chat_queue.event") {
      const snapshot = normalizeChatQueueEvent(payload as RawChatQueueEvent);
      if (snapshot) {
        this.emitChatQueue(snapshot);
      }
      return;
    }

    if (type === "chat.event") {
      this.conversationStreams.handleChatEvent(payload);
      return;
    }

    if (type === "chat.subscription_reset") {
      this.conversationStreams.handleSubscriptionReset(payload);
      return;
    }

    if (type === "chat.activity") {
      const event = normalizeActivityEvent(payload);
      if (event) {
        for (const listener of this.chatActivityListeners) {
          listener(event);
        }
      }
      return;
    }

    if (type === "chat.command_update") {
      const update = normalizeCommandUpdate(payload);
      if (update) {
        for (const listener of this.chatCommandUpdateListeners) {
          listener(update);
        }
      }
    }
  }

  private handleDisconnect(error: Error) {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
    }
    this.socket = null;
    this.authenticated = false;
    this.pendingAgentEvents.clear();
    this.setConnectionState(false);

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      const host = getRuntimeHost();
      host.clearTimeout(entry.timeoutId);
      entry.reject(error);
    }

    // Conversation stream registrations survive the disconnect; they resume
    // with their seq cursors when the socket re-authenticates.
    this.conversationStreams.handleDisconnected();

    if (!this.disposed && this.statusListeners.size > 0) {
      if (isRecoverableGatewayTransportError(error) && this.shouldMaintainConnection()) {
        this.scheduleReconnectNotice();
      } else if (isDocumentHidden()) {
        this.offlineReassessmentPending = true;
      } else {
        this.emitStatus(
          this.lastStatus
            ? {
                ...this.lastStatus,
                online: false,
              }
            : null,
          error.message,
        );
      }
    }
    this.lastInboundAt = 0;
    // A reconnect may land on a restarted gateway whose tunnel.state
    // revisions start over; accept the fresh post-auth snapshot.
    this.lastTunnelStateServerRevision = 0;
    if (!this.disposed) {
      this.scheduleReconnect();
    }
  }

  private markInboundActivity() {
    this.lastInboundAt = Date.now();
  }

  private setConnectionState(connected: boolean) {
    if (this.connectionState === connected) {
      return;
    }
    this.connectionState = connected;
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }

  private emitChatQueue(snapshot: ChatQueueSnapshot) {
    for (const listener of this.chatQueueListeners) {
      listener(snapshot);
    }
  }

  private shouldRecycleAuthenticatedSocket(now = Date.now()) {
    if (
      this.socket === null ||
      !this.authenticated ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.lastInboundAt <= 0
    ) {
      return false;
    }
    if (now - this.lastInboundAt >= SOCKET_INBOUND_STALL_MS) {
      return true;
    }
    return (
      this.lastForegroundWakeupAt > 0 &&
      now - this.lastForegroundWakeupAt <= FOREGROUND_WAKEUP_RECENCY_MS &&
      this.lastInboundAt < this.lastForegroundWakeupAt &&
      now - this.lastInboundAt >= FOREGROUND_SOCKET_RECYCLE_IDLE_MS
    );
  }

  private shouldTreatRequestTimeoutAsTransportStall(requestStartedAt: number) {
    return (
      this.socket !== null &&
      this.authenticated &&
      this.socket.readyState === WebSocket.OPEN &&
      this.lastInboundAt <= requestStartedAt
    );
  }

  private buildTransportStallError(reason: string) {
    return new Error(`Gateway transport stalled ${reason}`.trim());
  }

  private async recoverTransport() {
    await this.ensureConnected();
  }

  private nextRequestId(prefix: string) {
    this.requestSeq += 1;
    return `${prefix}-${Date.now()}-${this.requestSeq}`;
  }
}

export type GatewayWebSocketClientLike = {
  terminalStream: TerminalStreamClient;
  getStatus(): Promise<AgentStatus>;
  prepareChatRuntime(reason?: string): Promise<AgentStatus>;
  // 多 Agent 寻址：活跃 Agent 选择、目录查询与目录订阅。
  getActiveAgent(): string;
  setActiveAgent(agentId: string): void;
  listAgents(): Promise<AgentStatus[]>;
  subscribeAgents(listener: (agents: AgentStatus[]) => void): () => void;
  subscribeStatus(listener: StatusListener): () => void;
  subscribeHistory(listener: HistoryListener): () => void;
  subscribeSettings(listener: SettingsListener): () => void;
  subscribeTerminal(listener: TerminalListener): () => void;
  subscribeSftpTransfers(listener: SftpTransferListener): () => void;
  subscribeChatQueue(listener: ChatQueueListener): () => void;
  subscribeChatActivity(listener: ChatActivityListener): () => void;
  subscribeChatCommandUpdates(listener: ChatCommandUpdateListener): () => void;
  subscribeConnection(listener: (connected: boolean) => void): () => void;
  listChatActivities(): Promise<RunningConversationSummary[]>;
  resyncConversation(conversationId: string): void;
  subscribeConversationStream(
    conversationId: string,
    handlers: ConversationStreamHandlers,
  ): () => void;
  chatCommand(input: GatewayChatCommandInput): Promise<ChatCommandAccepted>;
  cancelChat(conversationId: string, runId?: string): Promise<void>;
  chatQueueGet(conversationId: string): Promise<ChatQueueResponse>;
  chatQueueGetItem(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueRunNow(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueMove(
    conversationId: string,
    itemId: string,
    direction: "up" | "down",
  ): Promise<ChatQueueResponse>;
  chatQueueRemove(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueEditBegin(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueEditCommit(input: {
    conversationId: string;
    itemId: string;
    revision: number;
    draftJson: string;
    uploadedFilesJson: string;
  }): Promise<ChatQueueResponse>;
  chatQueueEditCancel(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  cronManage(payload: CronManagePayload): Promise<CronManageResponse>;
  memoryManage<T = unknown>(payload: MemoryManagePayload): Promise<T>;
  gitRequest<T = unknown>(
    action: string,
    workdir: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
  sftpList(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpListResponse>;
  sftpStat(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpStatResponse>;
  sftpMkdir(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
  }): Promise<SftpActionResponse>;
  sftpRename(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    fromPath: string;
    toPath: string;
  }): Promise<SftpActionResponse>;
  sftpDelete(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
    recursive?: boolean;
  }): Promise<SftpActionResponse>;
  sftpTransfer(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    direction: "upload" | "download";
    sourcePath: string;
    targetPath: string;
    recursive?: boolean;
    overwrite?: boolean;
  }): Promise<SftpTransferResponse>;
  sftpCancelTransfer(params: { sessionId: string; transferId: string }): Promise<void>;
  terminalShellOptions(): Promise<TerminalShellOptions>;
  listTerminals(projectPathKey?: string): Promise<TerminalSession[]>;
  createTerminal(params: {
    cwd: string;
    projectPathKey: string;
    shell?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSnapshot>;
  createSshTerminal(params: {
    cwd: string;
    projectPathKey: string;
    hostId: string;
    title?: string;
    cols?: number;
    rows?: number;
    sftpEnabled?: boolean;
  }): Promise<TerminalSshCreateResult>;
  answerSshTerminalPrompt(params: {
    promptId: string;
    answer?: string;
    trustHostKey?: boolean;
  }): Promise<TerminalSshCreateResult>;
  cancelSshTerminalPrompt(promptId: string): Promise<void>;
  sshTerminalLatency(sessionId: string, projectPathKey?: string): Promise<TerminalSshLatency>;
  listSshTerminalTabs(projectPathKey: string): Promise<SshTerminalTabsSnapshot>;
  openSshTerminalTab(params: {
    sessionId: string;
    kind: SshTerminalTabKind;
  }): Promise<SshTerminalTabsSnapshot>;
  closeSshTerminalTab(tabId: string): Promise<SshTerminalTabsSnapshot>;
  renameTerminal(
    sessionId: string,
    title: string,
    projectPathKey?: string,
  ): Promise<TerminalSession>;
  closeTerminal(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  closeProjectTerminals(projectPathKey: string): Promise<TerminalSession[]>;
  subscribeTunnelState(listener: (snapshot: TunnelStateSnapshot) => void): () => void;
  subscribeProcessState(listener: (state: ManagedProcessStatePayload) => void): () => void;
  processSnapshot(): Promise<ManagedProcessStatePayload>;
  processStop(processId: string): Promise<ManagedProcessStatePayload | null>;
  processClear(processId?: string): Promise<ManagedProcessStatePayload | null>;
  processReadLog(processId: string, maxBytes?: number): Promise<ManagedProcessLogPayload>;
  subscribeWorkspaceActivity(
    workdir: string,
    listener: (event: WorkspaceActivityEventPayload) => void,
  ): () => void;
  createTunnel(input: TunnelCreateInput): Promise<void>;
  updateTunnel(input: TunnelUpdateInput): Promise<void>;
  closeTunnel(id: string): Promise<void>;
  checkTunnel(id?: string): Promise<void>;
  listHistory(page: number, pageSize: number, filter?: HistoryListFilter): Promise<HistoryList>;
  listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse>;
  listSharedHistory(page: number, pageSize: number): Promise<HistoryList>;
  getHistory(conversationId: string, options?: HistoryGetOptions): Promise<HistoryDetail>;
  getHistoryPrefix(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
    options?: HistoryGetOptions,
  ): Promise<HistoryDetail>;
  renameHistory(conversationId: string, title: string): Promise<ConversationSummary>;
  branchHistory(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
  ): Promise<ConversationSummary>;
  pinHistory(conversationId: string, isPinned: boolean): Promise<ConversationSummary>;
  getHistoryShare(conversationId: string): Promise<HistoryShareStatus>;
  setHistoryShare(
    conversationId: string,
    enabled: boolean,
    options?: { redactToolContent?: boolean },
  ): Promise<HistoryShareStatus>;
  deleteHistory(conversationId: string): Promise<void>;
  listProviders(): Promise<GatewayProviderSummary[]>;
  getSettings(): Promise<GatewaySettingsSyncPayload>;
  updateSettings(payload: GatewaySettingsSyncUpdatePayload): Promise<void>;
  resetSshKnownHost(params: { host: string; port: number }): Promise<SshKnownHostResetResult>;
  listSkillFiles(): Promise<SkillListResponse>;
  manageSkill<T = unknown>(payload: SkillManagePayload): Promise<T>;
  listMentionFiles(
    workdir: string,
    maxResults?: number,
    query?: string,
    showHidden?: boolean,
  ): Promise<MentionListResponse>;
  listFsRoots(): Promise<FsRootsResponse>;
  listDirs(path: string, maxResults?: number): Promise<FsListDirsResponse>;
  createProjectFolder(parent: string, name: string): Promise<CreateProjectFolderResponse>;
  listFiles(
    workdir: string,
    path?: string,
    depth?: number,
    offset?: number,
    maxResults?: number,
    showHidden?: boolean,
  ): Promise<FsListResponse>;
  writeTextFile(params: {
    workdir: string;
    path: string;
    content: string;
    mode?: string;
    expectedMtimeMs?: number;
    expectedContentHash?: string;
  }): Promise<FsWriteTextResponse>;
  readEditableTextFile(workdir: string, path: string): Promise<FsReadEditableTextResponse>;
  readWorkspaceImageFile(workdir: string, path: string): Promise<FsReadWorkspaceImageResponse>;
  createDir(workdir: string, path: string): Promise<FsCreateDirResponse>;
  renamePath(workdir: string, fromPath: string, toPath: string): Promise<FsRenameResponse>;
  deletePath(workdir: string, path: string): Promise<FsDeleteResponse>;
  readUploadedImagePreview(
    workdir: string,
    absolutePath: string,
  ): Promise<UploadedImagePreviewResponse>;
  readSkillMetadata(path: string): Promise<SkillMetadataResponse>;
  readSkillText(path: string, offset?: number, length?: number): Promise<SkillTextResponse>;
  getProviderModels(
    type: string,
    baseUrl: string,
    apiKey: string,
    useSystemProxy?: boolean,
  ): Promise<unknown>;
  dispose(): void;
};

let activeClient: GatewayWebSocketClient | null = null;
let activeToken = "";
const clientReplacedListeners = new Set<() => void>();

/**
 * Fires after the singleton client has been replaced (token change). Module
 * scoped stores that subscribed on the old instance re-attach here — a
 * disposed client never delivers events again.
 */
export function onGatewayWebSocketClientReplaced(listener: () => void): () => void {
  clientReplacedListeners.add(listener);
  return () => {
    clientReplacedListeners.delete(listener);
  };
}

export function getGatewayWebSocketClient(token: string): GatewayWebSocketClient {
  const normalizedToken = token.trim();
  if (activeClient && activeToken === normalizedToken) {
    return activeClient;
  }
  const replaced = activeClient !== null;
  activeClient?.dispose();
  activeToken = normalizedToken;
  activeClient = new GatewayWebSocketClient(normalizedToken);
  if (replaced) {
    // The new instance is already installed, so re-entrant
    // getGatewayWebSocketClient calls from listeners hit the fast path.
    for (const listener of clientReplacedListeners) {
      listener();
    }
  }
  return activeClient;
}

export function resetGatewayWebSocketClient() {
  activeClient?.dispose();
  activeClient = null;
  activeToken = "";
}
