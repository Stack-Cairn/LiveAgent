import {
  TRAJECTORY_PROMPT_SECTION_SLOTS,
  TRAJECTORY_SECTION_SLOTS,
} from "../../../../lib/trajectory/types";
import { sectionContentAt } from "../sectionData";
import { Empty, SectionFailure, TextBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function SystemPromptTab(props: DetailTabProps) {
  const failure = (
    <SectionFailure state={props.sectionState} onRetry={props.onRetrySections} t={props.t} />
  );
  if (props.sectionState.status === "loading" || props.sectionState.status === "failed") {
    return failure;
  }
  if (props.header === undefined) return <Empty t={props.t} />;
  const indexes = TRAJECTORY_PROMPT_SECTION_SLOTS.map((slot) => ({
    slot,
    index: TRAJECTORY_SECTION_SLOTS.indexOf(slot),
  }));
  const visible = indexes.filter(
    ({ index }) => sectionContentAt(props.header, index, props.sectionById) !== undefined,
  );
  if (visible.length === 0) return <Empty t={props.t} />;
  return (
    <div className="space-y-4">
      {visible.map(({ slot, index }) => (
        <section key={slot} className="space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {props.t(`trajectory.details.slot.${slot}`)}
          </p>
          <TextBlock value={sectionContentAt(props.header, index, props.sectionById)} t={props.t} />
        </section>
      ))}
    </div>
  );
}
