import { createKBrainQueueClient } from "./queueClient";
import { fetchKBrain, KBrainTransportError } from "./transport";
import {
  KBRAIN_PROTOCOL_VERSION,
  type KBrainBranchRequest,
  type KBrainClientOptions,
  type KBrainClientToolResult,
  type KBrainCreateSessionRequest,
  type KBrainEditRequest,
  type KBrainEvent,
  type KBrainGoalRequest,
  type KBrainGoalState,
  type KBrainHistoryResponse,
  type KBrainModelRef,
  type KBrainPromptRequest,
  type KBrainProviderSecrets,
  type KBrainQuestionAnswer,
  type KBrainRunAccepted,
  type KBrainSession,
  type KBrainSessionLoop,
  type KBrainSessionPage,
  type KBrainSettingsDocument,
  type KBrainSettingsUpdate,
  type KBrainSharedProjection,
  type KBrainShareStatus,
  type KBrainSlashCommand,
  type KBrainTextGenerateRequest,
  type KBrainTextGenerateResponse,
  type KBrainUpdateSessionRequest,
} from "./types";

export type KBrainCheckpointTurn = {
  turn_seq: number;
  turn_id: string;
  file_count: number;
  dir_count: number;
  incomplete: boolean;
  first_captured_at: number;
};

export type KBrainCheckpointDiff = {
  turn_seq: number;
  restore_files: number;
  delete_files: number;
  clean_files: number;
  skipped_dirs: number;
  missing_blobs: number;
  unresolvable_files: number;
  capture_errors: number;
  entries: {
    path: string;
    key: string;
    action: string;
    current_hash?: string;
  }[];
};

export type KBrainCheckpointResult = {
  turn_seq: number;
  restored_files: number;
  deleted_files: number;
  clean_files: number;
  skipped_dirs: number;
  capture_errors: number;
  conflicts: string[];
  failed: string[];
  revision?: string;
};

export type KBrainCompactAccepted = {
  version: typeof KBRAIN_PROTOCOL_VERSION;
  conversation_id: string;
  run_id: string;
  accepted_seq: number;
  status: string;
  revision?: string;
};

export type KBrainEventHandlers = {
  onEvent: (event: KBrainEvent) => void;
  onError?: (error: Error) => void;
};

export type KBrainCheckpointExpected = { key: string; current_hash: string };

export type KBrainProviderModelDiscoveryInput = {
  type: string;
  requestFormat?: string;
  baseUrl: string;
  apiKey: string;
  useSystemProxy?: boolean;
  isFullUrl?: boolean;
  modelsUrl?: string;
  providerId?: string;
  customHeaders?: readonly { key: string; value: string }[];
};

export type KBrainProviderModelsResponse = {
  version: string;
  provider: string;
  models: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isCheckpointTurn(value: unknown): value is KBrainCheckpointTurn {
  return (
    isRecord(value) &&
    isFiniteInteger(value.turn_seq) &&
    typeof value.turn_id === "string" &&
    isFiniteInteger(value.file_count) &&
    isFiniteInteger(value.dir_count) &&
    typeof value.incomplete === "boolean" &&
    typeof value.first_captured_at === "number"
  );
}

function isCheckpointDiff(value: unknown): value is KBrainCheckpointDiff {
  return (
    isRecord(value) &&
    isFiniteInteger(value.turn_seq) &&
    isFiniteInteger(value.restore_files) &&
    isFiniteInteger(value.delete_files) &&
    isFiniteInteger(value.clean_files) &&
    isFiniteInteger(value.skipped_dirs) &&
    isFiniteInteger(value.missing_blobs) &&
    isFiniteInteger(value.unresolvable_files) &&
    isFiniteInteger(value.capture_errors) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.key === "string" &&
        typeof entry.action === "string" &&
        (entry.current_hash === undefined || typeof entry.current_hash === "string"),
    )
  );
}

