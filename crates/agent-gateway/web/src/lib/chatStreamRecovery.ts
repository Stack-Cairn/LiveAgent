import type { ChatEvent } from "./gatewayTypes";
import type { ChatEntry } from "./chatUi";
import { isLocalDraftConversationId } from "./localDraftConversation";

const CHAT_STREAM_NOT_AVAILABLE_RE = /\bchat stream not available\b/i;
const RECOVERABLE_TRANSPORT_STATUS_CODES = new Set([408, 425, 429, 502, 503, 504, 520, 521, 522, 523, 524]);
const RECOVERABLE_TRANSPORT_MESSAGE_RE =
  /\b(?:502\s+bad\s+gateway|503\s+service\s+unavailable|504\s+gateway\s+timeout|bad\s+gateway|gateway\s+timeout|service\s+unavailable|temporarily\s+unavailable|failed\s+to\s+fetch|networkerror|network\s+error|load\s+failed|connection\s+(?:reset|closed|lost)|socket\s+hang\s+up|err_(?:network|internet_disconnected|connection_(?:reset|closed|refused)))\b/i;

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

export function isRecoverableChatStreamTransportStatus(status: number) {
  return Number.isInteger(status) && RECOVERABLE_TRANSPORT_STATUS_CODES.has(status);
}

export function isRecoverableChatStreamTransportMessage(value: unknown) {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : String(value ?? "");
  return RECOVERABLE_TRANSPORT_MESSAGE_RE.test(message.trim());
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
  serverIdle?: boolean;
}) {
  const historyEntries = params.historyEntries;
  if (historyEntries.length === 0) {
    return false;
  }
  if (params.serverIdle === true) {
    return true;
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

export function shouldRecoverIdleConversationSnapshot(params: {
  isVisibleConversation: boolean;
  isHistoryHydrationBlocked: boolean;
  isChatBusy: boolean;
  hasLocalDraft: boolean;
  hasRetainedLiveTranscript: boolean;
  hasRecentlyCompletedLiveStream: boolean;
}) {
  return (
    params.isVisibleConversation &&
    !params.isHistoryHydrationBlocked &&
    !params.isChatBusy &&
    !params.hasLocalDraft &&
    params.hasRetainedLiveTranscript &&
    !params.hasRecentlyCompletedLiveStream
  );
}
