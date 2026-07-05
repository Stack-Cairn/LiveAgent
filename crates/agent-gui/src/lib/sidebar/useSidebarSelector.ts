// Selector-scoped subscription to the sidebar store. This is the only way
// React code reads the store: a commit re-renders exactly the components
// whose selection changed (per isEqual), so activity ticks and list updates
// never cascade through page-level components. Byte-mirrored between
// agent-gui and agent-gateway/web.
//
// The selector must be pure with respect to the snapshot: for one snapshot it
// must always produce an equivalent selection (its identity may change per
// render; the cached selection is reused as long as isEqual holds).

import { useRef, useSyncExternalStore } from "react";
import type { SidebarSnapshot, SidebarStore } from "./store";

type SelectionCache<T> = {
  snapshot: SidebarSnapshot;
  selection: T;
};

export function useSidebarSelector<T>(
  store: SidebarStore,
  selector: (snapshot: SidebarSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const cacheRef = useRef<SelectionCache<T> | null>(null);

  const getSelection = () => {
    const snapshot = store.getSnapshot();
    const cache = cacheRef.current;
    if (cache && cache.snapshot === snapshot) {
      return cache.selection;
    }
    const next = selector(snapshot);
    const selection = cache && isEqual(cache.selection, next) ? cache.selection : next;
    cacheRef.current = { snapshot, selection };
    return selection;
  };

  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}
