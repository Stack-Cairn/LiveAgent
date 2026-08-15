import { type ChatEntry, parseHistoryMessagesJson } from "./chatUi";

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

type PendingParse = {
  resolve: (entries: ChatEntry[]) => void;
  reject: (error: Error) => void;
};

const HISTORY_PARSE_WORKER_MIN_CHARS = 512 * 1024;

let parseRequestSeq = 0;
let parserWorker: Worker | null = null;
let parserWorkerFailed = false;
const pendingParses = new Map<string, PendingParse>();

function yieldToMainThread() {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function rejectPendingParses(error: Error) {
  for (const pending of pendingParses.values()) {
    pending.reject(error);
  }
  pendingParses.clear();
}

function disposeParserWorker(error?: Error) {
  if (parserWorker) {
    parserWorker.terminate();
  }
  parserWorker = null;
  if (error) {
    parserWorkerFailed = true;
    rejectPendingParses(error);
  }
}

function getParserWorker() {
  if (parserWorkerFailed || typeof Worker === "undefined") {
    return null;
  }
  if (parserWorker) {
    return parserWorker;
  }

  try {
    const worker = new Worker(new URL("./historyParser.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<HistoryParseWorkerResponse>) => {
      const response = event.data;
      const pending = pendingParses.get(response.requestId);
      if (!pending) {
        return;
      }
      pendingParses.delete(response.requestId);

      if (response.type === "parsed-history") {
        pending.resolve(response.entries);
        return;
      }
      pending.reject(new Error(response.message || "history parse worker failed"));
    };
    worker.onerror = (event) => {
      disposeParserWorker(new Error(event.message || "history parse worker failed"));
    };
    parserWorker = worker;
    return parserWorker;
  } catch {
    parserWorkerFailed = true;
    return null;
  }
}

function parseHistoryMessagesJsonInWorker(raw: string) {
  const worker = getParserWorker();
  if (!worker) {
    return null;
  }

  parseRequestSeq += 1;
  const requestId = `history-parse-${Date.now()}-${parseRequestSeq}`;
  return new Promise<ChatEntry[]>((resolve, reject) => {
    pendingParses.set(requestId, { resolve, reject });
    try {
      worker.postMessage({
        type: "parse-history",
        requestId,
        raw,
      });
    } catch (error) {
      pendingParses.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function parseHistoryMessagesJsonAsync(raw: string): Promise<ChatEntry[]> {
  if (raw.length < HISTORY_PARSE_WORKER_MIN_CHARS) {
    return parseHistoryMessagesJson(raw);
  }

  const workerParse = parseHistoryMessagesJsonInWorker(raw);
  if (workerParse) {
    try {
      return await workerParse;
    } catch {
      // Fall through to the sync parser so history still opens if Worker startup fails.
    }
  }

  await yieldToMainThread();
  return parseHistoryMessagesJson(raw);
}
