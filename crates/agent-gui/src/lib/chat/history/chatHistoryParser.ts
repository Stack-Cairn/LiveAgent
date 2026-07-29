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

type WorkerResponse = {
  requestId: number;
  segments?: Array<{
    payload: unknown;
    summary?: StoredSummaryMessage;
    messages: unknown;
  }>;
  error?: string;
};

type PendingRequest = {
  resolve: (segments: ParsedHistorySegment<unknown>[]) => void;
  reject: (error: Error) => void;
};

let parserWorker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

function rejectPendingRequests(message: string) {
  const error = new Error(message);
  for (const pending of pendingRequests.values()) {
    pending.reject(error);
  }
  pendingRequests.clear();
}

function getParserWorker() {
  if (parserWorker) return parserWorker;

  const worker = new Worker(new URL("./chatHistoryParser.worker.ts", import.meta.url), {
    type: "module",
    name: "chat-history-parser",
  });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    pendingRequests.delete(response.requestId);
    if (response.error) {
      pending.reject(new Error(`历史消息解析失败：${response.error}`));
      return;
    }
    const segments = response.segments ?? [];
    if (segments.some((segment) => !Array.isArray(segment.messages))) {
      pending.reject(new Error("历史分段消息格式无效"));
      return;
    }
    pending.resolve(segments as ParsedHistorySegment<unknown>[]);
  };
  worker.onerror = (event) => {
    rejectPendingRequests(`历史消息解析 Worker 失败：${event.message}`);
    worker.terminate();
    if (parserWorker === worker) parserWorker = null;
  };
  worker.onmessageerror = () => {
    rejectPendingRequests("历史消息解析 Worker 消息反序列化失败");
    worker.terminate();
    if (parserWorker === worker) parserWorker = null;
  };
  parserWorker = worker;
  return worker;
}

export function parseHistorySegments<TPayload>(
  segments: SerializedHistorySegment<TPayload>[],
): Promise<ParsedHistorySegment<TPayload>[]> {
  if (segments.length === 0) return Promise.resolve([]);
  const requestId = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      resolve: (parsed) => resolve(parsed as ParsedHistorySegment<TPayload>[]),
      reject,
    });
    try {
      getParserWorker().postMessage({ requestId, segments });
    } catch (error) {
      pendingRequests.delete(requestId);
      throw error;
    }
  });
}
