import { cn } from "../../../../lib/shared/utils";
import { diffTrajectoryText } from "../../../../lib/trajectory/textDiff";
import { TRAJECTORY_SECTION_SLOTS } from "../../../../lib/trajectory/types";
import { sectionContentAt } from "../sectionData";
import { Empty, SectionFailure } from "../shared";
import type { DetailTabProps } from "../types";

export function DiffTab(props: DetailTabProps) {
  if (props.sectionState.status === "loading" || props.sectionState.status === "failed") {
    return (
      <SectionFailure state={props.sectionState} onRetry={props.onRetrySections} t={props.t} />
    );
  }
  const changed = TRAJECTORY_SECTION_SLOTS.map((slot, index) => ({
    slot,
    index,
    beforeRef: props.previousHeader?.sections[index] ?? null,
    afterRef: props.header?.sections[index] ?? null,
  })).filter(({ beforeRef, afterRef }) => beforeRef !== afterRef);
  if (changed.length === 0) return <Empty t={props.t} />;
  return (
    <div className="space-y-5">
      {changed.map(({ slot, index, beforeRef, afterRef }) => {
        const before = sectionContentAt(props.previousHeader, index, props.sectionById) ?? "";
        const after = sectionContentAt(props.header, index, props.sectionById) ?? "";
        let sourceOffset = 0;
        const lines = diffTrajectoryText(before, after).map((line) => {
          const key = `${line.kind}:${sourceOffset}:${line.text.length}`;
          sourceOffset += line.text.length + 1;
          return { key, line };
        });
        return (
          <section key={slot} className="space-y-1">
            <p className="font-medium">{props.t(`trajectory.details.slot.${slot}`)}</p>
            <p className="break-all font-mono text-[9px] text-muted-foreground">
              {beforeRef ?? "∅"} → {afterRef ?? "∅"}
            </p>
            <pre className="max-h-96 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px] leading-4">
              {lines.map(({ key, line }) => (
                <span
                  key={key}
                  className={cn(
                    "block whitespace-pre-wrap break-words",
                    line.kind === "added" &&
                      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    line.kind === "removed" && "bg-destructive/10 text-destructive",
                  )}
                >
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} {line.text}
                </span>
              ))}
            </pre>
          </section>
        );
      })}
    </div>
  );
}
