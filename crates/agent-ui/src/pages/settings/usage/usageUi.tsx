import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../../lib/shared/utils";
import { compactParts, USAGE_SERIES_SLOTS, type UsageLocale } from "../../../lib/usage/usageStats";

/**
 * Chart colors. Model slots follow the model's all-time rank, so a model keeps its
 * color in the donut and the trend; lower ranks use free slots in the visible trend.
 * The eight hues and their order are a validated
 * colorblind-safe set; dark mode uses its own steps of the same hues. The heat ramp
 * is one hue that moves away from the surface as usage grows: darker on the light
 * surface, brighter on the dark one. Keeping "more" as "more contrast" leaves the
 * busiest days the easiest to see, never close to the empty cells.
 */
export const USAGE_PALETTE_CLASS = cn(
  "[--usage-series-1:#2a78d6] [--usage-series-2:#eb6834] [--usage-series-3:#1baf7a]",
  "[--usage-series-4:#eda100] [--usage-series-5:#e87ba4] [--usage-series-6:#008300]",
  "[--usage-series-7:#6250d6] [--usage-series-8:#e34948] [--usage-series-other:#a8a7a1]",
  "[--usage-heat-1:#b7d3f6] [--usage-heat-2:#6da7ec] [--usage-heat-3:#2a78d6] [--usage-heat-4:#184f95]",
  "dark:[--usage-series-1:#3987e5] dark:[--usage-series-2:#d95926] dark:[--usage-series-3:#199e70]",
  "dark:[--usage-series-4:#c98500] dark:[--usage-series-5:#d55181] dark:[--usage-series-6:#008300]",
  "dark:[--usage-series-7:#9085e9] dark:[--usage-series-8:#e66767] dark:[--usage-series-other:#64635e]",
  "dark:[--usage-heat-1:#184f95] dark:[--usage-heat-2:#256abf] dark:[--usage-heat-3:#3987e5] dark:[--usage-heat-4:#86b6ef]",
);

/** CSS color for a model's rank; null (merged "other") and ranks past the palette are gray. */
export function seriesColor(colorIndex: number | null): string {
  return colorIndex === null || colorIndex < 0 || colorIndex >= USAGE_SERIES_SLOTS
    ? "var(--usage-series-other)"
    : `var(--usage-series-${colorIndex + 1})`;
}

export function heatColor(level: number): string | undefined {
  return level > 0 ? `var(--usage-heat-${level})` : undefined;
}

/** Replaces `{name}` placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** A template with React nodes for its `{name}` placeholders (numbers stay mono). */
export function Template({
  template,
  values,
}: {
  template: string;
  values: Record<string, ReactNode>;
}) {
  const parts = template.split(/(\{\w+\})/);
  return (
    <>
      {parts.map((part, index) => {
        const key = /^\{(\w+)\}$/.exec(part)?.[1];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static template parts
          <Fragment key={index}>{key && key in values ? values[key] : part}</Fragment>
        );
      })}
    </>
  );
}

/** Mono digits; integer with grouping. */
export function Digits({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

/** Mono digits with a sans unit: 12.3万, 4.5M. */
export function CompactAmount({
  value,
  locale,
  suffix,
  className,
  suffixClassName,
}: {
  value: number;
  locale: UsageLocale;
  suffix?: string;
  className?: string;
  suffixClassName?: string;
}) {
  const parts = compactParts(value, locale);
  return (
    <span className={cn("whitespace-nowrap", className)}>
      <span className="font-mono tabular-nums">{parts.value}</span>
      {parts.unit ? <span className="font-sans">{parts.unit}</span> : null}
      {suffix ? (
        <span className={cn("ml-1 font-sans text-muted-foreground", suffixClassName)}>
          {suffix}
        </span>
      ) : null}
    </span>
  );
}

export function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 shrink-0 rounded-xs", className)}
      style={{ backgroundColor: color }}
    />
  );
}

/** Small rounded pill tabs for a chart's view switch. */
export function PillTabs<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex h-7 shrink-0 items-center rounded-full bg-segmented-track p-0.5 ring-1 ring-foreground/5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a styled radio button group
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6 whitespace-nowrap rounded-full px-2.5 text-xs transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-segmented-selected font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export type TooltipAnchor = { left: number; top: number; bottom: number };

const TOOLTIP_GAP = 8;

/**
 * A tooltip at `anchor` (coordinates relative to the positioned parent).
 * - "above": centered over the anchor, flipped below only when it would leave the
 *   window; kept inside the parent horizontally.
 * - "side": beside a crosshair at `anchor.left` (right of it, or left when there is
 *   no room), its top at `anchor.top` and kept inside the parent vertically.
 */
export function ChartTooltip({
  anchor,
  placement = "above",
  children,
}: {
  anchor: TooltipAnchor | null;
  placement?: "above" | "side";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const left = anchor?.left;
  const top = anchor?.top;
  const bottom = anchor?.bottom;
  // Placement depends on the anchor's numbers, not the object (a new one each render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the content changes too
  useLayoutEffect(() => {
    const node = ref.current;
    const parent = node?.offsetParent as HTMLElement | null;
    if (left === undefined || top === undefined || bottom === undefined || !node || !parent) {
      setPosition(null);
      return;
    }
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const roomX = Math.max(parent.clientWidth - width, 0);
    let next: { left: number; top: number };
    if (placement === "side") {
      const right = left + TOOLTIP_GAP;
      next = {
        left: right + width <= parent.clientWidth ? right : Math.max(left - TOOLTIP_GAP - width, 0),
        top: Math.min(Math.max(top, 0), Math.max(parent.clientHeight - height, 0)),
      };
    } else {
      const above = top - height - TOOLTIP_GAP;
      const fitsAbove = parent.getBoundingClientRect().top + above >= 0;
      next = {
        left: Math.min(Math.max(left - width / 2, 0), roomX),
        top: fitsAbove ? above : bottom + TOOLTIP_GAP,
      };
    }
    setPosition((current) =>
      current && current.left === next.left && current.top === next.top ? current : next,
    );
  }, [left, top, bottom, placement, children]);
  if (!anchor) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-20 w-max max-w-64 rounded-xl border border-border/60 bg-popover px-3 py-2",
        "text-xs leading-5 text-popover-foreground shadow-lg",
        position ? "visible" : "invisible",
      )}
      style={position ?? { left: 0, top: 0 }}
    >
      {children}
    </div>
  );
}

/** An element's box relative to `parent`, as a tooltip anchor. */
export function anchorFor(element: Element, parent: Element | null): TooltipAnchor | null {
  if (!parent) return null;
  const box = element.getBoundingClientRect();
  const base = parent.getBoundingClientRect();
  return {
    left: box.left - base.left + box.width / 2,
    top: box.top - base.top,
    bottom: box.bottom - base.top,
  };
}

export function ChartCard({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <section
      {...props}
      className={cn("min-w-0 rounded-xl bg-settings-tile px-4 py-3.5", className)}
    >
      <div className="mb-3 flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
