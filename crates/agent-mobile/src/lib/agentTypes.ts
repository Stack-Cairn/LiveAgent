import type { TSchema } from "@sinclair/typebox";

export type TextContent = {
  type: "text";
  text: string;
  textSignature?: string;
};

export type ThinkingContent = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};

export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
};

export type HostedSearchContent = {
  type: "hostedSearch";
  id: string;
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
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type UserMessage = {
  role: "user";
  id: string;
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall | HostedSearchContent)[];
  api: string;
  provider: string;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
};

export type ToolResultMessage<TDetails = unknown> = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type Tool<TParameters extends TSchema = TSchema> = {
  name: string;
  description: string;
  parameters: TParameters;
};

export type Context = {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
};
