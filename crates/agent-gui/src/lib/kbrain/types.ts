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
};

export type KBrainToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type KBrainToolResult = {
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

export type KBrainQuestionAnswer = {
  question_id: string;
  selected_label: string;
  custom?: boolean;
};

export type KBrainHostedSearch = {
  type: "hostedSearch";
  id: string;
  provider?: string;
  status: "searching" | "completed" | "failed";
  queries: string[];
  sources: {
    url: string;
    title?: string;
    sourceType?: "source" | "citation";
  }[];
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
  messages?: KBrainMessage[];
  active_messages?: KBrainMessage[];
  tasks?: KBrainSubagent[];
  last_seq: number;
  revision?: string;
  oldest_offset?: number;
  has_more_before?: boolean;
  total_message_count?: number;
};

export type KBrainSessionPage = {
  sessions: KBrainSession[];
  total_count: number;
  version?: string;
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
};

export type KBrainSubagentEvent = {
  subagent: KBrainSubagent;
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
};

export type KBrainRunOptions = {
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  mode?: "chat" | "agent";
  search?: "disabled" | "enabled";
  approval_policy?: "ask" | "auto" | "deny";
  workspace_roots?: Array<{ path: string; access: "read" | "write" }>;
  tools?: { policies?: Record<string, "ask" | "allow" | "deny"> };
  plan_mode_enabled?: boolean;
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
