import { type ChatEntry, parseHistoryMessagesJson } from "./chatUi";

type HistoryParseWorkerRequest = {
  type: "parse-history";
  requestId: string;
  raw: string;
};

type HistoryParseWorkerResponse =
  | {
      type: "parsed-history";
      requestId: string;
      entries: ChatEntry[];
    }
  | {
      type: "parse-history-error";
      requestId: string;
      message: string;
    };

function asErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error ?? "unknown error");
}

self.onmessage = (event: MessageEvent<HistoryParseWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "parse-history") {
    return;
  }

  try {
    const entries = parseHistoryMessagesJson(message.raw);
    self.postMessage({
      type: "parsed-history",
      requestId: message.requestId,
      entries,
    } satisfies HistoryParseWorkerResponse);
  } catch (error) {
    self.postMessage({
      type: "parse-history-error",
      requestId: message.requestId,
      message: asErrorMessage(error),
    } satisfies HistoryParseWorkerResponse);
  }
};
