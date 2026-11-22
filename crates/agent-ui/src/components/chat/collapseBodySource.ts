import type { ReactNode } from "react";

/**
 * Hands the latest body render function from LazyCollapse to its body without
 * re-rendering the motion wrappers in between. `publish` runs during the
 * owner's render and bumps the version; the owner provides that version
 * through context, which wakes a body the memoized shell skipped.
 */
export type CollapseBodySource = {
  publish(render: () => ReactNode): void;
  render(): ReactNode;
  getVersion(): number;
};

export function createCollapseBodySource(): CollapseBodySource {
  let render: () => ReactNode = () => null;
  let version = 0;
  return {
    publish(next) {
      if (next === render) return;
      render = next;
      version += 1;
    },
    render: () => render(),
    getVersion: () => version,
  };
}
