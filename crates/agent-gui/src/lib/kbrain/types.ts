import type { KBrainQuestionAnswerPayload } from "@liveagent/ui/lib/chat/askUserQuestion";
import type { CustomProvider, ProviderModelConfig } from "../settings";

export const KBRAIN_PROTOCOL_VERSION = "kbrain.agent.v1" as const;

export type KBrainModelRef = {
  provider: string;
  model: string;
  name?: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxOutputToken?: number;
  vision?: boolean;
  inputModalities?: string[];
};

export type KBrainSettingsModel = Partial<ProviderModelConfig> & {
  id: string;
  provider?: string;
  name?: string;
  maxOutputTokens?: number;
  vision?: boolean;
};

export type KBrainSettingsProvider = Omit<Partial<CustomProvider>, "models"> & {
  id: string;
  name: string;
  api?: string;
  models: KBrainSettingsModel[];
};

/** Response of POST /v1/settings/providers/{id}/secrets (resolved plaintext). */
export type KBrainProviderSecrets = {
  apiKey?: string;
  usageQuery?: { apiKey?: string; accessToken?: string; secretAccessKey?: string };
};

export type KBrainSettingsDocument = {
  version?: string;
  mode?: "kbrain";
  defaultModel?: string;
  defaultProvider?: string;
  providers: KBrainSettingsProvider[];
  models?: KBrainSettingsModel[];
  /** Web search fallback service (capability web_search_fallback); never carries the key. */
  webSearch?: unknown;
};

export type KBrainProviderUpdate = Omit<CustomProvider, "apiKey"> & {
  apiKey?: string;
  clearApiKey?: boolean;
};

export type KBrainSettingsUpdate = {
  defaultModel?: string;
  defaultProvider?: string;
  providers: KBrainProviderUpdate[];
  deleteProviders?: string[];
};

export type KBrainContentBlock = {
  type: "text" | "thinking" | "image" | "file";
  text?: string;
  image_url?: string;
  file_url?: string;
  filename?: string;
  mime_type?: string;
};

export type KBrainMessage = {
  id?: string;
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: KBrainContentBlock[];
  tool_calls?: KBrainToolCall[];
  tool_call_id?: string;
  name?: string;
  model?: string;
  provider?: string;
  usage?: KBrainUsage;
  hosted_search?: KBrainHostedSearch[];
  stop_reason?: string;
  created_at?: string;
  /** "background" on a user-role notice K-brain delivered on its own (a wait result, a process exit). */
  origin?: string;
  /** Persisted user authorship, exposed by newer backends for history display. */
  authored?: boolean;
};

/** 调用如何运行（仅展示用，均可缺省）：命令类工具的退出码、是否超时，工具自身耗时。 */
export type KBrainToolRunInfo = {
  exit_code?: number;
  timed_out?: boolean;
  duration_ms?: number;
};

/**
 * The answers recorded on a `question` / `AskUserQuestion` call (Stack-Cairn/K-brain#168),
 * in history `tool_calls[]` and on `tool.result`; the same shape as
 * `question.resolved.answers`. Display only; absent for timed-out or cancelled questions
 * and on older backends.
 */
export type KBrainQuestionAnswers = {
  question_answers?: KBrainQuestionAnswer[];
};

/**
 * MCP form elicitations of a tool call (Stack-Cairn/K-brain#174): K-brain's records with
 * sensitive values already removed. Parsed by the shared mcpElicitation module.
 */
export type KBrainToolElicitations = { elicitations?: unknown[] };

export type KBrainToolCall = KBrainToolRunInfo &
  KBrainQuestionAnswers &
  KBrainToolElicitations & {
    id: string;
    name: string;
    arguments: unknown;
  };

export type KBrainToolResult = KBrainToolRunInfo &
  KBrainQuestionAnswers &
  KBrainToolElicitations & {
    content?: KBrainContentBlock[];
    id: string;
    name?: string;
    output: string;
    failed?: boolean;
    cancelled?: boolean;
  };

export type KBrainQuestionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

export type KBrainQuestion = {
  id: string;
  header?: string;
  prompt: string;
  options: KBrainQuestionOption[];
  multiple?: boolean;
};

export type KBrainQuestionRequest = {
  question_id: string;
  tool_call_id: string;
  run_id: string;
  deadline_at: number;
  questions: KBrainQuestion[];
};

/**
 * One answer to `question.requested`. `selected_labels` needs capability
 * `question_selected_labels`; the client downgrades it for older backends.
 */
export type KBrainQuestionAnswer = KBrainQuestionAnswerPayload;

export type KBrainHostedSearch = {
  type: "hostedSearch";
  id: string;
  provider?: string;
  status: "searching" | "completed" | "failed";
  // Go 端 nil 切片会序列化为 null。
  queries: string[] | null;
  sources:
    | {
        url: string;
        title?: string;
        sourceType?: "source" | "citation";
      }[]
    | null;
  error?: string;
};

export type KBrainUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
};

