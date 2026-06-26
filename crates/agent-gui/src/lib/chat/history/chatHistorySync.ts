import { mergeHistoryItem } from "../page/chatPageHelpers";
import type { ChatHistorySummary } from "./chatHistory";

export const CHAT_HISTORY_SYNC_EVENT = "chat-history:changed";

export type ChatHistorySyncEvent =
  | {
      kind: "upsert";
      conversationId: string;
      conversation: ChatHistorySummary;
    }
  | {
      kind: "delete";
      conversationId: string;
      conversation?: undefined;
    }
  | {
      kind: "running" | "idle" | "queue_drained";
      conversationId: string;
      conversation?: Partial<ChatHistorySummary>;
    };

export function applyChatHistorySyncEvent(
  items: ChatHistorySummary[],
  event: ChatHistorySyncEvent,
): ChatHistorySummary[] {
  switch (event.kind) {
    case "delete":
      return items.filter((item) => item.id !== event.conversationId);
    case "running":
    case "idle":
      return items;
    case "upsert":
      return mergeHistoryItem(items, {
        ...event.conversation,
        isPending: false,
      });
  }
}
