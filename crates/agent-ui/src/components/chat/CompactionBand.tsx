import { FoldVertical } from "@liveagent/ui/components/IconSet";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The compaction family's shared chrome: a tinted band with a violet accent,
 * deliberately off the grey scale used by reasoning/tool rows so a context
 * fold stands out while scanning history. Both the live "compressing"
 * status and the settled in-reply seam wear it, so they read as the same
 * event at two moments. Dependency-light on purpose (no Markdown) so the
 * status layer can import it without pulling the renderer stack.
 */
export function CompactionBand(props: {
  active?: boolean;
  icon?: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  as?: "div" | "button";
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const { active = false, icon, label, meta, trailing, className, as = "div", buttonProps } = props;
  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "compaction-band-icon flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-500/[0.12] text-violet-600 dark:bg-violet-400/[0.14] dark:text-violet-300",
          active && "compaction-band-icon-active",
        )}
      >
        {icon ?? <FoldVertical className="h-3 w-3" />}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-[calc(12.5px*var(--zone-font-scale,1))] font-medium text-violet-800 dark:text-violet-200",
          active && "shimmer",
        )}
      >
        {label}
      </span>
      {meta ? (
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">{meta}</span>
      ) : null}
      {trailing}
      {active ? <span aria-hidden="true" className="compaction-band-progress" /> : null}
    </>
  );
  const baseClass = cn(
    "compaction-band relative flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-violet-500/[0.18] bg-violet-500/[0.06] py-1.5 pl-2.5 pr-2.5 text-left transition-colors duration-150 dark:border-violet-400/[0.16] dark:bg-violet-400/[0.07]",
    active && "compaction-band-active",
    className,
  );
  if (as === "button") {
    return (
      <button
        type="button"
        data-compaction-band=""
        data-active={active ? "" : undefined}
        {...buttonProps}
        className={cn(baseClass, buttonProps?.className)}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={baseClass} data-compaction-band="" data-active={active ? "" : undefined}>
      {content}
    </div>
  );
}

export function CompactionMetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-violet-500/[0.08] px-1.5 py-[1px] text-[calc(10.5px*var(--zone-font-scale,1))] font-medium tabular-nums text-violet-700/80 dark:bg-violet-400/[0.1] dark:text-violet-300/80">
      {children}
    </span>
  );
}
