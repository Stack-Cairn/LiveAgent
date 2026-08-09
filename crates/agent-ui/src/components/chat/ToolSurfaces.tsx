import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ReactNode } from "react";

// Presentational primitives shared by the tool cards (args displays, result
// displays, streaming previews).

export type MetaTag = { label: string; value: string };

export function ToolSection(props: { label?: string; trailing?: ReactNode; children: ReactNode }) {
  const { label, trailing, children } = props;
  return (
    <section className="space-y-1.5">
      {label || trailing ? (
        <div className="flex min-h-5 items-center gap-2">
          {label ? (
            <span className="shrink-0 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground/65">
              {label}
            </span>
          ) : null}
          {trailing}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ToolSurface(props: { children: ReactNode; className?: string }) {
  const { children, className } = props;
  return <div className={cn("min-w-0 py-0.5", className)}>{children}</div>;
}

export function ToolSurfaceLabel({ label }: { label: string }) {
  return (
    <div className="mb-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground/55">
      {label}
    </div>
  );
}

export function ToolFactGrid({ tags }: { tags: MetaTag[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {tags.map((tag) => (
        <ToolSurface key={`${tag.label}-${tag.value}`}>
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
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {tags.map((tag) => {
        const seenCount = labelCounts.get(tag.label) ?? 0;
        labelCounts.set(tag.label, seenCount + 1);
        const stableKey = seenCount === 0 ? tag.label : `${tag.label}-${seenCount}`;
        return (
          <span
            key={stableKey}
            className="inline-flex min-h-5 items-baseline gap-1 text-[calc(11px*var(--zone-font-scale,1))] leading-5"
          >
            <span className="font-medium text-muted-foreground/55">{tag.label}</span>
            <span className="min-w-0 break-all font-mono tabular-nums text-foreground/75">
              {tag.value}
            </span>
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
