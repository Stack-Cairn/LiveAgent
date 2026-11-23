import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";
import { Button } from "./ui/button";

/**
 * For a Retry the user asked for that failed again. Chromium keeps a failed
 * module import in its module map, so importing the same chunk again fails
 * without a request; reloading the page loads it afresh (and picks up a new
 * deploy, the usual reason a chunk is missing).
 */
function reloadAfterFailedRetry() {
  window.location.reload();
}

/** A lazy chunk that failed to download or evaluate (offline, deploy swapped the files). */
class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChunkLoadError";
  }
}

/**
 * A `lazy()` component whose failed load can be tried again: React caches a
 * rejected lazy promise, so `retry()` swaps in a fresh lazy wrapper that calls
 * `load` again. A first failure is raised as a `ChunkLoadError`; if a retry
 * fails too, the page reloads (see reloadAfterFailedRetry).
 */
export function retryableLazy<P extends object>(load: () => Promise<ComponentType<P>>) {
  let attempts = 0;
  const create = () => {
    const isRetry = attempts++ > 0;
    return lazy(async () => {
      try {
        return { default: await load() };
      } catch (error) {
        if (!isRetry) throw new ChunkLoadError(error);
        reloadAfterFailedRetry();
        // Keep the loading fallback up until the page reloads.
        return new Promise<never>(() => {});
      }
    });
  };
  let current: LazyExoticComponent<ComponentType<P>> = create();
  return {
    get Component() {
      return current;
    },
    retry() {
      current = create();
    },
  };
}

type ChunkLoadBoundaryProps = {
  children: ReactNode;
  onRetry: () => void;
  className?: string;
};

/**
 * Shows a retry row when a lazy chunk fails to load, instead of a blank area.
 * Any other render error is passed on to the next error boundary.
 */
export class ChunkLoadBoundary extends Component<ChunkLoadBoundaryProps, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!(error instanceof ChunkLoadError)) throw error;
    return (
      <ChunkLoadRetry
        className={this.props.className}
        onRetry={() => {
          this.props.onRetry();
          this.setState({ error: null });
        }}
      />
    );
  }
}

/** The "could not be loaded · Retry" row shown in place of a part whose chunk failed. */
export function ChunkLoadRetry({
  className,
  onRetry,
}: {
  className?: string;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  return (
    <div
      role="alert"
      data-chunk-load-error=""
      className={cn(
        "flex flex-wrap items-center justify-center gap-3 p-4 text-sm text-muted-foreground",
        className,
      )}
    >
      <span>{t("app.chunkLoadFailed")}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("app.chunkLoadRetry")}
      </Button>
    </div>
  );
}

/**
 * Wraps a component that lives in its own chunk: the chunk loads the first time
 * the component renders, and `fallback` (nothing by default) shows until then.
 * A failed load shows a retry row. Keep `load` a plain `import()` so the bundler
 * can split it out.
 */
export function onDemand<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
) {
  const loaded = retryableLazy(load);
  return function OnDemandComponent(props: P) {
    const [, setAttempt] = useState(0);
    const Loaded = loaded.Component;
    return (
      <ChunkLoadBoundary
        onRetry={() => {
          loaded.retry();
          setAttempt((attempt) => attempt + 1);
        }}
      >
        <Suspense fallback={fallback}>
          <Loaded {...props} />
        </Suspense>
      </ChunkLoadBoundary>
    );
  };
}
