import type { ChatEvent } from "./gatewayTypes";
import type { ChatEntry } from "./chatUi";
import { isLocalDraftConversationId } from "./localDraftConversation";

const CHAT_STREAM_NOT_AVAILABLE_RE = /\bchat stream not available\b/i;

export type ChatStreamUnavailableRecoveryAction =
  | "refresh-history-snapshot"
  | "reload-history";

export function isChatStreamNotAvailableMessage(value: unknown) {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : String(value ?? "");
  return CHAT_STREAM_NOT_AVAILABLE_RE.test(message.trim());
}

export function isChatStreamNotAvailableEvent(event: ChatEvent) {
  return (
    event.type === "error" &&
    isChatStreamNotAvailableMessage(event.message)
  );
}

export function resolveChatStreamUnavailableRecoveryAction(
  conversationId: string,
): ChatStreamUnavailableRecoveryAction {
  return isLocalDraftConversationId(conversationId)
    ? "reload-history"
    : "refresh-history-snapshot";
}

function collectAssistantLikeText(entries: ChatEntry[]) {
  return entries
    .map((entry) => {
      if (entry.kind === "assistant" || entry.kind === "thinking" || entry.kind === "error") {
        return entry.text;
      }
      return "";
    })
    .join("\n")
    .trim();
}

export function shouldHydrateRestoredConversationSnapshot(params: {
  currentEntries: ChatEntry[];
  historyEntries: ChatEntry[];
  liveEntries?: ChatEntry[];
}) {
  const historyEntries = params.historyEntries;
  if (historyEntries.length === 0) {
    return false;
  }

  const currentEntries = params.currentEntries;
  const liveEntries = params.liveEntries ?? [];
  if (currentEntries.length === 0 && liveEntries.length === 0) {
    return true;
  }

  const currentAssistantText = collectAssistantLikeText([...currentEntries, ...liveEntries]);
  const historyAssistantText = collectAssistantLikeText(historyEntries);
  if (historyAssistantText.length === 0) {
    return liveEntries.length === 0 && historyEntries.length > currentEntries.length;
  }
  if (currentAssistantText.length === 0) {
    return true;
  }
  return historyAssistantText.length > currentAssistantText.length;
}
