import type { ComponentProps } from "react";
import { translate } from "../../lib/planning/i18n";
import { taskListLayer, taskLists } from "../../lib/planning/taskLists";
import type { PlanningSnapshot } from "../../lib/planning/types";
import type { TaskFilter } from "./PlanningSidebar";
import { TaskPanel } from "./TaskPanel";

type PanelProps = Omit<ComponentProps<typeof TaskPanel>, "list" | "variant" | "snapshot">;

/** Google Tasks full view: every visible list as a card, laid out as columns. */
export function TasksBoard({
  snapshot,
  hidden,
  filter,
  ...panel
}: PanelProps & { snapshot: PlanningSnapshot; hidden: Set<string>; filter: TaskFilter }) {
  const lists =
    filter === "starred"
      ? [{ id: "starred" }]
      : taskLists(snapshot).filter((l) => !hidden.has(taskListLayer(l.id)));
  return (
    <div className="planning-board">
      {lists.map((list) => (
        <section
          key={list.id}
          className="planning-board-card"
          aria-label={translate("planner.board.card")}
        >
          <TaskPanel {...panel} snapshot={snapshot} list={list.id} variant="card" />
        </section>
      ))}
      {!lists.length && (
        <p className="p-6 text-sm text-muted-foreground">{translate("planner.board.empty")}</p>
      )}
    </div>
  );
}
