import type {
  ChatRuntimeControls,
  CodexRequestFormat,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
} from "@/lib/settings";

export type AgentStatus = {
  online: boolean;
  agent_ready?: boolean;
  chat_runtime_ready?: boolean;
  agent_id?: string;
  name?: string;
  agent_version?: string;
  session_id?: string;
  connected_since?: number;
  last_heartbeat?: number;
  runtime_state?: "ready" | "draining" | "busy" | "suspended" | string;
  runtime_last_heartbeat?: number;
  runtime_worker_id?: string;
  runtime_visible?: boolean;
  runtime_active_run_count?: number;
};

export type GatewaySelectedModel = {
  customProviderId: string;
  model: string;
  providerType: ProviderId;
};

export type GatewayChatRuntimeControls = Pick<
  ChatRuntimeControls,
  "thinkingEnabled" | "nativeWebSearchEnabled" | "reasoning"
>;

export type GatewayProviderSummary = {
  id: string;
  name: string;
  type: ProviderId;
  models: ProviderModelConfig[];
  activeModels: string[];
  requestFormat?: CodexRequestFormat;
  reasoning: ReasoningLevel;
  promptCachingEnabled: boolean;
  nativeWebSearchEnabled: boolean;
};

export type ChatCheckpointPayload = {
  summaryId?: string;
  segmentIndex?: number;
  coveredMessageCount?: number;
  coversThroughMessageId?: string;
  timestamp?: number;
  generatedBy?: {
    providerId?: string;
    model?: string;
    promptVersion?: string;
  };
};

export type ChatUserMessageEvent = {
  type: "user_message";
  client_request_id?: string;
  conversation_id?: string;
  message_id?: string;
  message?: string;
  uploaded_files?: unknown;
  // The new message's own persisted identity (desktop mints it at persist
  // time) — lets subscribers bind the turn's messageRef immediately.
  message_ref?: unknown;
  base_message_ref?: unknown;
  reason?: string;
};

export type ChatRebasedEvent = {
  type: "rebased";
  conversation_id?: string;
  base_message_ref?: unknown;
  reason?: string;
};

export type ChatEvent = (
  | {
      type: "token";
      text: string;
      title?: string;
      titleFinal?: boolean;
      round?: number;
      provider?: string;
      model?: string;
      api?: string;
      stopReason?: string;
      usage?: unknown;
      checkpoint?: ChatCheckpointPayload;
      conversation_id?: string;
    }
  | { type: "thinking"; text: string; round?: number; conversation_id?: string }
  | {
      type: "tool_call" | "tool_call_delta";
      id?: string;
      name?: string;
      arguments?: unknown;
      args?: unknown;
      input?: unknown;
      parameters?: unknown;
      toolCall?: unknown;
      payload?: unknown;
      data?: unknown;
      round?: number;
      conversation_id?: string;
    }
  | {
      type: "tool_result";
      id?: string;
      name?: string;
      arguments?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: boolean;
      round?: number;
      conversation_id?: string;
    }
  | {
      type: "hosted_search";
      id?: string;
      provider?: string;
      status?: "searching" | "completed" | "failed";
      queries?: string[];
      sources?: Array<{
        url: string;
        title?: string;
        snippet?: string;
        citedText?: string;
        sourceType?: "source" | "citation";
      }>;
      updatedAt?: number;
      round?: number;
      conversation_id?: string;
    }
  | { type: "done"; title?: string; round?: number; conversation_id?: string }
  | {
      type: "tool_status";
      status?: string | null;
      isCompaction?: boolean;
      // Stream-retry history of the live run: null/absent = unchanged, an
      // array (possibly empty) replaces the current list.
      retryAttempts?: { attempt: number; maxAttempts: number; errorMessage: string }[] | null;
      round?: number;
      conversation_id?: string;
    }
  | { type: "error"; message: string; round?: number; conversation_id?: string }
  | ChatUserMessageEvent
  | ChatRebasedEvent
) & { seq?: number; workdir?: string };

export type CronManagePayload = {
  action: string;
  task_id?: string;
  task_json?: string;
};

export type ChatQueueItemSummary = {
  id: string;
  previewText: string;
  fileCount: number;
  createdAt: number;
  source: "gui" | "webui";
  editable: boolean;
};

export type ChatQueueSnapshot = {
  conversationId: string;
  revision: number;
  items: ChatQueueItemSummary[];
};

export type ChatQueueItemDetail = ChatQueueItemSummary & {
  draftJson: string;
  uploadedFilesJson: string;
};

export type ChatQueueResponse = {
  accepted: boolean;
  message?: string;
  snapshot?: ChatQueueSnapshot;
  item?: ChatQueueItemDetail;
  errorCode?: string;
  revision?: number;
};

export type CronManageResponse = {
  action: string;
  result_json: string;
};

export type MemoryManagePayload = {
  command: string;
  args?: unknown;
};

export type ConversationSummary = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  provider_id?: string;
  model?: string;
  session_id?: string;
  cwd?: string;
  selected_model_json?: string;
  is_pinned?: boolean;
  pinned_at?: number;
  is_shared?: boolean;
};

export type HistoryList = {
  conversations: ConversationSummary[];
  total_count: number;
  running_conversations?: RunningConversationSummary[];
};

// history.list `running_conversations` items — the gateway's activity
// registry snapshot at response time.
export type RunningConversationSummary = {
  conversation_id: string;
  run_id?: string;
  state?: string;
  cwd?: string;
  updated_at?: number;
};

export type HistoryListFilter = {
  cwd?: string;
  cwdEmpty?: boolean;
};

export type HistoryWorkdirSummary = {
  path: string;
  conversationCount: number;
  updatedAt: number;
};

export type HistoryWorkdirsResponse = {
  workdirs: HistoryWorkdirSummary[];
};

export type CreateProjectFolderResponse = {
  path: string;
};

export type HistoryDetail = {
  conversation_id: string;
  messages_json: string;
  total_message_count?: number;
  returned_message_count?: number;
  has_more?: boolean;
  conversation?: ConversationSummary;
};

export type HistoryShareStatus = {
  conversation_id: string;
  enabled: boolean;
  token?: string;
  created_at?: number;
  updated_at?: number;
  redact_tool_content?: boolean;
};

export type SharedHistoryDetail = {
  conversation_id: string;
  messages_json: string;
  total_message_count?: number;
  conversation?: ConversationSummary;
  redact_tool_content?: boolean;
};

export type GatewayHistoryEvent =
  | {
      kind: "upsert";
      conversation_id: string;
      conversation: ConversationSummary;
    }
  | {
      kind: "delete";
      conversation_id: string;
      conversation?: undefined;
    };
