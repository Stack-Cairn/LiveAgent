import { type QuickOpenMatch, searchQuickOpenPaths } from "./fileQuickOpen";

/** Messages between the quick-open search client and its worker. */
export type QuickOpenWorkerRequest =
  | { type: "index"; key: string; paths: readonly string[] }
  | { type: "search"; seq: number; key: string; query: string; limit: number };

export type QuickOpenWorkerResponse = {
  type: "results";
  seq: number;
  key: string;
  matches: QuickOpenMatch[];
};

/** Shared by the worker and the synchronous fallback so both behave the same. */
export function runQuickOpenWorkerRequest(
  indexes: Map<string, readonly string[]>,
  request: QuickOpenWorkerRequest,
): QuickOpenWorkerResponse | null {
  if (request.type === "index") {
    indexes.set(request.key, request.paths);
    return null;
  }
  const paths = indexes.get(request.key) ?? [];
  return {
    type: "results",
    seq: request.seq,
    key: request.key,
    matches: searchQuickOpenPaths(paths, request.query, request.limit),
  };
}
