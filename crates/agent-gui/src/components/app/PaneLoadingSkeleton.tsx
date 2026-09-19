import { Skeleton } from "@liveagent/ui/components/ui/skeleton";
import { cn } from "@liveagent/ui/lib/shared/utils";

export type PaneLoadingSkeletonProps = {
  label: string;
  variant?: "conversation" | "terminal";
  className?: string;
};

export function PaneLoadingSkeleton(props: PaneLoadingSkeletonProps) {
  const { label, variant = "conversation", className } = props;
  return (
    <div
      data-pane-loading-skeleton={variant}
      data-pane-loading-motion="static"
      className={cn(
        "relative flex size-full min-h-0 flex-col overflow-hidden bg-background",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-busy="true"
    >
      {variant === "terminal" ? (
        <div
          className="flex h-10 shrink-0 items-center gap-2 border-b border-border/45 px-4"
          aria-hidden
        >
          <Skeleton className="animate-none size-1.5 rounded-full bg-muted-foreground/25" />
          <Skeleton className="animate-none h-1.5 w-20 rounded-full bg-muted-foreground/15" />
        </div>
      ) : null}
      {variant === "terminal" ? (
        <div className="space-y-3 px-4 py-5 font-mono" aria-hidden>
          <div className="flex items-center gap-2">
            <Skeleton className="animate-none size-2 rounded-sm bg-emerald-500/35" />
            <Skeleton className="animate-none h-2 w-40 rounded-sm bg-muted-foreground/12" />
          </div>
          <Skeleton className="animate-none h-2 w-56 rounded-sm bg-muted-foreground/10" />
          <Skeleton className="animate-none h-2 w-36 rounded-sm bg-muted-foreground/10" />
        </div>
      ) : (
        <div className="mx-1.5 min-h-0 flex-1 overflow-hidden" aria-hidden>
          <div className="mx-auto flex w-full max-w-transcript-web flex-col gap-8 px-5 py-4">
            <div className="space-y-2.5">
              <Skeleton className="h-2 w-3/4 animate-none rounded-full" />
              <Skeleton className="h-2 w-1/2 animate-none rounded-full" />
            </div>
            <Skeleton className="ml-auto h-12 w-[55%] animate-none rounded-2xl" />
            <div className="space-y-2.5">
              <Skeleton className="h-2 w-full animate-none rounded-full" />
              <Skeleton className="h-2 w-5/6 animate-none rounded-full" />
              <Skeleton className="h-2 w-2/3 animate-none rounded-full" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
