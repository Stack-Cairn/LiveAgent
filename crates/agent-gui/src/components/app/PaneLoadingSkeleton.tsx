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
      className={cn(
        "workbench-pane-restoring relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-busy="true"
    >
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border/45 px-4"
        aria-hidden
      >
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25" />
        <span className="h-1.5 w-20 rounded-full bg-muted-foreground/15" />
      </div>
      {variant === "terminal" ? (
        <div className="space-y-3 px-4 py-5 font-mono" aria-hidden>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm bg-emerald-500/35" />
            <span className="h-2 w-40 rounded-sm bg-muted-foreground/12" />
          </div>
          <div className="h-2 w-56 rounded-sm bg-muted-foreground/10" />
          <div className="h-2 w-36 rounded-sm bg-muted-foreground/10" />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-5 px-[8%] py-7" aria-hidden>
          <div className="space-y-2">
            <div className="h-2 w-[58%] rounded-full bg-muted-foreground/12" />
            <div className="h-2 w-[42%] rounded-full bg-muted-foreground/9" />
          </div>
          <div className="ml-auto h-10 w-[36%] rounded-2xl rounded-br-md bg-muted-foreground/8" />
          <div className="space-y-2">
            <div className="h-2 w-[72%] rounded-full bg-muted-foreground/12" />
            <div className="h-2 w-[64%] rounded-full bg-muted-foreground/9" />
            <div className="h-2 w-[48%] rounded-full bg-muted-foreground/9" />
          </div>
        </div>
      )}
    </div>
  );
}
