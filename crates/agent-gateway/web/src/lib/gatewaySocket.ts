import type {
  GatewaySettingsSyncPayload,
  GatewaySettingsSyncUpdatePayload,
} from "@/lib/settings/sync";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";

import type {
  TerminalEvent,
  TerminalSession,
  TerminalShellOptions,
  TerminalSnapshot,
  TerminalSshCreateResult,
  TerminalSshLatency,
  TerminalSshMetadata,
  TerminalSshPrompt,
} from "@/lib/terminal/types";
import type {
  SftpActionResponse,
  SftpEntry,
  SftpListResponse,
  SftpStatResponse,
  SftpTransfer,
  SftpTransferEvent,
  SftpTransferResponse,
} from "@/lib/sftp/types";

import type {
  AgentStatus,
  ChatControlEvent,
  ChatEvent,
  ConversationSummary,
  GatewayHistoryEvent,
  CronManagePayload,
  CronManageResponse,
  GatewayChatRuntimeControls,
  GatewayProviderSummary,
  GatewaySelectedModel,
  CreateProjectFolderResponse,
  HistoryDetail,
  HistoryList,
  HistoryListFilter,
  HistoryShareStatus,
  HistoryWorkdirsResponse,
  MemoryManagePayload,
} from "./gatewayTypes";

type GatewaySocketEnvelope = {
  id?: string;
  type: string;
  payload?: unknown;
  error?: string;
};

type StatusListener = (status: AgentStatus | null, error: string | null) => void;
type HistoryListener = (event: GatewayHistoryEvent) => void;
type SettingsListener = (event: GatewaySettingsSyncPayload) => void;
type TerminalListener = (event: TerminalEvent) => void;
type SftpTransferListener = (event: SftpTransferEvent) => void;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

type ChatEventStreamOptions = {
  afterSeq?: number;
  signal?: AbortSignal;
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
  entries: Array<{ path: string; kind: "file" | "dir" }>;
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
  entries: Array<{ path: string; kind: "file" | "dir" }>;
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

export type TunnelCreateInput = {
  targetUrl: string;
  name?: string;
  ttlSeconds: 0 | 900 | 3600 | 14400;
  projectPathKey?: string;
};

export type TunnelUpdateInput = {
  id: string;
  targetUrl: string;
  name?: string;
  ttlSeconds: 0 | 900 | 3600 | 14400;
  projectPathKey?: string;
};

export type TunnelSummary = {
  id: string;
  slug: string;
  name: string;
  targetUrl: string;
  publicUrl: string;
  createdAt: number;
  expiresAt: number;
  activeConnections: number;
  status: "active" | "expired" | "offline";
  projectPathKey: string;
};

type RawTunnelSummary = {
  id?: string;
  slug?: string;
  name?: string;
  targetUrl?: string;
  target_url?: string;
  publicUrl?: string;
  public_url?: string;
  createdAt?: number;
  created_at?: number;
  expiresAt?: number;
  expires_at?: number;
  activeConnections?: number;
  active_connections?: number;
  status?: string;
  projectPathKey?: string;
  project_path_key?: string;
};

type RawTunnelResponse = {
  tunnel?: RawTunnelSummary;
  tunnels?: RawTunnelSummary[];
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
  data?: string | null;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
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
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildGatewayApiUrl(pathname: string) {
  const origin = getRuntimeOrigin();
  if (!origin) {
    throw new Error("Gateway API origin is unavailable");
  }
  const url = new URL(origin);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

function createChatClientRequestId(input: GatewayChatCommandInput) {
  const commandType = input.type.trim() || "chat.command";
  const conversationId = input.conversationId?.trim() || "new";
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `webui-${commandType.replace(/[^a-z0-9._-]/gi, "_")}-${conversationId.replace(
    /[^a-z0-9._-]/gi,
    "_",
  )}-${randomPart}`;
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
      base_message_ref: input.baseMessageRef
        ? {
            segment_index: input.baseMessageRef.segmentIndex,
            message_index: input.baseMessageRef.messageIndex,
          }
        : undefined,
    },
  };
}

type ChatCommandResponse = {
  run_id?: string;
  conversation_id?: string;
  accepted_seq?: number;
};

function parseChatSseBlock(block: string): ChatEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  const data = dataLines.join("\n").trim();
  if (!data) {
    return null;
  }
  const decoded = JSON.parse(data) as {
    payload?: unknown;
    seq?: number;
    run_id?: string;
    snapshot_run_id?: string;
    conversation_id?: string;
  };
  const payload =
    decoded.payload && typeof decoded.payload === "object"
      ? ({ ...(decoded.payload as Record<string, unknown>) } as ChatEvent)
      : ({ ...(decoded as Record<string, unknown>) } as ChatEvent);
  if (typeof payload.seq !== "number" && typeof decoded.seq === "number") {
    payload.seq = decoded.seq;
  }
  if (
    !("conversation_id" in payload) &&
    typeof decoded.conversation_id === "string" &&
    decoded.conversation_id.trim()
  ) {
    (payload as ChatEvent & { conversation_id?: string }).conversation_id =
      decoded.conversation_id;
  }
  attachChatEventMetadata(payload, {
    runId: decoded.run_id,
    snapshotRunId: decoded.snapshot_run_id,
  });
  return typeof payload.type === "string" ? payload : null;
}

function attachChatEventMetadata(
  event: ChatEvent,
  metadata: { runId?: string; snapshotRunId?: string },
) {
  const runId = metadata.runId?.trim() ?? "";
  const snapshotRunId = metadata.snapshotRunId?.trim() ?? "";
  if (runId) {
    Object.defineProperty(event, "__gatewayRunId", {
      value: runId,
      enumerable: false,
      configurable: true,
    });
  }
  if (snapshotRunId) {
    Object.defineProperty(event, "__gatewaySnapshotRunId", {
      value: snapshotRunId,
      enumerable: false,
      configurable: true,
    });
  }
}