function isCheckpointResult(value: unknown): value is KBrainCheckpointResult {
  return (
    isRecord(value) &&
    isFiniteInteger(value.turn_seq) &&
    isFiniteInteger(value.restored_files) &&
    isFiniteInteger(value.deleted_files) &&
    isFiniteInteger(value.clean_files) &&
    isFiniteInteger(value.skipped_dirs) &&
    isFiniteInteger(value.capture_errors) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every((item) => typeof item === "string") &&
    Array.isArray(value.failed) &&
    value.failed.every((item) => typeof item === "string") &&
    (value.revision === undefined || typeof value.revision === "string")
  );
}

async function readError(response: Response) {
  const body = await response.text();
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    message = parsed.error || parsed.message || message;
  } catch {
    // Keep the original response body for non-JSON server errors.
  }
  const error = new Error(message || `K-brain request failed (${response.status})`);
  Object.assign(error, { status: response.status });
  return error;
}

export function createKBrainClient(inputOptions: KBrainClientOptions = {}) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchKBrain(path, init, inputOptions);
    if (!response.ok) throw await readError(response);
    return (await response.json()) as T;
  }

  async function requestMemory<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return request<T>("/v1/memory/manage", {
      method: "POST",
      body: JSON.stringify({ command, args }),
    });
  }

  async function searchHistory<T>(args: Record<string, unknown> = {}): Promise<T> {
    return request<T>("/v1/history/search", {
      method: "POST",
      body: JSON.stringify(args),
    });
  }

  async function createSession(input: KBrainCreateSessionRequest): Promise<KBrainSession> {
    return request<KBrainSession>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function importLegacyHistory(input: unknown, signal?: AbortSignal) {
    const result = await request<{
      source_id: string;
      backend_id: string;
      status: "imported" | "already_imported";
      checkpoint: "available" | "partial" | "not_found" | "unresolved";
      checkpoint_reason?: string;
      fingerprint: string;
    }>("/v1/migrations/liveagent-history", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    });
    if (
      !result ||
      typeof result.source_id !== "string" ||
      !result.source_id.trim() ||
      typeof result.backend_id !== "string" ||
      !result.backend_id.trim() ||
      (result.status !== "imported" && result.status !== "already_imported") ||
      !["available", "partial", "not_found", "unresolved"].includes(result.checkpoint) ||
      (result.checkpoint_reason !== undefined && typeof result.checkpoint_reason !== "string") ||
      typeof result.fingerprint !== "string" ||
      !result.fingerprint.trim()
    ) {
      throw new Error("Malformed K-brain history import response");
    }
    return result;
  }

  async function listSessions(
    params: {
      page?: number;
      pageSize?: number;
      cwd?: string;
      cwdEmpty?: boolean;
      shared?: boolean;
    } = {},
  ): Promise<KBrainSessionPage> {
    const query = new URLSearchParams();
    query.set("page", String(Math.max(1, params.page ?? 1)));
    query.set("page_size", String(Math.max(1, params.pageSize ?? 50)));
    if (params.cwd !== undefined) query.set("cwd", params.cwd);
    if (params.cwdEmpty !== undefined) query.set("cwd_empty", String(params.cwdEmpty));
    if (params.shared !== undefined) query.set("shared", String(params.shared));
    const result = await request<KBrainSessionPage | KBrainSession[]>(`/v1/sessions?${query}`);
    return Array.isArray(result)
      ? { sessions: result, total_count: result.length }
      : {
          sessions: result.sessions ?? [],
          total_count: result.total_count ?? result.sessions?.length ?? 0,
          version: result.version,
        };
  }

  async function listModels(): Promise<KBrainModelRef[]> {
    const result = await request<{ models?: KBrainModelRef[] } | KBrainModelRef[]>("/v1/models", {
      // The catalog changes immediately after provider/model imports. Request cache
      // mode avoids stale WebView entries without adding a CORS-preflight header.
      cache: "no-store",
    });
    return Array.isArray(result) ? result : (result.models ?? []);
  }

  async function discoverProviderModels(
    providerId: string | undefined,
    input: unknown,
  ): Promise<unknown> {
    const id = providerId?.trim() || "draft";
    return request<unknown>(`/v1/settings/providers/${encodeURIComponent(id)}/models`, {
      method: "POST",
      // Provider IDs can share the same proxy path (for example multiple /v1
      // OpenAI-compatible endpoints). Never let WebView HTTP caching reuse a
      // model list from another upstream.
      // cache:"no-store" is a fetch option and adds no request header. Do not add a
      // Cache-Control header: K-brain's CORS preflight only allows Authorization,
      // Content-Type and Accept, so the WebView would block the request entirely.
      cache: "no-store",
      body: JSON.stringify(input),
    });
  }

  /** Explicit opt-in read of stored credentials; the settings document always redacts them. */
  async function revealProviderSecrets(providerId: string): Promise<KBrainProviderSecrets> {
    return request<KBrainProviderSecrets>(
      `/v1/settings/providers/${encodeURIComponent(providerId)}/secrets`,
      { method: "POST", body: JSON.stringify({ confirm: true }) },
    );
  }

  async function getSettings(): Promise<KBrainSettingsDocument> {
    return request<KBrainSettingsDocument>("/v1/settings");
  }

  async function updateSettings(input: KBrainSettingsUpdate): Promise<KBrainSettingsDocument> {
    return request<KBrainSettingsDocument>("/v1/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async function getMcpSettings(): Promise<unknown> {
    return request<unknown>("/v1/mcp");
  }

  async function updateMcpSettings(input: unknown): Promise<unknown> {
    return request<unknown>("/v1/mcp", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async function discoverMcpTools(
    input: { cwd?: string; server_ids?: string[] } = {},
  ): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.cwd) query.set("cwd", input.cwd);
    if (input.server_ids?.length) query.set("server_ids", input.server_ids.join(","));
    return request<unknown>(`/v1/mcp/tools?${query}`);
  }

  async function searchMcpTools(input: {
    query: string;
    cwd?: string;
    server_ids?: string[];
    max_results?: number;
  }): Promise<unknown> {
    return request<unknown>("/v1/mcp/search", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function callMcpTool(input: {
    name: string;
    arguments?: unknown;
    cwd?: string;
  }): Promise<unknown> {
    return request<unknown>("/v1/mcp/tools/call", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function getCapabilities(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const health = await request<{ capabilities?: Record<string, unknown> }>("/v1/health", {
      signal,
    });
    return health.capabilities && typeof health.capabilities === "object"
      ? health.capabilities
      : {};
  }

  /** Ids among `ids` that K-brain can load, answered from file metadata (`session_exists`). */
  async function sessionsExist(ids: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    const result = await request<{ existing?: unknown }>("/v1/sessions/exists", {
      method: "POST",
      body: JSON.stringify({ ids }),
      signal,
    });
    if (!Array.isArray(result?.existing) || result.existing.some((id) => typeof id !== "string")) {
      throw new Error("Malformed K-brain session existence response");
    }
    return new Set(result.existing as string[]);
  }

  async function getSession(conversationId: string, signal?: AbortSignal): Promise<KBrainSession> {
    return request<KBrainSession>(`/v1/sessions/${encodeURIComponent(conversationId)}`, { signal });
  }

  async function getHistory(
    conversationId: string,
    params: {
      maxMessages: number;
      beforeOffset?: number;
      expectedRevision?: string;
      includeActive?: boolean;
    },
  ): Promise<KBrainHistoryResponse> {
    const query = new URLSearchParams({
      max_messages: String(params.maxMessages),
    });
    if (params.beforeOffset !== undefined) query.set("before_offset", String(params.beforeOffset));
    if (params.expectedRevision !== undefined)
      query.set("expected_revision", params.expectedRevision);
    if (params.includeActive !== undefined)
      query.set("include_active", String(params.includeActive));
    return request<KBrainHistoryResponse>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/history?${query}`,
    );
  }

  async function branchSession(
    conversationId: string,
    input: KBrainBranchRequest,
  ): Promise<KBrainSession> {
    return request<KBrainSession>(`/v1/sessions/${encodeURIComponent(conversationId)}/branch`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function editSession(
    conversationId: string,
    input: KBrainEditRequest,
  ): Promise<KBrainSession> {
    return request<KBrainSession>(`/v1/sessions/${encodeURIComponent(conversationId)}/edit`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function listCheckpoints(conversationId: string): Promise<KBrainCheckpointTurn[]> {
    const result = await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/checkpoints`,
    );
    if (!Array.isArray(result) || !result.every(isCheckpointTurn)) {
      throw new Error("Malformed K-brain checkpoint list response");
    }
    return result;
  }

  async function checkpointPreview(
    conversationId: string,
    turnSeq: number,
    authorizedRoots: string[],
  ): Promise<KBrainCheckpointDiff> {
    const result = await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/checkpoints/${turnSeq}/preview`,
      {
        method: "POST",
        body: JSON.stringify({ authorized_roots: authorizedRoots }),
      },
    );
    if (!isCheckpointDiff(result)) throw new Error("Malformed K-brain checkpoint preview response");
    return result;
  }

  async function checkpointRewind(
    conversationId: string,
    turnSeq: number,
    authorizedRoots: string[],
    expected: { key: string; currentHash: string }[],
  ): Promise<KBrainCheckpointResult> {
    const result = await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/checkpoints/${turnSeq}/rewind`,
      {
        method: "POST",
        body: JSON.stringify({
          authorized_roots: authorizedRoots,
          expected: expected.map((entry) => ({
            key: entry.key,
            current_hash: entry.currentHash,
          })),
        }),
      },
    );
    if (!isCheckpointResult(result))
      throw new Error("Malformed K-brain checkpoint rewind response");
    return result;
  }

  async function deleteSession(conversationId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
    });
  }

  async function getShare(conversationId: string): Promise<KBrainShareStatus> {
    return request<KBrainShareStatus>(`/v1/sessions/${encodeURIComponent(conversationId)}/share`);
  }

  async function setShare(
    conversationId: string,
    input: { enabled: boolean; redact_tool_content?: boolean },
  ): Promise<KBrainShareStatus> {
    return request<KBrainShareStatus>(`/v1/sessions/${encodeURIComponent(conversationId)}/share`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function resolveShareToken(token: string): Promise<KBrainSharedProjection> {
    return request<KBrainSharedProjection>(`/v1/shares/${encodeURIComponent(token)}`);
  }

  async function updateSession(
    conversationId: string,
    input: KBrainUpdateSessionRequest,
  ): Promise<KBrainSession> {
    return request<KBrainSession>(`/v1/sessions/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async function generateText(
    input: KBrainTextGenerateRequest,
    signal?: AbortSignal,
  ): Promise<KBrainTextGenerateResponse> {
    const result = await request<KBrainTextGenerateResponse>("/v1/text/generate", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    });
    if (result.version !== KBRAIN_PROTOCOL_VERSION || typeof result.text !== "string") {
      throw new Error("Malformed K-brain text-generation response");
    }
    if (
      result.model?.provider !== input.model.provider ||
      result.model?.model !== input.model.model
    ) {
      throw new Error("K-brain text-generation model identity mismatch");
    }
    return result;
  }

  async function compactSession(
    conversationId: string,
    input: { client_request_id?: string; expected_revision: string },
  ): Promise<KBrainCompactAccepted> {
    if (!input.expected_revision?.trim()) {
      throw new Error("expected_revision is required for compaction");
    }
    const clientRequestId = input.client_request_id?.trim() || crypto.randomUUID();
    const result = await request<KBrainCompactAccepted>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/compact`,
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          client_request_id: clientRequestId,
          ...(input.expected_revision ? { expected_revision: input.expected_revision } : {}),
        }),
      },
    );
    if (
      result.version !== KBRAIN_PROTOCOL_VERSION ||
      result.conversation_id !== conversationId ||
      !result.run_id ||
      !Number.isSafeInteger(result.accepted_seq)
    ) {
      throw new Error("Malformed K-brain compaction acceptance");
    }
    return result;
  }

  async function startRun(
    input: KBrainPromptRequest,
    signal?: AbortSignal,
  ): Promise<KBrainRunAccepted> {
    signal?.throwIfAborted();
    const mode = input.options?.permission_mode;
    if (mode === "always" || mode === "auto_edit" || mode === "auto_review") {
      const health = await request<{ capabilities?: { permission_modes?: string[] } }>(
        "/v1/health",
        { signal },
      );
      if (!health.capabilities?.permission_modes?.includes(mode)) {
        throw new Error(
          `K-brain does not support permission mode ${mode}; update the backend before using this mode.`,
        );
      }
    }
    const path = `/v1/sessions/${encodeURIComponent(input.conversation_id)}/runs`;
    let accepted: KBrainRunAccepted;
    try {
      accepted = await request<KBrainRunAccepted>(path, {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      });
    } catch (error) {
      if (
        (!(error instanceof KBrainTransportError) && !signal?.aborted) ||
        !input.client_request_id?.trim()
      )
        throw error;
      // The backend run outlives the POST. Recover even after Stop so the caller
      // can cancel the accepted run. Never resubmit the mutation, and keep the
      // lookup independent of the user signal (which can abort during recovery).
      try {
        accepted = await request<KBrainRunAccepted>(
          `${path}?client_request_id=${encodeURIComponent(input.client_request_id)}`,
          { signal: AbortSignal.timeout(5_000) },
        );
      } catch {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    }
    if (accepted.version !== KBRAIN_PROTOCOL_VERSION) {
      throw new Error(`Unsupported K-brain protocol ${String(accepted.version)}`);
    }
    if (
      accepted.conversation_id !== input.conversation_id ||
      !accepted.run_id ||
      !Number.isSafeInteger(accepted.accepted_seq) ||
      accepted.accepted_seq < 1
    ) {
      throw new Error("Malformed K-brain run acceptance");
    }
    return accepted;
  }

  /** 按 client_request_id 查已接受的运行；未接受时返回 null（404）。 */
  async function lookupRun(
    conversationId: string,
    clientRequestId: string,
    signal?: AbortSignal,
  ): Promise<KBrainRunAccepted | null> {
    try {
      return await request<KBrainRunAccepted>(
        `/v1/sessions/${encodeURIComponent(conversationId)}/runs?client_request_id=${encodeURIComponent(clientRequestId)}`,
        { signal },
      );
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async function getGoal(conversationId: string, signal?: AbortSignal): Promise<KBrainGoalState> {
    return request<KBrainGoalState>(`/v1/sessions/${encodeURIComponent(conversationId)}/goal`, {
      signal,
    });
  }

  async function postGoal(
    conversationId: string,
    input: KBrainGoalRequest,
    signal?: AbortSignal,
  ): Promise<KBrainGoalState> {
    const body =
      input.action === "set" || input.action === "resume"
        ? { ...input, run: { ...input.run, conversation_id: conversationId } }
        : input;
    const state = await request<KBrainGoalState>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/goal`,
      { method: "POST", body: JSON.stringify(body), signal },
    );
    if (state.version !== KBRAIN_PROTOCOL_VERSION || state.conversation_id !== conversationId) {
      throw new Error("Malformed K-brain goal response");
    }
    return state;
  }

  /** 把不经过模型的“/”指令和结果作为一问一答写进会话历史。 */
  async function recordCommandNote(
    conversationId: string,
    command: string,
    result: string,
  ): Promise<void> {
    await request<unknown>(`/v1/sessions/${encodeURIComponent(conversationId)}/command-notes`, {
      method: "POST",
      body: JSON.stringify({ command, result }),
    });
  }

  async function listLoops(conversationId: string): Promise<KBrainSessionLoop[]> {
    const result = await request<{ loops?: KBrainSessionLoop[] }>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/loops`,
    );
    return result.loops ?? [];
  }

  async function createLoop(
    conversationId: string,
    input: { cron?: string; interval: string; prompt: string; reasoning?: string },
  ): Promise<KBrainSessionLoop> {
    return request<KBrainSessionLoop>(`/v1/sessions/${encodeURIComponent(conversationId)}/loops`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function cancelLoop(conversationId: string, loopId: string): Promise<void> {
    await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/loops/${encodeURIComponent(loopId)}/cancel`,
      { method: "POST", body: "{}" },
    );
  }

  async function listCommands(workdir?: string): Promise<KBrainSlashCommand[]> {
    const query = workdir?.trim() ? `?workdir=${encodeURIComponent(workdir.trim())}` : "";
    const result = await request<{ commands?: KBrainSlashCommand[] }>(`/v1/commands${query}`);
    return result.commands ?? [];
  }

  async function cancelRun(conversationId: string, runId: string): Promise<void> {
    await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          run_id: runId,
        }),
      },
    );
  }

  async function closeSession(conversationId: string): Promise<void> {
    await request<unknown>(`/v1/sessions/${encodeURIComponent(conversationId)}/close`, {
      method: "POST",
      body: JSON.stringify({ conversation_id: conversationId }),
    });
  }

  async function resolveQuestion(
    conversationId: string,
    questionId: string,
    runId: string,
    answers: KBrainQuestionAnswer[],
  ): Promise<void> {
    await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(questionId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          question_id: questionId,
          run_id: runId,
          answers,
        }),
      },
    );
  }

  async function resolveClientTool(
    conversationId: string,
    callId: string,
    runId: string,
    result: KBrainClientToolResult,
  ): Promise<void> {
    await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/client-tools/${encodeURIComponent(callId)}`,
      {
        method: "POST",
        body: JSON.stringify({ conversation_id: conversationId, run_id: runId, ...result }),
      },
    );
  }

  async function resolvePermission(
    conversationId: string,
    permissionId: string,
    decision: "allow_once" | "allow_always" | "reject",
    runId = "",
    reason?: string,
  ): Promise<void> {
    await request<unknown>(
      `/v1/sessions/${encodeURIComponent(conversationId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          run_id: runId,
          decision: {
            permission_id: permissionId,
            decision,
            ...(reason ? { reason } : {}),
          },
        }),
      },
    );
  }

  async function subscribe(
    conversationId: string,
    afterSeq: number,
    handlers: KBrainEventHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetchKBrain(
      `/v1/sessions/${encodeURIComponent(conversationId)}/events?after_seq=${encodeURIComponent(String(afterSeq))}`,
      {
        headers: { Accept: "text/event-stream" },
        signal,
      },
      inputOptions,
    );
    if (!response.ok) throw await readError(response);
    if (!response.body) throw new Error("K-brain event stream has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastSeq = afterSeq;
    const abortReader = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortReader, { once: true });
    const consume = (record: string) => {
      let data = "";
      for (const line of record.split(/\r?\n/)) {
        if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      if (!data) return;
      try {
        const event = JSON.parse(data) as KBrainEvent;
        if (event.version !== KBRAIN_PROTOCOL_VERSION) {
          throw new Error(`Unsupported K-brain protocol ${String(event.version)}`);
        }
        if (event.conversation_id !== conversationId) {
          throw new Error("K-brain event belongs to a different conversation");
        }
        if (!Number.isSafeInteger(event.seq) || event.seq !== lastSeq + 1) {
          throw new Error(
            `Malformed K-brain event sequence: expected ${lastSeq + 1}, got ${String(event.seq)}`,
          );
        }
        lastSeq = event.seq;
        handlers.onEvent(event);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        handlers.onError?.(normalized);
        throw normalized;
      }
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? "";
        for (const record of records) consume(record);
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error("K-brain event stream ended with an incomplete event");
    } finally {
      signal?.removeEventListener("abort", abortReader);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  return {
    ...createKBrainQueueClient(inputOptions),
    createSession,
    requestMemory,
    searchHistory,
    importLegacyHistory,
    listSessions,
    listModels,
    discoverProviderModels,
    revealProviderSecrets,
    getSettings,
    updateSettings,
    getMcpSettings,
    updateMcpSettings,
    discoverMcpTools,
    searchMcpTools,
    callMcpTool,
    generateText,
    compactSession,
    getCapabilities,
    sessionsExist,
    getSession,
    updateSession,
    startRun,
    lookupRun,
    getGoal,
    postGoal,
    listCommands,
    recordCommandNote,
    listLoops,
    createLoop,
    cancelLoop,
    cancelRun,
    closeSession,
    resolvePermission,
    resolveQuestion,
    resolveClientTool,
    getHistory,
    listCheckpoints,
    checkpointPreview,
    checkpointRewind,
    branchSession,
    editSession,
    deleteSession,
    getShare,
    setShare,
    resolveShareToken,
    subscribe,
  };
}

export type KBrainClient = ReturnType<typeof createKBrainClient>;
