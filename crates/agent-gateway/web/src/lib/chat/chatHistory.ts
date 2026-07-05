// Conversation summary shape shared with the gateway's history.list /
// history.event payloads. The webui only consumes summaries — transcript
// content arrives as messages_json parsed by lib/chatUi. The canonical shape
// lives in the mirrored sidebar state layer; this alias keeps the historical
// name for the web components that render summaries.
export type { SidebarConversation as ChatHistorySummary } from "../sidebar/types";
