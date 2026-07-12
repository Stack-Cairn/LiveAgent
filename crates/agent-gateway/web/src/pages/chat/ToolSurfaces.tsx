import type { ReactNode } from "react";

import { cn } from "../../lib/shared/utils";

// Presentational primitives shared by the tool cards (args displays, result
// displays, streaming previews).

export type MetaTag = { label: string; value: string };

export function ToolSection(props: { label: string; trailing?: ReactNode; children: ReactNode }) {
  const { label, trailing, children } = props;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[calc(10px*var(--zone-font-scale,1))] font-semibold uppercase tracking-[0.18em] text-muted-foreground/52">
          {label}
        </span>
        <div className="h-px flex-1 bg-black/[0.05] dark:bg-white/[0.08]" />
        {trailing}
      </div>
      {children}
    </section>
  );
}

export function ToolSurface(props: { children: ReactNode; className?: string }) {
  const { children, className } = props;
  return (
    <div
      className={cn(
        "rounded-[10px] border border-black/[0.05] bg-white/[0.56] px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.58)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ToolSurfaceLabel({ label }: { label: string }) {
  return (
    <div className="mb-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-semibold uppercase tracking-[0.16em] text-muted-foreground/45">
      {label}
    </div>
  );
}

export function ToolFactGrid({ tags }: { tags: MetaTag[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {tags.map((tag) => (
        <ToolSurface key={`${tag.label}-${tag.value}`} className="px-2.5 py-2">
          <ToolSurfaceLabel label={tag.label} />
          <div className="break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.55] text-foreground/78">
            {tag.value}
          </div>
        </ToolSurface>
      ))}
    </div>
  );
}

/** Render path with dir dimmed and filename highlighted */
export function PathDisplay({ path, className }: { path: string; className?: string }) {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash < 0) {
    return (
      <span
        className={cn(
          className,
          "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap break-normal",
        )}
        title={path}
      >
        {path}
      </span>
    );
  }
  const dir = path.slice(0, lastSlash + 1);
  const file = path.slice(lastSlash + 1);
  return (
    <span
      className={cn(
        className,
        "inline-flex max-w-full min-w-0 items-baseline overflow-hidden whitespace-nowrap break-normal",
      )}
      title={path}
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
        {dir.length > 50 ? `…${dir.slice(-50)}` : dir}
      </span>
      <span className="max-w-[70%] truncate text-foreground/85">{file}</span>
    </span>
  );
}

/** Inline meta tags */
export function MetaTags({ tags }: { tags: MetaTag[] }) {
  if (tags.length === 0) return null;
  const labelCounts = new Map<string, number>();
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const seenCount = labelCounts.get(tag.label) ?? 0;
        labelCounts.set(tag.label, seenCount + 1);
        const stableKey = seenCount === 0 ? tag.label : `${tag.label}-${seenCount}`;
        return (
          <span
            key={stableKey}
            className="tool-arg-pill inline-flex min-h-6 items-center gap-1.5 rounded-full border border-black/[0.05] bg-white/[0.78] px-2 py-1 text-[calc(10.5px*var(--zone-font-scale,1))] leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none"
          >
            <span className="font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
              {tag.label}
            </span>
            <span className="h-3 w-px bg-black/[0.06] dark:bg-white/[0.08]" />
            <span className="font-mono tabular-nums text-foreground/75">{tag.value}</span>
          </span>
        );
      })}
    </div>
  );
}

export function ToolScrollablePre(props: { children: ReactNode; className?: string }) {
  const { children, className } = props;
  return (
    <pre
      className={cn(
        "tool-text-scroll overflow-x-auto overflow-y-auto whitespace-pre break-normal rounded-[8px] px-2.5 py-2 text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]",
        className,
      )}
    >
      {children}
    </pre>
  );
}
