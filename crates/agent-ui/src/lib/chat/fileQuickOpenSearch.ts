import { invokeFs } from "../tools/fsBackend";
import { QUICK_OPEN_DEFAULT_LIMIT, type QuickOpenMatch } from "./fileQuickOpen";
import {
  type QuickOpenWorkerRequest,
  type QuickOpenWorkerResponse,
  runQuickOpenWorkerRequest,
} from "./fileQuickOpenProtocol";

/**
 * Client side of the palette's `@` file search: holds the workspace file list
 * (loaded once per palette session from the gitignore-aware backend listing)
 * and runs the fuzzy match in a Web Worker so typing never blocks the UI.
 * Results of superseded searches are dropped by sequence number.
 */

export type QuickOpenSearchClient = {
  setIndex: (key: string, paths: readonly string[]) => void;
  /** Resolves with matches, or null when a newer search superseded this one. */
  search: (key: string, query: string, limit?: number) => Promise<QuickOpenMatch[] | null>;
  /** True once searches run on a worker (false: synchronous fallback). */
  readonly usesWorker: boolean;
  dispose: () => void;
};

type WorkerFactory = () => Worker | null;

function defaultWorkerFactory(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./fileQuickOpen.worker.ts", import.meta.url), {
      type: "module",
      name: "palette-quick-open",
    });
  } catch {
    return null;
  }
}

export function createQuickOpenSearchClient(
  options: { createWorker?: WorkerFactory } = {},
): QuickOpenSearchClient {
  let worker = (options.createWorker ?? defaultWorkerFactory)();
  // The fallback mirrors the worker's state so a worker failure loses nothing.
  const localIndexes = new Map<string, readonly string[]>();
  type Pending = {
    request: QuickOpenWorkerRequest;
    resolve: (matches: QuickOpenMatch[] | null) => void;
  };
  const pending = new Map<number, Pending>();
  let latestSeq = 0;

  const settle = (response: QuickOpenWorkerResponse) => {
    const entry = pending.get(response.seq);
    if (!entry) return;
    pending.delete(response.seq);
    entry.resolve(response.seq === latestSeq ? response.matches : null);
  };

  const runLocally = (request: QuickOpenWorkerRequest) => {
    const response = runQuickOpenWorkerRequest(localIndexes, request);
    if (response) settle(response);
  };

  const dropWorker = () => {
    worker?.terminate();
    worker = null;
    // Answer whatever the worker still owed from the local mirror.
    for (const entry of [...pending.values()]) runLocally(entry.request);
  };

  if (worker) {
    worker.onmessage = (event: MessageEvent<QuickOpenWorkerResponse>) => settle(event.data);
    worker.onerror = dropWorker;
    worker.onmessageerror = dropWorker;
  }

  return {
    get usesWorker() {
      return worker !== null;
    },
    setIndex(key, paths) {
      localIndexes.set(key, paths);
      worker?.postMessage({ type: "index", key, paths } satisfies QuickOpenWorkerRequest);
    },
    search(key, query, limit = QUICK_OPEN_DEFAULT_LIMIT) {
      latestSeq += 1;
      const seq = latestSeq;
      // Anything still in flight is stale now.
      for (const [pendingSeq, entry] of pending) {
        pending.delete(pendingSeq);
        entry.resolve(null);
      }
      const request: QuickOpenWorkerRequest = { type: "search", seq, key, query, limit };
      return new Promise((resolve) => {
        pending.set(seq, { request, resolve });
        if (worker) {
          try {
            worker.postMessage(request);
            return;
          } catch {
            dropWorker();
          }
        }
        // Async like the worker so callers see one contract.
        queueMicrotask(() => runLocally(request));
      });
    },
    dispose() {
      dropWorker();
      localIndexes.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace file index
// ---------------------------------------------------------------------------

type MentionListResponse = {
  entries: Array<{ path: string; kind: "file" | "dir"; hidden?: boolean }>;
  truncated: boolean;
};

export type QuickOpenFileIndex = {
  workdir: string;
  paths: readonly string[];
  truncated: boolean;
};

/** Large enough for most repositories; the backend reports `truncated` beyond it. */
export const QUICK_OPEN_MAX_FILES = 20_000;
/** A palette session reuses a listing this fresh instead of walking the tree again. */
export const QUICK_OPEN_INDEX_TTL_MS = 30_000;

type ListFiles = (workdir: string) => Promise<MentionListResponse>;

const defaultListFiles: ListFiles = (workdir) =>
  invokeFs<MentionListResponse>("fs_mention_list", {
    workdir,
    max_results: QUICK_OPEN_MAX_FILES,
    query: "",
  });

const indexCache = new Map<string, { loadedAt: number; promise: Promise<QuickOpenFileIndex> }>();

/**
 * Files (not folders) of `workdir`, relative paths, honouring .gitignore and
 * hidden-file rules exactly like the file tree and the composer's @ mention.
 */
export function loadQuickOpenFileIndex(
  workdir: string,
  options: { listFiles?: ListFiles; now?: number; force?: boolean } = {},
): Promise<QuickOpenFileIndex> {
  const now = options.now ?? Date.now();
  const cached = indexCache.get(workdir);
  if (cached && !options.force && now - cached.loadedAt < QUICK_OPEN_INDEX_TTL_MS) {
    return cached.promise;
  }
  const promise = (options.listFiles ?? defaultListFiles)(workdir).then((response) => ({
    workdir,
    paths: response.entries
      .filter((entry) => entry.kind === "file" && !entry.hidden)
      .map((entry) => entry.path),
    truncated: response.truncated,
  }));
  indexCache.set(workdir, { loadedAt: now, promise });
  // A failed listing must not stick: the next palette session retries.
  promise.catch(() => {
    if (indexCache.get(workdir)?.promise === promise) indexCache.delete(workdir);
  });
  return promise;
}

export function clearQuickOpenFileIndexCache(): void {
  indexCache.clear();
}

let sharedClient: QuickOpenSearchClient | null = null;

/** One worker for the whole app; created on first use. */
export function getQuickOpenSearchClient(): QuickOpenSearchClient {
  sharedClient ??= createQuickOpenSearchClient();
  return sharedClient;
}