async function readGatewayHTTPError(response: Response, fallback: string) {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }
  if (raw.trim()) {
    try {
      const decoded = JSON.parse(raw) as { error?: unknown; message?: unknown };
      const message = String(decoded.error ?? decoded.message ?? "").trim();
      if (message) {
        return message;
      }
    } catch {
      return raw.trim();
    }
  }
  return `${fallback} (${response.status})`;
}

async function postGatewayChatCommand<T = unknown>(
  tokenInput: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = tokenInput.trim();
  if (!token) {
    throw new Error("Gateway token is required");
  }
  const response = await fetch(buildGatewayApiUrl("/api/chat/commands").toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-LiveAgent-CSRF": "1",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readGatewayHTTPError(response, "Gateway chat command failed"));
  }
  return (await response.json()) as T;
}

async function* readChatEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
        const event = parseChatSseBlock(block);
        if (event) {
          yield event;
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    const tail = buffer + decoder.decode();
    const event = parseChatSseBlock(tail);
    if (event) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function waitForChatReconnect(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted || delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const host = getRuntimeHost();
    const timeoutId = host.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      host.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function* streamGatewayChatEvents(params: {
  token: string;
  runId?: string;
  conversationId?: string;
  afterSeq?: number;
  signal?: AbortSignal;
}): AsyncGenerator<ChatEvent> {
  const token = params.token.trim();
  if (!token) {
    throw new Error("Gateway token is required");
  }
  const runId = params.runId?.trim() ?? "";
  let conversationId = params.conversationId?.trim() ?? "";
  if (!runId && !conversationId) {
    throw new Error("run_id or conversation_id is required");
  }

  let lastSeq = normalizeAfterSeq(params.afterSeq);
  let reconnectAttempt = 0;
  let terminalSeen = false;
    while (!terminalSeen && !params.signal?.aborted) {
    const eventsUrl = buildGatewayApiUrl("/api/chat/events");
    if (runId) {
      eventsUrl.searchParams.set("run_id", runId);
    }
    if (conversationId) {
      eventsUrl.searchParams.set("conversation_id", conversationId);
    }
    eventsUrl.searchParams.set("after_seq", String(lastSeq));

    let response: Response;
      try {
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        };
        if (lastSeq > 0) {
          headers["Last-Event-ID"] = String(lastSeq);
        }
        response = await fetch(eventsUrl.toString(), {
          method: "GET",
          headers,
          signal: params.signal,
        });
    } catch {
      if (params.signal?.aborted) {
        return;
      }
      const baseDelay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(reconnectAttempt, 5),
      );
      reconnectAttempt += 1;
      const jitter = Math.floor(Math.random() * Math.min(500, Math.max(1, baseDelay)));
      await waitForChatReconnect(baseDelay + jitter, params.signal);
      continue;
    }

    if (!response.ok || !response.body) {
      throw new Error(await readGatewayHTTPError(response, "Gateway chat event stream failed"));
    }

    try {
      for await (const event of readChatEventStream(response.body)) {
        const seq = readChatEventSeq(event);
        if (seq > 0 && seq <= lastSeq) {
          continue;
        }
        if (seq > lastSeq) {
          lastSeq = seq;
        }
        if (event.conversation_id?.trim()) {
          conversationId = event.conversation_id.trim();
        }
        terminalSeen = isTerminalChatEventForStream(event, runId);
        if (isTerminalChatEvent(event) && !terminalSeen) {
          continue;
        }
        reconnectAttempt = 0;
        yield event;
        if (terminalSeen || params.signal?.aborted) {
          break;
        }
      }
    } catch {
      if (params.signal?.aborted) {
        return;
      }
    }

    if (!terminalSeen && !params.signal?.aborted) {
      const baseDelay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(reconnectAttempt, 5),
      );
      reconnectAttempt += 1;
      const jitter = Math.floor(Math.random() * Math.min(500, Math.max(1, baseDelay)));
      await waitForChatReconnect(baseDelay + jitter, params.signal);
    }
  }
}

const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_NOTICE_DELAY_MS = 10_000;
const SOCKET_INBOUND_STALL_MS = 25_000;
const FOREGROUND_SOCKET_RECYCLE_IDLE_MS = 10_000;
const FOREGROUND_WAKEUP_RECENCY_MS = 15_000;

