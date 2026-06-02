import type { GatewaySettingsSyncPayload } from "@/lib/settings/sync";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import type {
  TerminalEvent,
  TerminalSession,
  TerminalShellOptions,
  TerminalSnapshot,
} from "@/lib/terminal/types";

import type {
  AgentStatus,
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
type ConversationListener = (event: ChatEvent) => void;
type SettingsListener = (event: GatewaySettingsSyncPayload) => void;
type TerminalListener = (event: TerminalEvent) => void;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

type ChatStreamState = {
  kind: "chat" | "attach";
  queue: AsyncEventQueue<ChatEvent>;
  conversationId: string;
  lastSeq: number;
  resuming: boolean;
  attachedSocket: WebSocket | null;
  abortHandler?: () => void;
};

type ChatAttachOptions = {
  afterSeq?: number;
  signal?: AbortSignal;
};

type GatewayChatSystemSettings = {
  executionMode?: string;
  workdir?: string;
  selectedSystemTools?: string[];
};

type SkillListResponse = {
  rootDir: string;
  paths: string[];
  truncated: boolean;
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

type HistoryGetOptions = {
  maxMessages?: number;
};

type HistoryTruncateOptions = {
  omitMessagesJson?: boolean;
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
};

type RawTerminalResponse = {
  action?: string;
  sessions?: RawTerminalSession[];
  session?: RawTerminalSession;
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

const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_NOTICE_DELAY_MS = 10_000;
const SOCKET_INBOUND_STALL_MS = 25_000;

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

function readChatEventSeq(event: ChatEvent) {
  const seq = event.seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
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
  return {
    id: input.id ?? "",
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    cwd: input.cwd ?? "",
    shell: input.shell ?? "",
    title: input.title ?? "Terminal",
    pid: input.pid ?? null,
    cols: Number(input.cols ?? 80),
    rows: Number(input.rows ?? 24),
    createdAt: Number(input.createdAt ?? input.created_at ?? 0),
    updatedAt: Number(input.updatedAt ?? input.updated_at ?? 0),
    finishedAt: input.finishedAt ?? input.finished_at ?? null,
    exitCode: input.exitCode ?? input.exit_code ?? null,
    running: input.running === true,
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
  private chatStreams = new Map<string, ChatStreamState>();
  private disposed = false;
  private statusListeners = new Set<StatusListener>();
  private historyListeners = new Set<HistoryListener>();
  private conversationListeners = new Set<ConversationListener>();
  private settingsListeners = new Set<SettingsListener>();
  private terminalListeners = new Set<TerminalListener>();
  private statusPollTimer: number | null = null;
  private lastStatus: AgentStatus | null = null;
  private lastStatusError: string | null = null;
  private lastInboundAt = 0;
  private reconnectTimer: number | null = null;
  private reconnectNoticeTimer: number | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private readonly reconnectWakeup = () => {
    this.scheduleReconnect(0);
  };

  constructor(private readonly token: string) {
    this.installReconnectWakeups();
  }

  async getStatus(): Promise<AgentStatus> {
    const status = await this.requestWithRecovery<AgentStatus>("status.get", {});
    this.lastStatus = status;
    this.lastStatusError = null;
    return status;
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

  subscribeConversation(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener);
    return () => {
      this.conversationListeners.delete(listener);
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
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  async *chat(
    message: string,
    conversationId?: string,
    selectedModel?: GatewaySelectedModel,
    systemSettings?: GatewayChatSystemSettings,
    signal?: AbortSignal,
    uploadedFiles?: PendingUploadedFile[],
    clientRequestId?: string,
    runtimeControls?: GatewayChatRuntimeControls,
  ): AsyncGenerator<ChatEvent> {
    if (signal?.aborted) {
      return;
    }
    await this.ensureConnected();
    if (signal?.aborted) {
      return;
    }

    const requestId = this.nextRequestId("chat");
    const queue = new AsyncEventQueue<ChatEvent>();
    const streamState: ChatStreamState = {
      kind: "chat",
      queue,
      conversationId: conversationId?.trim() ?? "",
      lastSeq: 0,
      resuming: false,
      attachedSocket: null,
    };
    this.chatStreams.set(requestId, streamState);

    if (signal) {
      const handleAbort = () => {
        const active = this.chatStreams.get(requestId);
        if (active?.conversationId) {
          void this.cancelChat(active.conversationId).catch(() => undefined);
        }
        this.chatStreams.delete(requestId);
        queue.close();
      };
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
        streamState.abortHandler = () => signal.removeEventListener("abort", handleAbort);
      }
    }

    try {
      this.sendEnvelope({
        id: requestId,
        type: "chat.start",
        payload: {
          message,
          conversation_id: conversationId ?? "",
          client_request_id: clientRequestId?.trim() ?? "",
          execution_mode: systemSettings?.executionMode?.trim() || "text",
          workdir: systemSettings?.workdir?.trim() || "",
          selected_system_tools:
            systemSettings?.selectedSystemTools?.map((item) => item.trim()).filter(Boolean) ?? [],
          uploaded_files:
            uploadedFiles?.map((file) => ({
              relative_path: file.relativePath,
              absolute_path: file.absolutePath,
              file_name: file.fileName,
              kind: file.kind,
              size_bytes: file.sizeBytes,
            })) ?? [],
          selected_model: selectedModel
            ? {
                custom_provider_id: selectedModel.customProviderId,
                model: selectedModel.model,
                provider_type: selectedModel.providerType,
              }
            : undefined,
          runtime_controls: runtimeControls
            ? {
                thinking_enabled: runtimeControls.thinkingEnabled,
                native_web_search_enabled: runtimeControls.nativeWebSearchEnabled,
                reasoning: runtimeControls.reasoning,
              }
            : undefined,
        },
      });
      streamState.attachedSocket = this.socket;

      for await (const event of queue) {
        yield event;
      }
    } finally {
      const active = this.chatStreams.get(requestId);
      active?.abortHandler?.();
      this.chatStreams.delete(requestId);
    }
  }

  async *attachChat(
    conversationId: string,
    options?: ChatAttachOptions,
  ): AsyncGenerator<ChatEvent> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      throw new Error("conversation_id is required");
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return;
    }
    await this.ensureConnected();
    if (signal?.aborted) {
      return;
    }

    const requestId = this.nextRequestId("chat-attach");
    const queue = new AsyncEventQueue<ChatEvent>();
    const streamState: ChatStreamState = {
      kind: "attach",
      queue,
      conversationId: normalizedConversationId,
      lastSeq: normalizeAfterSeq(options?.afterSeq),
      resuming: false,
      attachedSocket: null,
    };
    this.chatStreams.set(requestId, streamState);

    if (signal) {
      const handleAbort = () => {
        void this.detachChatStream(requestId).catch(() => undefined);
        this.chatStreams.delete(requestId);
        queue.close();
      };
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
        streamState.abortHandler = () => signal.removeEventListener("abort", handleAbort);
      }
    }

    try {
      this.sendEnvelope({
        id: requestId,
        type: "chat.attach",
        payload: {
          conversation_id: normalizedConversationId,
          after_seq: streamState.lastSeq,
        },
      });
      streamState.attachedSocket = this.socket;

      for await (const event of queue) {
        yield event;
      }
    } finally {
      const active = this.chatStreams.get(requestId);
      active?.abortHandler?.();
      if (active) {
        await this.detachChatStream(requestId).catch(() => undefined);
        this.chatStreams.delete(requestId);
      }
    }
  }

  async cancelChat(conversationId: string): Promise<void> {
    await this.request("chat.cancel", {
      conversation_id: conversationId,
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

  async truncateHistory(
    conversationId: string,
    messageRef: HistoryMessageRef,
    options?: HistoryTruncateOptions,
  ): Promise<HistoryDetail> {
    return this.request<HistoryDetail>("history.truncate", {
      conversation_id: conversationId,
      segment_index: messageRef.segmentIndex,
      message_index: messageRef.messageIndex,
      omit_messages_json: options?.omitMessagesJson === true,
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

  async updateSettings(payload: GatewaySettingsSyncPayload): Promise<void> {
    await this.request("settings.update", payload);
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
      (this.chatStreams.size > 0 ||
        this.pending.size > 0 ||
        this.statusListeners.size > 0 ||
        this.historyListeners.size > 0 ||
        this.conversationListeners.size > 0 ||
        this.settingsListeners.size > 0 ||
        this.terminalListeners.size > 0)
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
      await this.ensureConnected({ resumeStreams: true });
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
    for (const listener of this.statusListeners) {
      listener(status, error);
    }
  }

  private emitHistory(event: GatewayHistoryEvent) {
    for (const listener of this.historyListeners) {
      listener(event);
    }
  }

  private emitConversation(event: ChatEvent) {
    for (const listener of this.conversationListeners) {
      listener(event);
    }
  }

  private emitSettings(event: GatewaySettingsSyncPayload) {
    for (const listener of this.settingsListeners) {
      listener(event);
    }
  }

  private emitTerminal(event: TerminalEvent) {
    for (const listener of this.terminalListeners) {
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

  private async ensureConnected(options?: { resumeStreams?: boolean }): Promise<void> {
    const shouldResumeStreams = options?.resumeStreams !== false;
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
        if (shouldResumeStreams) {
          void this.resumeChatStreams();
        }
        return;
      }
    }
    if (this.connectPromise) {
      await this.connectPromise;
      if (shouldResumeStreams) {
        void this.resumeChatStreams();
      }
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
    if (shouldResumeStreams) {
      void this.resumeChatStreams();
    }
  }

  private async resumeChatStreams() {
    if (
      this.disposed ||
      !this.socket ||
      !this.authenticated ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.chatStreams.size === 0
    ) {
      return;
    }

    for (const [requestId, stream] of this.chatStreams) {
      void this.resumeChatStream(requestId, stream);
    }
  }

  private async resumeChatStream(requestId: string, stream: ChatStreamState) {
    if (this.disposed || stream.resuming || !this.chatStreams.has(requestId)) {
      return;
    }
    if (this.socket && stream.attachedSocket === this.socket) {
      return;
    }
    stream.resuming = true;
    try {
      await this.ensureConnected({ resumeStreams: false });
      if (!this.socket || !this.authenticated || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (stream.kind === "attach") {
        this.sendEnvelope({
          id: requestId,
          type: "chat.attach",
          payload: {
            conversation_id: stream.conversationId,
            after_seq: stream.lastSeq,
          },
        });
      } else {
        this.sendEnvelope({
          id: this.nextRequestId("chat-resume"),
          type: "chat.resume",
          payload: {
            request_id: requestId,
            conversation_id: stream.conversationId,
            after_seq: stream.lastSeq,
          },
        });
      }
      stream.attachedSocket = this.socket;
    } catch {
      this.scheduleReconnect();
    } finally {
      stream.resuming = false;
    }
  }

  private async detachChatStream(requestId: string) {
    if (this.disposed) {
      return;
    }
    await this.ensureConnected({ resumeStreams: false });
    if (!this.socket || !this.authenticated || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.sendEnvelope({
      id: this.nextRequestId("chat-detach"),
      type: "chat.detach",
      payload: {
        request_id: requestId,
      },
    });
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

    if (envelope.type === "chat.event" && requestId) {
      const stream = this.chatStreams.get(requestId);
      if (!stream) {
        return;
      }
      const event = envelope.payload as ChatEvent;
      const seq = readChatEventSeq(event);
      if (seq > 0 && seq <= stream.lastSeq) {
        return;
      }
      if (seq > stream.lastSeq) {
        stream.lastSeq = seq;
      }
      if (event?.conversation_id) {
        stream.conversationId = event.conversation_id;
      }
      stream.queue.push(event);
      if (event?.type === "done" || event?.type === "error") {
        stream.abortHandler?.();
        stream.queue.close();
        this.chatStreams.delete(requestId);
      }
      return;
    }

    if (envelope.type === "conversation.event") {
      const event = envelope.payload as ChatEvent;
      if (event?.conversation_id) {
        this.emitConversation(event);
      }
      return;
    }

    if (envelope.type === "error" && requestId) {
      const stream = this.chatStreams.get(requestId);
      if (stream) {
        const message = typeof envelope.error === "string" ? envelope.error : "Request failed";
        stream.queue.push({
          type: "error",
          message,
          conversation_id: stream.conversationId || undefined,
        });
        stream.abortHandler?.();
        stream.queue.close();
        this.chatStreams.delete(requestId);
        return;
      }
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

    if (this.disposed) {
      const streams = [...this.chatStreams.values()];
      this.chatStreams.clear();
      for (const stream of streams) {
        stream.abortHandler?.();
        stream.queue.fail(error);
      }
    } else {
      for (const stream of this.chatStreams.values()) {
        stream.attachedSocket = null;
      }
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
      this.scheduleReconnect(this.chatStreams.size > 0 ? 0 : undefined);
    }
  }

  private markInboundActivity() {
    this.lastInboundAt = Date.now();
  }

  private shouldRecycleAuthenticatedSocket(now = Date.now()) {
    return (
      this.socket !== null &&
      this.authenticated &&
      this.socket.readyState === WebSocket.OPEN &&
      this.lastInboundAt > 0 &&
      now - this.lastInboundAt >= SOCKET_INBOUND_STALL_MS
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
    await this.ensureConnected({ resumeStreams: true });
  }

  private nextRequestId(prefix: string) {
    this.requestSeq += 1;
    return `${prefix}-${Date.now()}-${this.requestSeq}`;
  }
}

export type GatewayWebSocketClientLike = {
  getStatus(): Promise<AgentStatus>;
  subscribeStatus(listener: StatusListener): () => void;
  subscribeHistory(listener: HistoryListener): () => void;
  subscribeConversation(listener: ConversationListener): () => void;
  subscribeSettings(listener: SettingsListener): () => void;
  subscribeTerminal(listener: TerminalListener): () => void;
  chat(
    message: string,
    conversationId?: string,
    selectedModel?: GatewaySelectedModel,
    systemSettings?: GatewayChatSystemSettings,
    signal?: AbortSignal,
    uploadedFiles?: PendingUploadedFile[],
    clientRequestId?: string,
    runtimeControls?: GatewayChatRuntimeControls,
  ): AsyncGenerator<ChatEvent>;
  attachChat(conversationId: string, options?: ChatAttachOptions): AsyncGenerator<ChatEvent>;
  cancelChat(conversationId: string): Promise<void>;
  cronManage(payload: CronManagePayload): Promise<CronManageResponse>;
  memoryManage<T = unknown>(payload: MemoryManagePayload): Promise<T>;
  gitRequest<T = unknown>(
    action: string,
    workdir: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
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
  listHistory(page: number, pageSize: number, filter?: HistoryListFilter): Promise<HistoryList>;
  listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse>;
  listSharedHistory(page: number, pageSize: number): Promise<HistoryList>;
  getHistory(conversationId: string, options?: HistoryGetOptions): Promise<HistoryDetail>;
  truncateHistory(
    conversationId: string,
    messageRef: HistoryMessageRef,
    options?: HistoryTruncateOptions,
  ): Promise<HistoryDetail>;
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
  updateSettings(payload: GatewaySettingsSyncPayload): Promise<void>;
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
  event_type: "status" | "history" | "conversation" | "settings" | "terminal";
  payload: unknown;
};

type SharedWorkerClientChatEventMessage = {
  type: "chat-event";
  connection_id: string;
  stream_id: string;
  payload: ChatEvent;
};

type SharedWorkerClientChatErrorMessage = {
  type: "chat-error";
  connection_id: string;
  stream_id: string;
  error: string;
};

type SharedWorkerClientChatClosedMessage = {
  type: "chat-closed";
  connection_id: string;
  stream_id: string;
};

type SharedWorkerClientMessage =
  | SharedWorkerClientReadyMessage
  | SharedWorkerClientResponseMessage
  | SharedWorkerClientEventMessage
  | SharedWorkerClientChatEventMessage
  | SharedWorkerClientChatErrorMessage
  | SharedWorkerClientChatClosedMessage;

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
        system_settings?: GatewayChatSystemSettings;
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
  private chatStreams = new Map<
    string,
    {
      queue: AsyncEventQueue<ChatEvent>;
      conversationId: string;
      lastSeq: number;
      abortHandler?: () => void;
    }
  >();
  private statusListeners = new Set<StatusListener>();
  private historyListeners = new Set<HistoryListener>();
  private conversationListeners = new Set<ConversationListener>();
  private settingsListeners = new Set<SettingsListener>();
  private terminalListeners = new Set<TerminalListener>();
  private lastStatus: AgentStatus | null = null;
  private lastStatusError: string | null = null;

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

  subscribeConversation(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener);
    return () => {
      this.conversationListeners.delete(listener);
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
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  async *chat(
    message: string,
    conversationId?: string,
    selectedModel?: GatewaySelectedModel,
    systemSettings?: GatewayChatSystemSettings,
    signal?: AbortSignal,
    uploadedFiles?: PendingUploadedFile[],
    clientRequestId?: string,
    runtimeControls?: GatewayChatRuntimeControls,
  ): AsyncGenerator<ChatEvent> {
    if (signal?.aborted) {
      return;
    }
    await this.ensureConnected();
    if (signal?.aborted) {
      return;
    }

    const streamId = this.nextRequestId("chat-stream");
    const queue = new AsyncEventQueue<ChatEvent>();
    const streamState = {
      queue,
      conversationId: conversationId?.trim() ?? "",
      lastSeq: 0,
      abortHandler: undefined as (() => void) | undefined,
    };
    this.chatStreams.set(streamId, streamState);

    if (signal) {
      const handleAbort = () => {
        const active = this.chatStreams.get(streamId);
        if (active?.conversationId) {
          void this.request("chat.cancel", {
            stream_id: streamId,
            conversation_id: active.conversationId,
          }).catch(() => undefined);
        }
        this.chatStreams.delete(streamId);
        queue.close();
      };
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
        streamState.abortHandler = () => signal.removeEventListener("abort", handleAbort);
      }
    }

    try {
      await this.request("chat.start", {
        stream_id: streamId,
        message,
        conversation_id: conversationId ?? "",
        client_request_id: clientRequestId?.trim() ?? "",
        selected_model: selectedModel,
        runtime_controls: runtimeControls,
        system_settings: systemSettings,
        uploaded_files: uploadedFiles,
      });

      for await (const event of queue) {
        yield event;
      }
    } finally {
      const active = this.chatStreams.get(streamId);
      active?.abortHandler?.();
      this.chatStreams.delete(streamId);
    }
  }

  async *attachChat(
    conversationId: string,
    options?: ChatAttachOptions,
  ): AsyncGenerator<ChatEvent> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      throw new Error("conversation_id is required");
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return;
    }
    await this.ensureConnected();
    if (signal?.aborted) {
      return;
    }

    const streamId = this.nextRequestId("chat-attach-stream");
    const queue = new AsyncEventQueue<ChatEvent>();
    const streamState = {
      queue,
      conversationId: normalizedConversationId,
      lastSeq: normalizeAfterSeq(options?.afterSeq),
      abortHandler: undefined as (() => void) | undefined,
    };
    this.chatStreams.set(streamId, streamState);

    if (signal) {
      const handleAbort = () => {
        void this.request("chat.detach", {
          stream_id: streamId,
        }).catch(() => undefined);
        this.chatStreams.delete(streamId);
        queue.close();
      };
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
        streamState.abortHandler = () => signal.removeEventListener("abort", handleAbort);
      }
    }

    try {
      await this.request("chat.attach", {
        stream_id: streamId,
        conversation_id: normalizedConversationId,
        after_seq: streamState.lastSeq,
      });

      for await (const event of queue) {
        yield event;
      }
    } finally {
      const active = this.chatStreams.get(streamId);
      active?.abortHandler?.();
      if (active) {
        await this.request("chat.detach", {
          stream_id: streamId,
        }).catch(() => undefined);
        this.chatStreams.delete(streamId);
      }
    }
  }

  async cancelChat(conversationId: string): Promise<void> {
    const normalized = conversationId.trim();
    if (!normalized) {
      return;
    }
    const stream = [...this.chatStreams.entries()].find(
      ([, item]) => item.conversationId === normalized,
    );
    await this.request("chat.cancel", {
      stream_id: stream?.[0] ?? "",
      conversation_id: normalized,
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

  async truncateHistory(
    conversationId: string,
    messageRef: HistoryMessageRef,
    options?: HistoryTruncateOptions,
  ): Promise<HistoryDetail> {
    return this.request<HistoryDetail>("history.truncate", {
      conversation_id: conversationId,
      segment_index: messageRef.segmentIndex,
      message_index: messageRef.messageIndex,
      omit_messages_json: options?.omitMessagesJson === true,
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

  async updateSettings(payload: GatewaySettingsSyncPayload): Promise<void> {
    await this.request("settings.update", payload);
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
        if (method === "chat.start") {
          const body = payload as Record<string, unknown>;
          const streamId = String(body.stream_id ?? "");
          this.postMessage({
            type: "chat.start",
            connection_id: this.connectionID,
            request_id: requestId,
            stream_id: streamId,
            payload: {
              message: String(body.message ?? ""),
              conversation_id: String(body.conversation_id ?? ""),
              client_request_id: String(body.client_request_id ?? ""),
              selected_model: body.selected_model as GatewaySelectedModel | undefined,
              runtime_controls: body.runtime_controls as GatewayChatRuntimeControls | undefined,
              system_settings: body.system_settings as GatewayChatSystemSettings | undefined,
              uploaded_files: body.uploaded_files as PendingUploadedFile[] | undefined,
            },
          });
          return;
        }
        if (method === "chat.attach") {
          const body = payload as Record<string, unknown>;
          this.postMessage({
            type: "chat.attach",
            connection_id: this.connectionID,
            request_id: requestId,
            stream_id: String(body.stream_id ?? ""),
            conversation_id: String(body.conversation_id ?? ""),
            after_seq: normalizeAfterSeq(body.after_seq),
          });
          return;
        }
        if (method === "chat.detach") {
          const body = payload as Record<string, unknown>;
          this.postMessage({
            type: "chat.detach",
            connection_id: this.connectionID,
            stream_id: String(body.stream_id ?? ""),
          });
          host.clearTimeout(timeoutId);
          this.pending.delete(requestId);
          resolve(undefined as T);
          return;
        }
        if (method === "chat.cancel") {
          const body = payload as Record<string, unknown>;
          this.postMessage({
            type: "chat.cancel",
            connection_id: this.connectionID,
            stream_id: String(body.stream_id ?? ""),
            conversation_id:
              typeof body.conversation_id === "string" ? body.conversation_id : undefined,
          });
          host.clearTimeout(timeoutId);
          this.pending.delete(requestId);
          resolve(undefined as T);
          return;
        }
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
      case "chat-event":
        this.handleChatEvent(message.stream_id, message.payload);
        return;
      case "chat-error":
        this.handleChatError(message.stream_id, message.error);
        return;
      case "chat-closed":
        this.handleChatClosed(message.stream_id);
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
      case "conversation":
        this.emitConversation(message.payload as ChatEvent);
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
    }
  }

  private handleChatEvent(streamId: string, event: ChatEvent) {
    const stream = this.chatStreams.get(streamId);
    if (!stream) {
      return;
    }
    const seq = readChatEventSeq(event);
    if (seq > 0 && seq <= stream.lastSeq) {
      return;
    }
    if (seq > stream.lastSeq) {
      stream.lastSeq = seq;
    }
    if (event?.conversation_id) {
      stream.conversationId = event.conversation_id;
    }
    stream.queue.push(event);
    if (event?.type === "done" || event?.type === "error") {
      stream.abortHandler?.();
      stream.queue.close();
      this.chatStreams.delete(streamId);
    }
  }

  private handleChatError(streamId: string, error: string) {
    const stream = this.chatStreams.get(streamId);
    if (!stream) {
      return;
    }
    stream.queue.push({
      type: "error",
      message: error.trim() || "Gateway chat stream failed",
      conversation_id: stream.conversationId || undefined,
    });
    stream.abortHandler?.();
    stream.queue.close();
    this.chatStreams.delete(streamId);
  }

  private handleChatClosed(streamId: string) {
    const stream = this.chatStreams.get(streamId);
    if (!stream) {
      return;
    }
    stream.abortHandler?.();
    stream.queue.close();
    this.chatStreams.delete(streamId);
  }

  private emitStatus(status: AgentStatus | null, error: string | null) {
    this.lastStatus = status;
    this.lastStatusError = error;
    for (const listener of this.statusListeners) {
      listener(status, error);
    }
  }

  private emitHistory(event: GatewayHistoryEvent) {
    for (const listener of this.historyListeners) {
      listener(event);
    }
  }

  private emitConversation(event: ChatEvent) {
    for (const listener of this.conversationListeners) {
      listener(event);
    }
  }

  private emitSettings(event: GatewaySettingsSyncPayload) {
    for (const listener of this.settingsListeners) {
      listener(event);
    }
  }

  private emitTerminal(event: TerminalEvent) {
    for (const listener of this.terminalListeners) {
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

    const streams = [...this.chatStreams.values()];
    this.chatStreams.clear();
    for (const stream of streams) {
      stream.abortHandler?.();
      stream.queue.fail(error);
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