export type KBrainEvent = {
  version: typeof KBRAIN_PROTOCOL_VERSION;
  seq: number;
  id?: string;
  conversation_id: string;
  run_id: string;
  parent_run_id?: string;
  type: string;
  created_at: string;
  payload?: unknown;
};

export type KBrainSession = {
  id: string;
  title?: string;
  cwd?: string;
  model: KBrainModelRef;
  created_at: string;
  updated_at: string;
  message_count: number;
  pinned?: boolean;
  archived?: boolean;
  shared?: boolean;
  /** Source session ID of a branch; older K-brain builds omit it. */
  forked_from?: string;
  fork_seq?: number;
  /**
   * Set while another process sharing the data root (the kn terminal UI, kn run)
   * runs a turn in this session (capability `session_external_runs`). The backend
   * refuses runs and history edits for the session until it is cleared.
   */
  external_run?: KBrainExternalRun;
  messages?: KBrainMessage[];
  active_messages?: KBrainMessage[];
  tasks?: KBrainSubagent[];
  last_seq: number;
  revision?: string;
  oldest_offset?: number;
  has_more_before?: boolean;
  total_message_count?: number;
  sync_epoch?: string;
  sync_revision?: string;
};

export type KBrainExternalRun = {
  client: string;
  pid?: number;
  started_at: string;
};

export type KBrainSessionPage = {
  sessions: KBrainSession[];
  total_count: number;
  version?: string;
  epoch?: string;
  revision?: string;
};

export type KBrainSessionWorkdir = { cwd: string; count: number; updated_at: string };
export type KBrainSyncSnapshot = {
  epoch: string;
  revision: string;
  snapshot_id: string;
  expires_in_seconds: number;
  total_count: number;
  workdirs: KBrainSessionWorkdir[];
};
export type KBrainSyncSnapshotPage = {
  epoch: string;
  revision: string;
  snapshot_id: string;
  total_count: number;
  sessions: KBrainSession[];
  next_offset: number | null;
};
export type KBrainSessionChange =
  | { id: string; revision: string; kind: "delete" }
  | { id: string; revision: string; kind: "upsert"; listed: boolean; session: KBrainSession };
export type KBrainSessionChanges = {
  epoch: string;
  head_revision: string;
  next_since: string | null;
  reset: boolean;
  reset_reason?: string;
  more: boolean;
  changes: KBrainSessionChange[];
};

export type KBrainHistoryResponse = {
  session: KBrainSession;
  message_offsets?: number[];
  revision: string;
  oldest_offset: number;
  has_more_before: boolean;
  total_message_count: number;
  active_messages?: KBrainMessage[];
};

export type KBrainMessageRef = {
  segment_index: number;
  message_index: number;
  segment_id: string;
  message_id: string;
  role: string;
  content_hash: string;
};

export type KBrainBranchRequest = {
  message_ref: KBrainMessageRef;
  expected_revision?: string;
  title?: string;
};

export type KBrainEditRequest = {
  message_ref: KBrainMessageRef;
  replacement: KBrainMessage;
  expected_revision: string;
};

export type KBrainSharedProjection = {
  conversation_id: string;
  title: string;
  messages: KBrainMessage[];
};

export type KBrainShareStatus = {
  conversation_id: string;
  enabled: boolean;
  token?: string;
  created_at?: string;
  updated_at?: string;
  redact_tool_content?: boolean;
};

export type KBrainSubagent = {
  id: string;
  parent_id?: string;
  description: string;
  status: string;
  model: KBrainModelRef;
  attempt?: number;
  report?: string;
  error?: string;
  started_at?: string;
  updated_at?: string;
  ended_at?: string;
  /** The parent's `subagent` tool call that started it (backends with subagent_transcripts). */
  parent_tool_call_id?: string;
  background?: boolean;
  usage?: KBrainUsage;
  tool_count?: number;
  duration_ms?: number;
  /**
   * Runs in another process sharing the session store (a kn terminal). Its events
   * are not streamed; the list and transcript are polled while it runs.
   */
  external?: boolean;
};

export type KBrainSubagentEvent = {
  subagent: KBrainSubagent;
};

/** GET /v1/sessions/{id}/subagents */
export type KBrainSubagentList = {
  subagents?: KBrainSubagent[];
  last_seq?: number;
};

/** GET /v1/sessions/{id}/subagents/{task}: the transcript so far. */
export type KBrainSubagentTranscript = {
  subagent: KBrainSubagent;
  messages?: KBrainMessage[];
  last_seq?: number;
  live?: boolean;
};

export type KBrainCreateSessionRequest = {
  cwd?: string;
  model: KBrainModelRef;
  title?: string;
  messages?: KBrainMessage[];
};

export type KBrainUpdateSessionRequest = {
  title?: string;
  pinned?: boolean;
  model?: KBrainModelRef;
  /** Moves the session to another workspace (absolute path to an existing directory). */
  cwd?: string;
  /** Hides the session from the default list (capability `session_archive`). */
  archived?: boolean;
};

