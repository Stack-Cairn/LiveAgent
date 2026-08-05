import { cn } from "../../lib/shared/utils";
import { OdometerNumber } from "./OdometerNumber";

// Green +N / red -N line-change badge for the collapsed Write/Edit tool bar.
export function FileChangeBadge({
  added,
  removed,
  className,
}: {
  added?: number;
  removed?: number;
  className?: string;
}) {
  if (added === undefined && removed === undefined) return null;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 font-mono text-[calc(11px*var(--zone-font-scale,1))] tabular-nums",
        className,
      )}
    >
      {added !== undefined ? (
        <span className="flex items-center text-[hsl(var(--chat-success))]">
          +<OdometerNumber value={added} />
        </span>
      ) : null}
      {removed !== undefined ? (
        <span className="flex items-center text-[hsl(var(--chat-error))]">
          -<OdometerNumber value={removed} />
        </span>
      ) : null}
    </span>
  );
}
