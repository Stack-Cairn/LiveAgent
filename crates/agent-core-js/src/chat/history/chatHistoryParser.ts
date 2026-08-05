import type { Message } from "@earendil-works/pi-ai";
import type { StoredSummaryMessage } from "../conversation/conversationState";

export type SerializedHistorySegment<TPayload> = {
  payload: TPayload;
  summaryJson?: string | null;
  messagesJson: string;
};

export type ParsedHistorySegment<TPayload> = {
  payload: TPayload;
  summary?: StoredSummaryMessage;
  messages: Message[];
};

function parseSynchronously<TPayload>(
  segments: SerializedHistorySegment<TPayload>[],
): ParsedHistorySegment<TPayload>[] {
  return segments.map((segment) => ({
    payload: segment.payload,
    summary: segment.summaryJson ? JSON.parse(segment.summaryJson) : undefined,
    messages: JSON.parse(segment.messagesJson) as Message[],
  }));
}

export function parseHistorySegments<TPayload>(
  segments: SerializedHistorySegment<TPayload>[],
): Promise<ParsedHistorySegment<TPayload>[]> {
  if (segments.length === 0) return Promise.resolve([]);

  try {
    const parsed = parseSynchronously(segments);
    if (parsed.some((segment) => !Array.isArray(segment.messages))) {
      return Promise.reject(new Error("历史分段消息格式无效"));
    }
    return Promise.resolve(parsed);
  } catch (error) {
    return Promise.reject(
      new Error(`历史消息解析失败：${error instanceof Error ? error.message : String(error)}`),
    );
  }
}
