import type { ReactNode } from "react";

/**
 * Hands the latest body render function from LazyCollapse to its body without
 * re-rendering the motion wrappers in between. `publish` runs during the
 * owner's render and bumps the version the body reads; `flush` runs in the
 * owner's layout effect and wakes a body that the memoized shell skipped.
 * A body that already rendered the current version sees no change and does
 * not render twice.
 */
export type CollapseBodySource = {
  publish(render: () => ReactNode): void;
  flush(): void;
  render(): ReactNode;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
};

export function createCollapseBodySource(): CollapseBodySource {
  let render: () => ReactNode = () => null;
  let version = 0;
  let flushedVersion = 0;
  const listeners = new Set<() => void>();
  return {
    publish(next) {
      if (next === render) return;
      render = next;
      version += 1;
    },
    flush() {
      if (flushedVersion === version) return;
      flushedVersion = version;
      for (const listener of [...listeners]) listener();
    },
    render: () => render(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}
