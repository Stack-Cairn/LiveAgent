import { invoke } from "@liveagent/app/shims/tauriCore";

export type ChatHistorySearchMatch = {
  source: "message" | "segment" | string;
  conversationId: string;
  title: string;
  cwd?: string | null;
  segmentIndex: number;
  segmentId: string;
  messageIndex?: number | null;
  messageId?: string | null;
  role?: string | null;
  snippet: string;
  score: number;
  rawScore?: number | null;
  updatedAt: number;
};

export type ChatHistorySearchArgs = {
  query: string;
  limit?: number;
};

export type ChatHistorySearchResponse = {
  matches: ChatHistorySearchMatch[];
};

/** Search the persisted conversation database across every workspace. */
export async function searchChatHistory(
  args: ChatHistorySearchArgs,
): Promise<ChatHistorySearchResponse> {
  return invoke<ChatHistorySearchResponse>("chat_history_search", { args });
}
