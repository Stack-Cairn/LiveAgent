// Live plugin list: one read, then long-poll GET /v1/plugins?since=<revision>&wait=30 so
// edits on disk, other clients' changes and backend restarts show up without a refresh.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginList, PluginsClient, PluginsHttpError } from "./types";

const RETRY_DELAY_MS = 3000;
/** A long-poll answered faster than this without a change is not waiting: slow down. */
const MIN_POLL_MS = 500;

export type PluginListState = {
  list: PluginList | null;
  error: string | null;
  loading: boolean;
  /** Replaces the list with a mutation's answer (they all return the full list). */
  adopt: (list: PluginList) => void;
  /** Re-reads right away, e.g. after a panel URL stopped working. */
  refresh: () => Promise<void>;
};

/**
 * Whether `next` should replace `current`: any revision change counts, including a lower
 * one (the backend restarted and counts from zero again).
 */
export function shouldAdoptPluginList(current: PluginList | null, next: PluginList) {
  return !current || current.revision !== next.revision || current.workdir !== next.workdir;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function usePluginList(client: PluginsClient | null | undefined, workdir?: string) {
  const [list, setList] = useState<PluginList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(client));
  const listRef = useRef<PluginList | null>(null);

  const adopt = useCallback((next: PluginList) => {
    listRef.current = next;
    setList(next);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      adopt(await client.list({ workdir }));
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [adopt, client, workdir]);

  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    listRef.current = null;
    setList(null);
    setLoading(true);
    void (async () => {
      while (!signal.aborted) {
        const current = listRef.current;
        const started = Date.now();
        try {
          const next = await client.list(
            current ? { workdir, since: current.revision, wait: 30, signal } : { workdir, signal },
          );
          if (signal.aborted) return;
          const changed = shouldAdoptPluginList(listRef.current, next);
          if (changed) adopt(next);
          setError(null);
          if (current && !changed && Date.now() - started < MIN_POLL_MS) {
            await sleep(RETRY_DELAY_MS, signal);
          }
        } catch (failure) {
          if (signal.aborted) return;
          setError(errorText(failure));
          // 501: this backend has no plugin support; nothing will change by asking again.
          if ((failure as PluginsHttpError | undefined)?.status === 501) return;
          await sleep(RETRY_DELAY_MS, signal);
        } finally {
          if (!signal.aborted) setLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [adopt, client, workdir]);

  return { list, error, loading, adopt, refresh } satisfies PluginListState;
}
