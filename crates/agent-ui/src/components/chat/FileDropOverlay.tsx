import { cn } from "@liveagent/ui/lib/shared/utils";
import { Ban, Upload } from "../IconSet";

type FileDropOverlayProps = {
  canDropUpload: boolean;
  title: string;
  description: string;
  limitHint: string;
  variant?: "panel" | "composer";
};

export function FileDropOverlay(props: FileDropOverlayProps) {
  const { canDropUpload, title, description, limitHint, variant = "panel" } = props;
  if (variant === "composer") {
    return (
      <div
        className={cn(
          "animate-file-drop-overlay motion-reduce:animate-none!",
          "pointer-events-none absolute inset-0 z-30 flex items-center justify-center",
          "rounded-3xl border border-dashed px-5 py-3 backdrop-blur-xl",
          canDropUpload
            ? "border-foreground/25 bg-background/92 dark:border-white/20 dark:bg-zinc-950/90"
            : "border-destructive/40 bg-background/94 dark:bg-zinc-950/92",
        )}
        aria-hidden="true"
      >
        <div className="animate-file-drop-overlay-card motion-reduce:animate-none! flex min-w-0 items-center gap-3 text-left">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
              canDropUpload
                ? "bg-foreground/[0.05] text-foreground/85 ring-foreground/10 dark:bg-white/[0.07] dark:text-white/90 dark:ring-white/10"
                : "bg-destructive/[0.08] text-destructive/90 ring-destructive/15",
            )}
          >
            {canDropUpload ? (
              <Upload className="size-5" strokeWidth={1.75} />
            ) : (
              <Ban className="size-5" strokeWidth={1.75} />
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-5 text-foreground">{title}</div>
            <div className="hidden max-w-420px truncate text-xs leading-5 text-muted-foreground sm:block">
              {description}
            </div>
          </div>
          <div
            className={cn(
              "hidden shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1",
              "text-xs font-medium md:inline-flex",
              canDropUpload
                ? "border-foreground/[0.08] bg-foreground/[0.03] text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]"
                : "border-destructive/20 bg-destructive/[0.05] text-destructive/80",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex size-1.5 rounded-full",
                canDropUpload ? "bg-foreground/35 dark:bg-white/50" : "bg-destructive/55",
              )}
            />
            {limitHint}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "animate-file-drop-overlay motion-reduce:animate-none!",
        "pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4",
        "sm:p-6 bg-white/30 backdrop-blur-md dark:bg-black/30",
      )}
      aria-hidden="true"
    >
      <div
        className={cn(
          "absolute inset-3 rounded-2xl border border-dashed sm:inset-4",
          canDropUpload
            ? "border-foreground/20 bg-foreground/[0.015] dark:border-white/15 dark:bg-white/[0.015]"
            : "border-destructive/35 bg-destructive/[0.03]",
        )}
      />
      <div
        className={cn(
          "animate-file-drop-overlay-card motion-reduce:animate-none!",
          "relative flex w-full max-w-380px flex-col items-center gap-5",
          "rounded-2xl border bg-white/70 px-8 py-7",
          "text-center shadow-ui-filedropoverlay-6 backdrop-blur-2xl dark:bg-zinc-900/70 dark:shadow-ui-filedropoverlay-7",
          canDropUpload
            ? "border-black/[0.06] ring-1 ring-inset ring-white/40 dark:border-white/10 dark:ring-white/[0.04]"
            : "border-destructive/20 ring-1 ring-inset ring-destructive/10 dark:border-destructive/30",
        )}
      >
        <div
          className={cn(
            "flex size-14 items-center justify-center rounded-2xl ring-1 ring-inset",
            canDropUpload
              ? "bg-foreground/[0.04] text-foreground/85 ring-foreground/10 dark:bg-white/[0.06] dark:text-white/90 dark:ring-white/10"
              : "bg-destructive/[0.08] text-destructive/90 ring-destructive/15",
          )}
        >
          {canDropUpload ? (
            <Upload className="size-6" strokeWidth={1.75} />
          ) : (
            <Ban className="size-6" strokeWidth={1.75} />
          )}
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <div className="text-base font-semibold leading-tight tracking-tight text-foreground">
            {title}
          </div>
          <div className="max-w-280px text-xs leading-5 text-muted-foreground">{description}</div>
        </div>

        <div className="h-px w-12 bg-foreground/10 dark:bg-white/10" aria-hidden="true" />

        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
            "text-xs font-medium",
            canDropUpload
              ? "border-foreground/[0.08] bg-foreground/[0.03] text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]"
              : "border-destructive/20 bg-destructive/[0.05] text-destructive/80",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex size-1.5 rounded-full",
              canDropUpload ? "bg-foreground/35 dark:bg-white/50" : "bg-destructive/55",
            )}
          />
          {limitHint}
        </div>
      </div>
    </div>
  );
}
