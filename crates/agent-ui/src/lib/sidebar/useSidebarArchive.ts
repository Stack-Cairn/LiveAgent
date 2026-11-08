// Archive support for a sidebar container. Shared between agent-gui and
// agent-gateway/web: both ends get the same row action, header button and
// archived list, and both hide all of it when the backend cannot archive.

import { useCallback, useEffect, useState } from "react";
import type { SidebarStore, SidebarStoreArchive } from "./store";

export type SidebarArchiveState = {
  /** Set only while the backend reports archive support. */
  archive: SidebarStoreArchive | undefined;
  setArchived: (id: string, archived: boolean) => void;
};

/**
 * `probeKey` re-checks support when it changes (for example the list status after a
 * reconnect), since the runtime or backend version can change while the app runs.
 */
export function useSidebarArchive(store: SidebarStore, probeKey?: unknown): SidebarArchiveState {
  const storeArchive = store.archive;
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    void probeKey;
    if (!storeArchive) {
      setSupported(false);
      return;
    }
    let cancelled = false;
    storeArchive.isSupported().then(
      (value) => {
        if (!cancelled) setSupported(value);
      },
      () => {
        if (!cancelled) setSupported(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [storeArchive, probeKey]);

  const archive = supported ? storeArchive : undefined;
  const setArchived = useCallback(
    (id: string, archived: boolean) => {
      if (!archive) return;
      store.clearMutationError(id);
      void archive.setArchived(id, archived);
    },
    [archive, store],
  );
  return { archive, setArchived };
}
