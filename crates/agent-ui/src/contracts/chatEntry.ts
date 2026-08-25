import type { HostedSearchBlock } from "../lib/chat/hostedSearch";
import type { PendingUploadedFile } from "../lib/chat/uploadedFiles";

export type SharedChatEntry<
  TToolCall,
  TToolResult,
  TAssistantMeta,
  TUserExtra extends object = object,
  TAssistantExtra extends object = object,
> =
  | ({
      id: string;
      kind: "user";
      text: string;
      attachments: PendingUploadedFile[];
    } & TUserExtra)
  | ({
      id: string;
      kind: "assistant";
      text: string;
      round?: number;
      meta?: TAssistantMeta;
    } & TAssistantExtra)
  | { id: string; kind: "thinking"; text: string; round?: number; replayTokenUnits?: number }
  | {
      id: string;
      kind: "tool_call";
      round?: number;
      toolCall: TToolCall;
      summary?: string;
      text: string;
    }
  | {
      id: string;
      kind: "tool_result";
      round?: number;
      toolResult: TToolResult;
      summary?: string;
      text: string;
    }
  | {
      id: string;
      kind: "hosted_search";
      round?: number;
      hostedSearch: HostedSearchBlock;
    }
  | { id: string; kind: "error"; text: string };
