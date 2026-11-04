import type { TranscriptFindEntry } from "./transcriptFind";

/**
 * Bridge from the virtual list (which owns the row model) to the find bar.
 * The list publishes a lazy provider on every row change; entries are only
 * built when an open find bar reads them, so a closed bar costs nothing while
 * a reply streams.
 */
export type TranscriptFindSource = {
  publish: (provider: () => readonly TranscriptFindEntry[]) => void;
  getEntries: () => readonly TranscriptFindEntry[];
  getVersion: () => number;
  subscribe: (listener: () => void) => () => void;
};

const NO_ENTRIES: readonly TranscriptFindEntry[] = [];

export function createTranscriptFindSource(): TranscriptFindSource {
  let provider: () => readonly TranscriptFindEntry[] = () => NO_ENTRIES;
  let version = 0;
  let cache: { version: number; entries: readonly TranscriptFindEntry[] } | null = null;
  const listeners = new Set<() => void>();
  return {
    publish(nextProvider) {
      provider = nextProvider;
      version += 1;
      cache = null;
      for (const listener of listeners) listener();
    },
    getEntries() {
      if (!cache || cache.version !== version) {
        cache = { version, entries: provider() };
      }
      return cache.entries;
    },
    getVersion: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
