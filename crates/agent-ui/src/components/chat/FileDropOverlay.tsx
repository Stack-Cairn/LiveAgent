import { Ban, Upload } from "../IconSet";

type FileDropOverlayProps = {
  canDropUpload: boolean;
  title: string;
  description: string;
  limitHint: string;
  variant?: "surface" | "composer";
};

export function FileDropOverlay(props: FileDropOverlayProps) {
  const { canDropUpload, title, description, limitHint, variant = "surface" } = props;

  if (variant === "composer") {
    return (
      <div
        className="file-drop-overlay pointer-events-none absolute inset-0 z-50 flex items-center justify-center overflow-hidden rounded-[24px] bg-background/82 p-2 backdrop-blur-xl"
        aria-hidden="true"
      >
        <div
          className={`file-drop-overlay-zone absolute inset-0 rounded-[24px] border border-dashed ${
            canDropUpload
              ? "border-sky-500/45 bg-sky-500/[0.055]"
              : "border-destructive/45 bg-destructive/[0.055]"
          }`}
        />
        <div
          className={`file-drop-overlay-card relative flex max-w-[calc(100%-1rem)] items-center gap-3 rounded-2xl border bg-background/92 px-4 py-3 text-left shadow-lg backdrop-blur-2xl sm:max-w-[620px] ${
            canDropUpload
              ? "border-sky-500/20 text-foreground"
              : "border-destructive/25 text-destructive"
          }`}
        >
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${
              canDropUpload
                ? "bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-300"
                : "bg-destructive/10 text-destructive ring-destructive/20"
            }`}
          >
            {canDropUpload ? (
              <Upload className="h-4.5 w-4.5" strokeWidth={1.8} />
            ) : (
              <Ban className="h-4.5 w-4.5" strokeWidth={1.8} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold leading-5">{title}</div>
            <div className="truncate text-[11px] leading-4 text-muted-foreground">
              {description}
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-foreground/10 bg-foreground/[0.035] px-2.5 py-1 text-[10px] font-medium text-muted-foreground sm:inline-flex">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
            {limitHint}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="file-drop-overlay pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4 sm:p-6 bg-white/30 backdrop-blur-md dark:bg-black/30"
      aria-hidden="true"
    >
      <div
        className={`file-drop-overlay-zone absolute inset-3 sm:inset-4 rounded-2xl border border-dashed ${
          canDropUpload
            ? "border-foreground/20 bg-foreground/[0.015] dark:border-white/15 dark:bg-white/[0.015]"
            : "border-destructive/35 bg-destructive/[0.03]"
        }`}
      />
      <div
        className={`file-drop-overlay-card relative flex w-full max-w-[380px] flex-col items-center gap-5 rounded-2xl border bg-white/70 px-8 py-7 text-center shadow-[0_24px_60px_-20px_rgba(0,0,0,0.25),0_8px_20px_-12px_rgba(0,0,0,0.15)] backdrop-blur-2xl dark:bg-zinc-900/70 dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7),0_8px_20px_-12px_rgba(0,0,0,0.5)] ${
          canDropUpload
            ? "border-black/[0.06] ring-1 ring-inset ring-white/40 dark:border-white/10 dark:ring-white/[0.04]"
            : "border-destructive/20 ring-1 ring-inset ring-destructive/10 dark:border-destructive/30"
        }`}
      >
        <div
          className={`flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ring-inset ${
            canDropUpload
              ? "bg-foreground/[0.04] text-foreground/85 ring-foreground/10 dark:bg-white/[0.06] dark:text-white/90 dark:ring-white/10"
              : "bg-destructive/[0.08] text-destructive/90 ring-destructive/15"
          }`}
        >
          {canDropUpload ? (
            <Upload className="h-6 w-6" strokeWidth={1.75} />
          ) : (
            <Ban className="h-6 w-6" strokeWidth={1.75} />
          )}
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <div className="text-[calc(15px*var(--zone-font-scale,1))] font-semibold leading-tight tracking-tight text-foreground">
            {title}
          </div>
          <div className="max-w-[280px] text-xs leading-5 text-muted-foreground">{description}</div>
        </div>

        <div className="h-px w-12 bg-foreground/10 dark:bg-white/10" aria-hidden="true" />

        <div
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium ${
            canDropUpload
              ? "border-foreground/[0.08] bg-foreground/[0.03] text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]"
              : "border-destructive/20 bg-destructive/[0.05] text-destructive/80"
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-flex h-1.5 w-1.5 rounded-full ${
              canDropUpload ? "bg-foreground/35 dark:bg-white/50" : "bg-destructive/55"
            }`}
          />
          {limitHint}
        </div>
      </div>
    </div>
  );
}