export type KBrainRunOptions = {
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  mode?: "chat" | "agent";
  search?: "disabled" | "enabled";
  approval_policy?: "ask" | "auto" | "deny";
  permission_mode?: import("@liveagent/ui/lib/chat/permissionModes").KBrainPermissionMode;
  /** Sent by the client only when K-brain advertises capability ai_review_per_run. */
  review_scope?: "per_run";
  workspace_roots?: Array<{ path: string; access: "read" | "write" }>;
  tools?: { policies?: Record<string, "ask" | "allow" | "deny"> };
  plan_mode_enabled?: boolean;
  /** OS confinement for the run's commands; sent only when capability run_sandbox allows it. */
  sandbox?: import("@liveagent/ui/lib/chat/permissionModes").KBrainRunSandbox;
  /** Desktop-executed tools offered to the model for this run (e.g. Browser). */
  client_tools?: KBrainClientToolDefinition[];
  /**
   * Relay MCP form elicitations to this client (`elicitation.*` events). Sent only when
   * K-brain advertises capability mcp_elicitation: older backends reject unknown options.
   */
  mcp_elicitation?: boolean;
  /**
   * MCP servers K-brain may offer in this run. Omitted means K-brain's saved
   * selection (or every enabled server); an empty list means the same, so "no
   * server" is sent as an id that matches none (KBRAIN_NO_MCP_SERVERS).
   */
  mcp_server_ids?: string[];
};

/** `capabilities.run_sandbox` in /v1/health; every field may be absent on older backends. */
export type KBrainRunSandboxCapability = {
  supported?: boolean;
  version?: string;
  mechanism?: string;
  platform?: string;
  network_control?: boolean;
  read_masking?: boolean;
  path_protection?: boolean;
  modes?: string[];
  reason?: string;
  /**
   * Windows (capability `sandbox_setup` 1): `POST /v1/sandbox/setup` can install the
   * sandbox accounts that let the offline sandbox cut the network.
   */
  setup_available?: boolean;
  /** Short English text for the user about setup; empty once `sandbox-user` works. */
  setup_hint?: string;
};

export type KBrainClientToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Payload of the client_tool.requested event. */
export type KBrainClientToolRequest = {
  call_id: string;
  tool_call_id: string;
  run_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  deadline_at: number;
};

export type KBrainClientToolResult = {
  text: string;
  images?: Array<{ mime_type: string; data: string }>;
  is_error?: boolean;
};

export type KBrainPromptRequest = {
  conversation_id: string;
  client_request_id: string;
  turn_id?: string;
  prompt: string;
  content?: KBrainContentBlock[];
  model?: KBrainModelRef;
  resume_message_id?: string;
  options?: KBrainRunOptions;
  hook_policy?: "backend";
  hook_scope_id?: string;
  stop_requested?: boolean;
  /** prompt 为“/名称 参数”形式的提示词指令；后端展开给模型，历史保留原文。 */
  prompt_command?: boolean;
};

/** 会话目标；continuing 事件带上后端即将发起的下一轮请求标识。 */
export type KBrainGoalState = {
  version: typeof KBRAIN_PROTOCOL_VERSION;
  conversation_id: string;
  goal: string;
  status: "none" | "active" | "continuing" | "met" | "paused" | "cleared";
  round: number;
  max_rounds: number;
  reason?: string;
  next_client_request_id?: string;
  next_prompt?: string;
  /** 目标设定或最近一次恢复的时间（RFC 3339）。 */
  started_at?: string;
  run?: KBrainRunAccepted;
};

export type KBrainGoalRequest =
  | { action: "set"; goal: string; run: Omit<KBrainPromptRequest, "conversation_id"> }
  | { action: "resume"; run: Omit<KBrainPromptRequest, "conversation_id"> }
  | { action: "pause" }
  | { action: "update"; goal: string }
  | { action: "clear" };

/** /loop：绑定到会话的定时提示词。interval 是输入框的写法（10m、2h、1d）。 */
export type KBrainSessionLoop = {
  id: string;
  interval: string;
  cron: string;
  prompt: string;
  enabled: boolean;
};

/** 桌面端“/”指令目录项：action 由客户端按名称处理，prompt 以 prompt_command 发送。 */
export type KBrainSlashCommand = {
  name: string;
  description: string;
  argument_hint?: string;
  kind: "action" | "prompt";
  source: "builtin" | "user" | "project" | string;
};

export type KBrainRunAccepted = {
  version: typeof KBRAIN_PROTOCOL_VERSION;
  conversation_id: string;
  run_id: string;
  accepted_seq: number;
};

export type KBrainCompactAccepted = KBrainRunAccepted & {
  status: "accepted" | "completed" | "failed" | "cancelled";
  revision?: string;
};

export type KBrainTextGenerateRequest = {
  model: KBrainModelRef;
  messages: KBrainMessage[];
  output?: "text" | "json";
};

export type KBrainTextGenerateResponse = {
  version: typeof KBRAIN_PROTOCOL_VERSION;
  text: string;
  model: KBrainModelRef;
  usage?: KBrainUsage;
};

export type KBrainClientOptions = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};
