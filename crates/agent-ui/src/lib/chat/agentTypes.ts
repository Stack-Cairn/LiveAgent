import type { HostedSearchBlock } from "./hostedSearch";

export type Api = string;
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<"off" | ThinkingLevel, string | null>>;
export type ProviderHeaders = Record<string, string | null>;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface FileContent {
  type: "file";
  data: string;
  mimeType: string;
  filename?: string;
}

/** Optional fields retained only for replaying legacy persisted thinking blocks. */
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ToolCallArguments {
  [key: string]: unknown;
  action?: string;
  command?: string;
  cwd?: string;
  cursor?: number | string;
  isolated?: boolean;
  label?: string;
  max_bytes?: number;
  process_id?: string;
  session_id?: string;
  yield_time_ms?: number;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: ToolCallArguments;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent | FileContent)[];
  timestamp: number;
  id?: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall | HostedSearchBlock)[];
  api: Api;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  rawStopReason?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent | FileContent)[];
  details?: TDetails;
  usage?: Usage;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

export interface Tool<TParameters = unknown> {
  name: string;
  description: string;
  parameters: TParameters;
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | {
      type: "text_start" | "text_delta" | "text_end";
      contentIndex: number;
      partial: AssistantMessage;
      delta?: string;
      content?: string;
    }
  | {
      type: "thinking_start" | "thinking_delta" | "thinking_end";
      contentIndex: number;
      partial: AssistantMessage;
      delta?: string;
      content?: string;
    }
  | {
      type: "toolcall_start" | "toolcall_delta";
      contentIndex: number;
      partial: AssistantMessage;
      delta?: string;
    }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
      message: AssistantMessage;
    }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  push?(event: AssistantMessageEvent): void;
  end?(result?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}
