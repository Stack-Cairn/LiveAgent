import { type ComponentType, lazy, type ReactNode, Suspense } from "react";

/**
 * Wraps a component that lives in its own chunk: the chunk loads the first time
 * the component renders, and `fallback` (nothing by default) shows until then.
 * Keep `load` a plain `import()` so the bundler can split it out.
 */
export function onDemand<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
) {
  const Loaded = lazy(async () => ({ default: await load() }));
  return function OnDemandComponent(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Loaded {...props} />
      </Suspense>
    );
  };
}
