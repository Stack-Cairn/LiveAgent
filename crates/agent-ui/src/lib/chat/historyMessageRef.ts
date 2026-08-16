export type HistoryMessageRef = {
  segmentIndex: number;
  messageIndex: number;
  segmentId: string;
  messageId: string;
  role: string;
  contentHash: string;
};

export type HistoryMessageRefPayload = {
  segment_index: number;
  message_index: number;
  segment_id: string;
  message_id: string;
  role: string;
  content_hash: string;
};

export function buildHistoryMessageRefPayload(ref: HistoryMessageRef): HistoryMessageRefPayload {
  return {
    segment_index: ref.segmentIndex,
    message_index: ref.messageIndex,
    segment_id: ref.segmentId,
    message_id: ref.messageId,
    role: ref.role,
    content_hash: ref.contentHash,
  };
}
