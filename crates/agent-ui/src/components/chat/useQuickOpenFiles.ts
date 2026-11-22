import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandPaletteFileSource } from "../../lib/chat/commandPalette";
import type { QuickOpenMatch } from "../../lib/chat/fileQuickOpen";
import {
  getQuickOpenSearchClient,
  loadQuickOpenFileIndex,
  type QuickOpenFileIndex,
  type QuickOpenSearchClient,
} from "../../lib/chat/fileQuickOpenSearch";

export type QuickOpenFilesStatus = "idle" | "unavailable" | "loading" | "ready" | "error";

export type QuickOpenFilesState = {
  status: QuickOpenFilesStatus;
  matches: readonly QuickOpenMatch[];
  /** The workspace has more files than the index holds. */
  truncated: boolean;
  retry: () => void;
};

const NO_MATCHES: readonly QuickOpenMatch[] = [];

/**
 * Palette `@` scope: loads the workspace file list when the scope becomes
 * active and re-runs the off-thread fuzzy search on every query change.
 */
export function useQuickOpenFiles({
  active,
  source,
  query,
  client = getQuickOpenSearchClient,
}: {
  active: boolean;
  source: CommandPaletteFileSource | null;
  query: string;
  client?: () => QuickOpenSearchClient;
}): QuickOpenFilesState {
  const workdir = source?.workdir.trim() ?? "";
  const [index, setIndex] = useState<QuickOpenFileIndex | null>(null);
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [matches, setMatches] = useState<readonly QuickOpenMatch[]>(NO_MATCHES);
  const [reloadKey, setReloadKey] = useState(0);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    loadSeqRef.current += 1;
    const seq = loadSeqRef.current;
    if (!active || !workdir) {
      setLoadStatus("idle");
      return;
    }
    setLoadStatus("loading");
    loadQuickOpenFileIndex(workdir, { force: reloadKey > 0 })
      .then((next) => {
        if (seq !== loadSeqRef.current) return;
        client().setIndex(next.workdir, next.paths);
        setIndex(next);
        setLoadStatus("ready");
      })
      .catch(() => {
        if (seq !== loadSeqRef.current) return;
        setIndex(null);
        setLoadStatus("error");
      });
  }, [active, client, reloadKey, workdir]);

  useEffect(() => {
    if (!active || loadStatus !== "ready" || !index || index.workdir !== workdir) {
      setMatches(NO_MATCHES);
      return;
    }
    let cancelled = false;
    void client()
      .search(index.workdir, query)
      .then((next) => {
        // null: a newer keystroke superseded this search.
        if (!cancelled && next) setMatches(next);
      });
    return () => {
      cancelled = true;
    };
  }, [active, client, index, loadStatus, query, workdir]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  if (!active) return { status: "idle", matches: NO_MATCHES, truncated: false, retry };
  if (!workdir) return { status: "unavailable", matches: NO_MATCHES, truncated: false, retry };
  return {
    status: loadStatus === "idle" ? "loading" : loadStatus,
    matches,
    truncated: Boolean(index?.truncated),
    retry,
  };
}