type RuntimeHost = {
  location?: {
    origin?: string;
    href?: string;
  };
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
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

function readChatEventSeq(event: ChatEvent) {
  const seq = event.seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
}

function readChatEventRunId(event: ChatEvent) {
  const runId = (event as ChatEvent & { __gatewayRunId?: unknown }).__gatewayRunId;
  return typeof runId === "string" ? runId.trim() : "";
}

function readChatEventSnapshotRunId(event: ChatEvent) {
  const runId = (event as ChatEvent & { __gatewaySnapshotRunId?: unknown })
    .__gatewaySnapshotRunId;
  return typeof runId === "string" ? runId.trim() : "";
}

function isChatControlEvent(
  event: ChatEvent | null | undefined,
): event is ChatControlEvent {
  switch (event?.type) {
    case "accepted":
    case "user_message":
    case "rebased":
    case "projection_updated":
    case "delivered":
    case "claimed":
    case "starting":
    case "started":
    case "progress":
    case "completed":
    case "failed":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

function isTerminalChatControlEvent(event: ChatEvent | null | undefined) {
  if (!isChatControlEvent(event)) {
    return false;
  }
  return event?.state === "completed" || event?.state === "failed" || event?.state === "cancelled";
}

function isTerminalChatEvent(event: ChatEvent | null | undefined) {
  return event?.type === "done" || event?.type === "error" || isTerminalChatControlEvent(event);
}

function isTerminalChatEventForStream(event: ChatEvent, runId: string) {
  if (!isTerminalChatEvent(event)) {
    return false;
  }
  const eventRunId = readChatEventRunId(event);
  const targetRunId = runId.trim() || readChatEventSnapshotRunId(event);
  if (!targetRunId) {
    return true;
  }
  return eventRunId === "" || eventRunId === targetRunId;
}

function normalizeAfterSeq(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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
    truncated: input.truncated === true,
    outputStartOffset,
    outputEndOffset,
  };
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

function normalizeTerminalEvent(input: RawTerminalEvent): TerminalEvent | null {
  if (!input.session) return null;
  const session = normalizeTerminalSession(input.session);
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    kind: input.kind ?? "",
    sessionId: input.sessionId ?? input.session_id ?? session.id,
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? session.projectPathKey,
    session,
    data: input.data ?? undefined,
    outputStartOffset,
    outputEndOffset,
  };
}

function applyTerminalSnapshotEvent(
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

function normalizeTunnelStatus(input: unknown): TunnelSummary["status"] {
  return input === "expired" || input === "offline" ? input : "active";
}

function fallbackTunnelPublicUrl(slug: string) {
  const origin = getRuntimeOrigin().replace(/\/$/, "");
  return origin && slug ? `${origin}/t/${slug}/` : "";
}

function normalizeTunnelSummary(input: RawTunnelSummary): TunnelSummary {
  const slug = input.slug?.trim() ?? "";
  return {
    id: input.id?.trim() ?? "",
    slug,
    name: input.name?.trim() ?? "",
    targetUrl: input.targetUrl ?? input.target_url ?? "",
    publicUrl: input.publicUrl ?? input.public_url ?? fallbackTunnelPublicUrl(slug),
    createdAt: Number(input.createdAt ?? input.created_at ?? 0),
    expiresAt: Number(input.expiresAt ?? input.expires_at ?? 0),
    activeConnections: Number(input.activeConnections ?? input.active_connections ?? 0),
    status: normalizeTunnelStatus(input.status),
    projectPathKey: (input.projectPathKey ?? input.project_path_key ?? "").trim(),
  };
}

function normalizeTunnelListResponse(input: RawTunnelResponse): TunnelSummary[] {
  return (input.tunnels ?? []).map(normalizeTunnelSummary);
}

function normalizeTunnelResponse(input: RawTunnelResponse): TunnelSummary {
  if (!input.tunnel) {
    throw new Error("Tunnel response did not include a tunnel");
  }
  return normalizeTunnelSummary(input.tunnel);
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

export class GatewayWebSocketClient {
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
  private terminalSessionSnapshot = new Map<string, TerminalSession>();
  private statusPollTimer: number | null = null;
  private lastStatus: AgentStatus | null = null;
  private lastStatusError: string | null = null;
  private lastInboundAt = 0;
  private reconnectTimer: number | null = null;
  private reconnectNoticeTimer: number | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private lastForegroundWakeupAt = 0;
  private prepareRuntimePromise: Promise<AgentStatus> | null = null;
  private readonly reconnectWakeup = (event?: Event) => {
    this.noteForegroundWakeup(event);
  };

  constructor(private readonly token: string) {
    this.installReconnectWakeups();
  }

  noteForegroundWakeup(event?: Event) {
    if (this.disposed || !isForegroundWakeupEvent(event)) {
      return;
    }
    const now = Date.now();
    this.lastForegroundWakeupAt = now;
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.authenticated &&
      this.shouldRecycleAuthenticatedSocket(now)
    ) {
      this.handleDisconnect(this.buildTransportStallError("after page restore"));
      return;
    }
    this.scheduleReconnect(0);
  }

  async getStatus(): Promise<AgentStatus> {
    const status = await this.requestWithRecovery<AgentStatus>("status.get", {});
    this.lastStatus = status;
    this.lastStatusError = null;
    return status;
  }

  async prepareChatRuntime(_reason?: string): Promise<AgentStatus> {
    if (this.prepareRuntimePromise) {
      return this.prepareRuntimePromise;
    }
    this.noteForegroundWakeup();
    this.prepareRuntimePromise = (async () => {
      await this.ensureConnected();
      const status = await this.getStatus();
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

  subscribeSftpTransfers(listener: SftpTransferListener): () => void {
    this.sftpTransferListeners.add(listener);
    return () => {
      this.sftpTransferListeners.delete(listener);
    };
  }

  async *commandChat(input: GatewayChatCommandInput): AsyncGenerator<ChatEvent> {
    const signal = input.signal;
    if (signal?.aborted) {
      return;
    }
    if (this.token.trim() === "") {
      throw new Error("Gateway token is required");
    }

    const commandResponse = await postGatewayChatCommand<ChatCommandResponse>(
      this.token,
      buildChatCommandPayload(input),
      signal,
    );
    const runId = String(commandResponse.run_id ?? "").trim();
    if (!runId) {
      throw new Error("Gateway chat command returned no run_id");
    }
    let conversationId =
      String(commandResponse.conversation_id ?? "").trim() || input.conversationId?.trim() || "";

    const handleAbort = () => {
      void postGatewayChatCommand(
        this.token,
        {
          type: "chat.cancel",
          payload: {
            run_id: runId,
            conversation_id: conversationId,
          },
        },
        undefined,
      ).catch(() => undefined);
    };
    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    try {
      for await (const event of streamGatewayChatEvents({
        token: this.token,
        runId,
        conversationId,
        afterSeq: 0,
        signal,
      })) {
        if (event.conversation_id?.trim()) {
          conversationId = event.conversation_id.trim();
        }
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", handleAbort);
    }
  }

  async *streamChatEvents(
    conversationId: string,
    options?: ChatEventStreamOptions,
  ): AsyncGenerator<ChatEvent> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      throw new Error("conversation_id is required");
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return;
    }
    for await (const event of streamGatewayChatEvents({
      token: this.token,
      conversationId: normalizedConversationId,
      afterSeq: options?.afterSeq,
      signal,
    })) {
      yield event;
    }
  }

  async cancelChat(conversationId: string): Promise<void> {
    const normalized = conversationId.trim();
    if (!normalized) {
      return;
    }
    await postGatewayChatCommand(this.token, {
      type: "chat.cancel",
      payload: {
        conversation_id: normalized,
      },
    });
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

  async snapshotTerminal(
    sessionId: string,
    maxBytes?: number,
    projectPathKey?: string,
  ): Promise<TerminalSnapshot> {
    return normalizeTerminalSnapshot(
      await this.requestWithRecovery<RawTerminalResponse>("terminal.attach", {
        session_id: sessionId,
        project_path_key: projectPathKey,
        max_bytes: maxBytes,
      }),
    );
  }

  async inputTerminal(sessionId: string, data: string, projectPathKey?: string): Promise<void> {
    await this.request("terminal.input", {
      session_id: sessionId,
      project_path_key: projectPathKey,
      data,
    });
  }

  async resizeTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    projectPathKey?: string,
  ): Promise<void> {
    await this.request("terminal.resize", {
      session_id: sessionId,
      project_path_key: projectPathKey,
      cols,
      rows,
    });
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

  async detachTerminal(sessionId: string, projectPathKey?: string): Promise<void> {
    await this.request("terminal.detach", {
      session_id: sessionId,
      project_path_key: projectPathKey,
    });
  }

  async listTunnels(): Promise<TunnelSummary[]> {
    return normalizeTunnelListResponse(
      await this.requestWithRecovery<RawTunnelResponse>("tunnel.list", {}),
    );
  }

  async createTunnel(input: TunnelCreateInput): Promise<TunnelSummary> {
    const payload: Record<string, unknown> = {
      targetUrl: input.targetUrl,
      ttlSeconds: input.ttlSeconds,
      name: input.name,
    };
    if (input.projectPathKey?.trim()) {
      payload.projectPathKey = input.projectPathKey.trim();
    }
    return normalizeTunnelResponse(
      await this.request<RawTunnelResponse>("tunnel.create", payload),
    );
  }

  async updateTunnel(input: TunnelUpdateInput): Promise<TunnelSummary> {
    const payload: Record<string, unknown> = {
      id: input.id,
      targetUrl: input.targetUrl,
      ttlSeconds: input.ttlSeconds,
      name: input.name,
    };
    if (input.projectPathKey?.trim()) {
      payload.projectPathKey = input.projectPathKey.trim();
    }
    return normalizeTunnelResponse(
      await this.request<RawTunnelResponse>("tunnel.update", payload),
    );
  }

  async closeTunnel(id: string): Promise<TunnelSummary> {
    return normalizeTunnelResponse(
      await this.request<RawTunnelResponse>("tunnel.close", {
        id,
      }),
    );
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
    return this.requestWithRecovery<HistoryList>("history.list", payload);
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

  async renameHistory(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.rename", {
      conversation_id: conversationId,
      title,
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
    await this.request("settings.update", payload);
  }

  async resetSshKnownHost(params: { host: string; port: number }): Promise<SshKnownHostResetResult> {
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
  ): Promise<MentionListResponse> {
    return this.requestWithRecovery<MentionListResponse>("mentions.list", {
      workdir,
      max_results: maxResults,
      query,
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
  ): Promise<FsListResponse> {
    return this.requestWithRecovery<FsListResponse>("fs.list", {
      workdir,
      path,
      depth,
      offset,
      max_results: maxResults,
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

  async getProviderModels(type: string, baseUrl: string, apiKey: string): Promise<unknown> {
    return this.requestWithRecovery("provider.models", {
      type,
      base_url: baseUrl,
      api_key: apiKey,
    });
  }

  dispose() {
    this.disposed = true;
    this.uninstallReconnectWakeups();
    this.clearReconnectTimer();
    this.clearReconnectNoticeTimer();
    this.stopStatusPolling();
    this.handleDisconnect(new Error("Gateway WebSocket client disposed"));
  }

  private startStatusPolling() {
    this.stopStatusPolling();
    void this.refreshStatus();
    const host = getRuntimeHost();
    this.statusPollTimer = host.setInterval(() => {
      void this.refreshStatus();
    }, 5_000);
  }

  private stopStatusPolling() {
    if (this.statusPollTimer !== null) {
      const host = getRuntimeHost();
      host.clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
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
        this.sftpTransferListeners.size > 0)
    );
  }

  private scheduleReconnect(delayMs?: number) {
    if (!this.shouldMaintainConnection()) {
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

  private async refreshStatus() {
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
    }
  }

  private emitStatus(status: AgentStatus | null, error: string | null) {
    this.lastStatus = status;
    this.lastStatusError = error;
    if (status?.online === false) {
      this.terminalSessionSnapshot.clear();
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

  private async requestWithRecovery<T>(type: string, payload: unknown): Promise<T> {
    try {
      return await this.request<T>(type, payload);
    } catch (error) {
      if (!isRecoverableGatewayTransportError(error) || this.disposed) {
        throw error;
      }
      await this.recoverTransport();
      return this.request<T>(type, payload);
    }
  }

  private async request<T>(type: string, payload: unknown): Promise<T> {
    await this.ensureConnected();
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
      }, 30_000);

      this.pending.set(requestId, {
        resolve,
        reject,
        timeoutId,
      });

      try {
        this.sendEnvelope({
          id: requestId,
          type,
          payload,
        });
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
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(socketUrl);
      let settled = false;

      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      socket.onerror = () => {
        // onclose will drive the actual error propagation
      };
      socket.onclose = (event) => {
        const reason = event.reason.trim() ? ` reason=${event.reason.trim()}` : "";
        const error = new Error(
          `Gateway WebSocket disconnected (code=${event.code} clean=${event.wasClean}${reason})`,
        );
        this.handleDisconnect(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.onopen = () => {
        this.socket = socket;
        this.authenticated = false;
        this.lastInboundAt = 0;
        this.clearReconnectTimer();

        const authId = this.nextRequestId("auth");
        const host = getRuntimeHost();
        const timeoutId = host.setTimeout(() => {
          this.pending.delete(authId);
          if (!settled) {
            settled = true;
            reject(new Error("Gateway WebSocket auth timed out"));
          }
          socket.close();
        }, 15_000);

        this.pending.set(authId, {
          resolve: () => {
            host.clearTimeout(timeoutId);
            this.authenticated = true;
            this.clearReconnectNoticeTimer();
            this.reconnectAttempt = 0;
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          reject: (reason) => {
            host.clearTimeout(timeoutId);
            if (!settled) {
              settled = true;
              reject(reason);
            }
            socket.close();
          },
          timeoutId,
        });

        this.sendEnvelope({
          id: authId,
          type: "auth",
          payload: {
            token: this.token,
          },
        });
      };
    }).finally(() => {
      this.connectPromise = null;
    });

    await this.connectPromise;
  }

  private sendEnvelope(envelope: GatewaySocketEnvelope) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(envelope));
  }

  private handleMessage(raw: string) {
    this.markInboundActivity();
    let envelope: GatewaySocketEnvelope;
    try {
      envelope = JSON.parse(raw) as GatewaySocketEnvelope;
    } catch {
      return;
    }

    const requestId = typeof envelope.id === "string" ? envelope.id : "";
    if (envelope.type === "ping") {
      try {
        this.sendEnvelope({
          id: this.nextRequestId("pong"),
          type: "pong",
          payload:
            envelope.payload && typeof envelope.payload === "object"
              ? envelope.payload
              : { timestamp: Date.now() },
        });
      } catch {
        // The close handler will drive reconnect if the socket is already gone.
      }
      return;
    }

    if (envelope.type === "history.event") {
      const event = envelope.payload as GatewayHistoryEvent;
      if (
        event?.kind === "upsert" ||
        event?.kind === "delete" ||
        event?.kind === "running" ||
        event?.kind === "idle"
      ) {
        this.emitHistory(event);
      }
      return;
    }

    if (envelope.type === "settings.event") {
      const event = envelope.payload as GatewaySettingsSyncPayload;
      if (event && typeof event === "object") {
        this.emitSettings(event);
      }
      return;
    }

    if (envelope.type === "terminal.event") {
      const event = normalizeTerminalEvent(envelope.payload as RawTerminalEvent);
      if (event) {
        this.emitTerminal(event);
      }
      return;
    }

    if (envelope.type === "sftp.event") {
      const event = normalizeSftpTransferEvent(envelope.payload as RawSftpEvent);
      if (event) {
        this.emitSftpTransfer(event);
      }
      return;
    }

    const pending = requestId ? this.pending.get(requestId) : null;
    if (!pending) {
      return;
    }

    const host = getRuntimeHost();
    host.clearTimeout(pending.timeoutId);
    this.pending.delete(requestId);

    if (envelope.type === "error") {
      pending.reject(
        new Error(typeof envelope.error === "string" ? envelope.error : "Request failed"),
      );
      return;
    }

    pending.resolve(envelope.payload);
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

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      const host = getRuntimeHost();
      host.clearTimeout(entry.timeoutId);
      entry.reject(error);
    }

    if (!this.disposed && this.statusListeners.size > 0) {
      if (isRecoverableGatewayTransportError(error) && this.shouldMaintainConnection()) {
        this.scheduleReconnectNotice();
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
    if (!this.disposed) {
      this.scheduleReconnect();
    }
  }

  private markInboundActivity() {
    this.lastInboundAt = Date.now();
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
  getStatus(): Promise<AgentStatus>;
  prepareChatRuntime(reason?: string): Promise<AgentStatus>;
  subscribeStatus(listener: StatusListener): () => void;
  subscribeHistory(listener: HistoryListener): () => void;
  subscribeSettings(listener: SettingsListener): () => void;
  subscribeTerminal(listener: TerminalListener): () => void;
  subscribeSftpTransfers(listener: SftpTransferListener): () => void;
  commandChat(input: GatewayChatCommandInput): AsyncGenerator<ChatEvent>;
  streamChatEvents(
    conversationId: string,
    options?: ChatEventStreamOptions,
  ): AsyncGenerator<ChatEvent>;
  cancelChat(conversationId: string): Promise<void>;
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
  snapshotTerminal(
    sessionId: string,
    maxBytes?: number,
    projectPathKey?: string,
  ): Promise<TerminalSnapshot>;
  inputTerminal(sessionId: string, data: string, projectPathKey?: string): Promise<void>;
  resizeTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    projectPathKey?: string,
  ): Promise<void>;
  renameTerminal(
    sessionId: string,
    title: string,
    projectPathKey?: string,
  ): Promise<TerminalSession>;
  closeTerminal(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  closeProjectTerminals(projectPathKey: string): Promise<TerminalSession[]>;
  detachTerminal(sessionId: string, projectPathKey?: string): Promise<void>;
  listTunnels(): Promise<TunnelSummary[]>;
  createTunnel(input: TunnelCreateInput): Promise<TunnelSummary>;
  updateTunnel(input: TunnelUpdateInput): Promise<TunnelSummary>;
  closeTunnel(id: string): Promise<TunnelSummary>;
  listHistory(page: number, pageSize: number, filter?: HistoryListFilter): Promise<HistoryList>;
  listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse>;
  listSharedHistory(page: number, pageSize: number): Promise<HistoryList>;
  getHistory(conversationId: string, options?: HistoryGetOptions): Promise<HistoryDetail>;
  renameHistory(conversationId: string, title: string): Promise<ConversationSummary>;
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
  getProviderModels(type: string, baseUrl: string, apiKey: string): Promise<unknown>;
  dispose(): void;
};

type SharedWorkerClientReadyMessage = {
  type: "ready";
  connection_id: string;
  payload: {
    status: AgentStatus | null;
    error: string | null;
  };
};

type SharedWorkerClientResponseMessage = {
  type: "response";
  connection_id: string;
  request_id: string;
  payload?: unknown;
  error?: string;
};

type SharedWorkerClientEventMessage = {
  type: "event";
  connection_id: string;
  event_type: "status" | "history" | "settings" | "terminal" | "sftp";
  payload: unknown;
};

type SharedWorkerClientMessage =
  | SharedWorkerClientReadyMessage
  | SharedWorkerClientResponseMessage
  | SharedWorkerClientEventMessage;

type SharedWorkerClientRequestMessage =
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

function canUseSharedWorker() {
  return typeof window !== "undefined" && typeof SharedWorker === "function";
}

class SharedWorkerGatewayWebSocketClient implements GatewayWebSocketClientLike {
  private readonly worker: SharedWorker;
  private readonly port: MessagePort;
  private readonly connectionID: string;
  private connectPromise: Promise<void>;
  private resolveConnect!: () => void;
  private rejectConnect!: (reason?: unknown) => void;
  private readyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private connectSettled = false;
  private requestSeq = 0;
  private disposed = false;
  private statusRefreshRequested = false;
  private pending = new Map<string, PendingRequest>();
  private statusListeners = new Set<StatusListener>();
  private historyListeners = new Set<HistoryListener>();
  private settingsListeners = new Set<SettingsListener>();
  private terminalListeners = new Set<TerminalListener>();
  private sftpTransferListeners = new Set<SftpTransferListener>();
  private terminalSessionSnapshot = new Map<string, TerminalSession>();
  private lastStatus: AgentStatus | null = null;
  private lastStatusError: string | null = null;
  private readonly workerWakeup = (event?: Event) => {
    this.postWorkerWakeup(event);
  };

  constructor(private readonly token: string) {
    this.connectionID = this.nextRequestId("connection");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });

    this.worker = new SharedWorker(new URL("./gatewaySocket.worker.ts", import.meta.url), {
      name: "liveagent-gateway-websocket",
      type: "module",
    });
    this.port = this.worker.port;
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };
    this.port.onmessageerror = () => {
      this.handleDisconnect(new Error("Gateway SharedWorker message failed"));
    };
    this.port.start();
    this.installWorkerWakeups();
    const host = getRuntimeHost();
    this.readyTimeoutId = host.setTimeout(() => {
      this.handleDisconnect(new Error("Gateway SharedWorker connection timed out"));
    }, 15_000);
    try {
      this.postMessage({
        type: "connect",
        connection_id: this.connectionID,
        token: this.token,
      });
    } catch (error) {
      this.clearReadyTimeout();
      throw error;
    }
  }

  async getStatus(): Promise<AgentStatus> {
    const status = await this.request<AgentStatus>("status.get", {});
    this.statusRefreshRequested = false;
    this.emitStatus(status, null);
    return status;
  }

  async prepareChatRuntime(reason?: string): Promise<AgentStatus> {
    const status = await this.request<AgentStatus>("chat.prepare", { reason: reason ?? "" });
    this.statusRefreshRequested = false;
    this.emitStatus(status, null);
    return status;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    if (this.lastStatus || this.lastStatusError) {
      listener(this.lastStatus, this.lastStatusError);
    } else if (!this.statusRefreshRequested) {
      this.statusRefreshRequested = true;
      void this.refreshStatus();
    }
    return () => {
      this.statusListeners.delete(listener);
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

  subscribeSftpTransfers(listener: SftpTransferListener): () => void {
    this.sftpTransferListeners.add(listener);
    return () => {
      this.sftpTransferListeners.delete(listener);
    };
  }

  async *commandChat(input: GatewayChatCommandInput): AsyncGenerator<ChatEvent> {
    const signal = input.signal;
    if (signal?.aborted) {
      return;
    }
    if (this.token.trim() === "") {
      throw new Error("Gateway token is required");
    }

    const commandResponse = await postGatewayChatCommand<ChatCommandResponse>(
      this.token,
      buildChatCommandPayload(input),
      signal,
    );
    const runId = String(commandResponse.run_id ?? "").trim();
    if (!runId) {
      throw new Error("Gateway chat command returned no run_id");
    }
    let conversationId =
      String(commandResponse.conversation_id ?? "").trim() || input.conversationId?.trim() || "";

    const handleAbort = () => {
      void postGatewayChatCommand(
        this.token,
        {
          type: "chat.cancel",
          payload: {
            run_id: runId,
            conversation_id: conversationId,
          },
        },
        undefined,
      ).catch(() => undefined);
    };
    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    try {
      for await (const event of streamGatewayChatEvents({
        token: this.token,
        runId,
        conversationId,
        afterSeq: 0,
        signal,
      })) {
        if (event.conversation_id?.trim()) {
          conversationId = event.conversation_id.trim();
        }
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", handleAbort);
    }
  }

  async *streamChatEvents(
    conversationId: string,
    options?: ChatEventStreamOptions,
  ): AsyncGenerator<ChatEvent> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      throw new Error("conversation_id is required");
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return;
    }
    for await (const event of streamGatewayChatEvents({
      token: this.token,
      conversationId: normalizedConversationId,
      afterSeq: options?.afterSeq,
      signal,
    })) {
      yield event;
    }
  }

  async cancelChat(conversationId: string): Promise<void> {
    const normalized = conversationId.trim();
    if (!normalized) {
      return;
    }
    await postGatewayChatCommand(this.token, {
      type: "chat.cancel",
      payload: {
        conversation_id: normalized,
      },
    });
  }

  async cronManage(payload: CronManagePayload): Promise<CronManageResponse> {
    return this.request<CronManageResponse>("cron.manage", payload);
  }

  async memoryManage<T = unknown>(payload: MemoryManagePayload): Promise<T> {
    return this.request<T>("memory.manage", payload);
  }

  async gitRequest<T = unknown>(
    action: string,
    workdir: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return this.request<T>(`git.${action}`, { workdir, args });
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
        side: params.side,
        direction: params.side,
        local_path: params.side === "local" ? (params.path ?? "") : "",
        remote_path: params.side === "remote" ? (params.path ?? "") : "",
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
        side: params.side,
        direction: params.side,
        local_path: params.side === "local" ? (params.path ?? "") : "",
        remote_path: params.side === "remote" ? (params.path ?? "") : "",
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
        side: params.side,
        direction: params.side,
        local_path: params.side === "local" ? params.path : "",
        remote_path: params.side === "remote" ? params.path : "",
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
        side: params.side,
        direction: params.side,
        local_path: params.side === "local" ? params.path : "",
        remote_path: params.side === "remote" ? params.path : "",
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
      await this.request<RawTerminalResponse>("terminal.shell_options", {}),
    );
  }

  async listTerminals(projectPathKey?: string): Promise<TerminalSession[]> {
    const projectKey = projectPathKey?.trim() ?? "";
    const response = await this.request<RawTerminalResponse>(
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

  async snapshotTerminal(
    sessionId: string,
    maxBytes?: number,
    projectPathKey?: string,
  ): Promise<TerminalSnapshot> {
    return normalizeTerminalSnapshot(
      await this.request<RawTerminalResponse>("terminal.attach", {
        session_id: sessionId,
        project_path_key: projectPathKey,
        max_bytes: maxBytes,
      }),
    );
  }

  async inputTerminal(sessionId: string, data: string, projectPathKey?: string): Promise<void> {
    await this.request("terminal.input", {
      session_id: sessionId,
      project_path_key: projectPathKey,
      data,
    });
  }

  async resizeTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    projectPathKey?: string,
  ): Promise<void> {
    await this.request("terminal.resize", {
      session_id: sessionId,
      project_path_key: projectPathKey,
      cols,
      rows,
    });
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

  async detachTerminal(sessionId: string, projectPathKey?: string): Promise<void> {
    await this.request("terminal.detach", {
      session_id: sessionId,
      project_path_key: projectPathKey,
    });
  }

  async listTunnels(): Promise<TunnelSummary[]> {
    return normalizeTunnelListResponse(await this.request<RawTunnelResponse>("tunnel.list", {}));
  }

  async createTunnel(input: TunnelCreateInput): Promise<TunnelSummary> {
    const payload: Record<string, unknown> = {
      targetUrl: input.targetUrl,
      ttlSeconds: input.ttlSeconds,
      name: input.name,
    };
    if (input.projectPathKey?.trim()) {
      payload.projectPathKey = input.projectPathKey.trim();
    }
    return normalizeTunnelResponse(
      await this.request<RawTunnelResponse>("tunnel.create", payload),
    );
  }

  async updateTunnel(input: TunnelUpdateInput): Promise<TunnelSummary> {
    const payload: Record<string, unknown> = {
      id: input.id,
      targetUrl: input.targetUrl,
      ttlSeconds: input.ttlSeconds,
      name: input.name,
    };
    if (input.projectPathKey?.trim()) {
      payload.projectPathKey = input.projectPathKey.trim();
    }
    return normalizeTunnelResponse(
      await this.request<RawTunnelResponse>("tunnel.update", payload),
    );
  }

  async closeTunnel(id: string): Promise<TunnelSummary> {
    return normalizeTunnelResponse(
      await this.request<RawTunnelResponse>("tunnel.close", {
        id,
      }),
    );
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
    return this.request<HistoryList>("history.list", payload);
  }

  async listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse> {
    const response = await this.request<{
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
    return this.request<HistoryList>("history.shared_list", {
      page: normalizeHistoryListPage(page),
      page_size: normalizeHistoryListPageSize(pageSize),
    });
  }

  async getHistory(conversationId: string, options?: HistoryGetOptions): Promise<HistoryDetail> {
    return this.request<HistoryDetail>("history.get", {
      conversation_id: conversationId,
      max_messages: options?.maxMessages,
    });
  }

  async renameHistory(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.rename", {
      conversation_id: conversationId,
      title,
    });
  }

  async pinHistory(conversationId: string, isPinned: boolean): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.pin", {
      conversation_id: conversationId,
      is_pinned: isPinned,
    });
  }

  async getHistoryShare(conversationId: string): Promise<HistoryShareStatus> {
    return this.request<HistoryShareStatus>("history.share.get", {
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
    return this.request<GatewayProviderSummary[]>("providers.list", {});
  }

  async getSettings(): Promise<GatewaySettingsSyncPayload> {
    return this.request<GatewaySettingsSyncPayload>("settings.get", {});
  }

  async updateSettings(payload: GatewaySettingsSyncUpdatePayload): Promise<void> {
    await this.request("settings.update", payload);
  }

  async resetSshKnownHost(params: { host: string; port: number }): Promise<SshKnownHostResetResult> {
    return this.request<SshKnownHostResetResult>("settings.ssh_known_host.reset", {
      host: params.host,
      port: params.port,
    });
  }

  async listSkillFiles(): Promise<SkillListResponse> {
    return this.request<SkillListResponse>("skills.list", {});
  }

  async manageSkill<T = unknown>(payload: SkillManagePayload): Promise<T> {
    return this.request<T>("skills.manage", payload);
  }

  async listMentionFiles(
    workdir: string,
    maxResults?: number,
    query?: string,
  ): Promise<MentionListResponse> {
    return this.request<MentionListResponse>("mentions.list", {
      workdir,
      max_results: maxResults,
      query,
    });
  }

  async listFsRoots(): Promise<FsRootsResponse> {
    return this.request<FsRootsResponse>("fs.roots", {});
  }

  async listDirs(path: string, maxResults?: number): Promise<FsListDirsResponse> {
    return this.request<FsListDirsResponse>("fs.list_dirs", {
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
  ): Promise<FsListResponse> {
    return this.request<FsListResponse>("fs.list", {
      workdir,
      path,
      depth,
      offset,
      max_results: maxResults,
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
    return this.request<UploadedImagePreviewResponse>("files.preview", {
      workdir,
      absolute_path: absolutePath,
    });
  }

  async readSkillMetadata(path: string): Promise<SkillMetadataResponse> {
    return this.request<SkillMetadataResponse>("skills.read-metadata", { path });
  }

  async readSkillText(path: string, offset?: number, length?: number): Promise<SkillTextResponse> {
    return this.request<SkillTextResponse>("skills.read-text", {
      path,
      offset,
      length,
    });
  }

  async getProviderModels(type: string, baseUrl: string, apiKey: string): Promise<unknown> {
    return this.request("provider.models", {
      type,
      base_url: baseUrl,
      api_key: apiKey,
    });
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.uninstallWorkerWakeups();
    try {
      this.postMessage({ type: "dispose", connection_id: this.connectionID });
    } catch {
      // The worker connection may already be gone.
    }
    this.port.onmessage = null;
    this.port.onmessageerror = null;
    this.port.close();
    this.handleDisconnect(new Error("Gateway SharedWorker client disposed"));
  }

  private async refreshStatus() {
    try {
      await this.getStatus();
    } catch (error) {
      this.statusRefreshRequested = false;
      const message = asErrorMessage(error, "status request failed");
      const offlineStatus =
        this.lastStatus !== null
          ? {
              ...this.lastStatus,
              online: false,
            }
          : null;
      this.emitStatus(offlineStatus, message);
    }
  }

  private async request<T>(method: string, payload: unknown): Promise<T> {
    await this.ensureConnected();
    if (this.disposed) {
      throw new Error("Gateway SharedWorker client has been disposed");
    }

    const requestId = this.nextRequestId(method);
    return new Promise<T>((resolve, reject) => {
      const host = getRuntimeHost();
      const timeoutId = host.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Gateway SharedWorker request timed out: ${method}`));
      }, 30_000);

      this.pending.set(requestId, { resolve, reject, timeoutId });
      try {
        this.postMessage({
          type: "request",
          connection_id: this.connectionID,
          request_id: requestId,
          method,
          payload,
        });
      } catch (error) {
        host.clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private async ensureConnected() {
    if (this.disposed) {
      throw new Error("Gateway SharedWorker client has been disposed");
    }
    if (this.token.trim() === "") {
      throw new Error("Gateway token is required");
    }
    await this.connectPromise;
  }

  private installWorkerWakeups() {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", this.workerWakeup);
      window.addEventListener("focus", this.workerWakeup);
      window.addEventListener("pageshow", this.workerWakeup);
      window.addEventListener("pagehide", this.workerWakeup);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.workerWakeup);
      document.addEventListener("freeze", this.workerWakeup as EventListener);
      document.addEventListener("resume", this.workerWakeup as EventListener);
    }
  }

  private uninstallWorkerWakeups() {
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", this.workerWakeup);
      window.removeEventListener("focus", this.workerWakeup);
      window.removeEventListener("pageshow", this.workerWakeup);
      window.removeEventListener("pagehide", this.workerWakeup);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.workerWakeup);
      document.removeEventListener("freeze", this.workerWakeup as EventListener);
      document.removeEventListener("resume", this.workerWakeup as EventListener);
    }
  }

  private postWorkerWakeup(event?: Event) {
    if (this.disposed || !isForegroundWakeupEvent(event)) {
      return;
    }
    try {
      this.postMessage({
        type: "wakeup",
        connection_id: this.connectionID,
      });
    } catch {
      this.handleDisconnect(new Error("Gateway SharedWorker wakeup failed"));
    }
  }

  private postMessage(message: SharedWorkerClientRequestMessage) {
    this.port.postMessage(message);
  }

  private handleMessage(raw: unknown) {
    const message = raw as SharedWorkerClientMessage;
    if (!message || typeof message !== "object" || message.connection_id !== this.connectionID) {
      return;
    }

    switch (message.type) {
      case "ready":
        this.clearReadyTimeout();
        this.connectSettled = true;
        this.resolveConnect();
        this.emitStatus(message.payload.status, message.payload.error);
        return;
      case "response":
        this.handleResponse(message);
        return;
      case "event":
        this.handleWorkerEvent(message);
        return;
    }
  }

  private handleResponse(message: SharedWorkerClientResponseMessage) {
    const pending = this.pending.get(message.request_id);
    if (!pending) {
      return;
    }
    const host = getRuntimeHost();
    host.clearTimeout(pending.timeoutId);
    this.pending.delete(message.request_id);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve(message.payload);
  }

  private handleWorkerEvent(message: SharedWorkerClientEventMessage) {
    switch (message.event_type) {
      case "status": {
        const payload = message.payload as { status?: AgentStatus | null; error?: string | null };
        this.emitStatus(payload.status ?? null, payload.error ?? null);
        return;
      }
      case "history":
        this.emitHistory(message.payload as GatewayHistoryEvent);
        return;
      case "settings":
        this.emitSettings(message.payload as GatewaySettingsSyncPayload);
        return;
      case "terminal": {
        const event = normalizeTerminalEvent(message.payload as RawTerminalEvent);
        if (event) {
          this.emitTerminal(event);
        }
        return;
      }
      case "sftp": {
        const event = normalizeSftpTransferEvent(message.payload as RawSftpEvent);
        if (event) {
          this.emitSftpTransfer(event);
        }
        return;
      }
    }
  }

  private emitStatus(status: AgentStatus | null, error: string | null) {
    this.lastStatus = status;
    this.lastStatusError = error;
    if (status?.online === false) {
      this.terminalSessionSnapshot.clear();
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

  private handleDisconnect(error: Error) {
    this.clearReadyTimeout();
    if (!this.connectSettled) {
      this.connectSettled = true;
      this.rejectConnect(error);
    }

    const host = getRuntimeHost();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      host.clearTimeout(entry.timeoutId);
      entry.reject(error);
    }

  }

  private nextRequestId(prefix: string) {
    this.requestSeq += 1;
    return `${prefix}-${Date.now()}-${this.requestSeq}`;
  }

  private clearReadyTimeout() {
    if (this.readyTimeoutId === null) {
      return;
    }
    const host = getRuntimeHost();
    host.clearTimeout(this.readyTimeoutId);
    this.readyTimeoutId = null;
  }
}

let activeClient: GatewayWebSocketClientLike | null = null;
let activeToken = "";

export function getGatewayWebSocketClient(token: string) {
  const normalizedToken = token.trim();
  if (activeClient && activeToken === normalizedToken) {
    return activeClient;
  }
  activeClient?.dispose();
  activeToken = normalizedToken;
  if (canUseSharedWorker() && normalizedToken) {
    try {
      activeClient = new SharedWorkerGatewayWebSocketClient(normalizedToken);
      return activeClient;
    } catch {
      // Fall back to the page-owned socket in browsers that expose but reject SharedWorker.
    }
  }
  activeClient = new GatewayWebSocketClient(normalizedToken);
  return activeClient;
}

export function resetGatewayWebSocketClient() {
  activeClient?.dispose();
  activeClient = null;
  activeToken = "";
}
