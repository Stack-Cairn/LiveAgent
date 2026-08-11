import { useLocale } from "../../i18n/LocaleContext";
import type { TaskProgressSnapshot } from "../../lib/chat/taskProgress";
import { TaskProgressIndicator, type TaskProgressIndicatorLabels } from "./TaskProgressIndicator";

export function createTaskProgressIndicatorLabels(
  snapshot: TaskProgressSnapshot,
  translate: (key: string) => string,
): TaskProgressIndicatorLabels {
  return {
    title: translate("chat.taskProgress.title"),
    step: translate("chat.taskProgress.step")
      .replace("{current}", String(snapshot.currentStep))
      .replace("{total}", String(snapshot.totalCount)),
    completedCount: `${snapshot.completedCount}/${snapshot.totalCount} ${translate(
      "chat.taskProgress.completedCount",
    )}`,
    running: translate("chat.taskProgress.running"),
    pending: translate("chat.taskProgress.pending"),
    paused: translate("chat.taskProgress.paused"),
    completed: translate("chat.taskProgress.completed"),
  };
}

export function TaskProgressBar({
  snapshot,
  isConversationRunning,
}: {
  snapshot: TaskProgressSnapshot | null;
  isConversationRunning: boolean;
}) {
  const { t } = useLocale();
  if (!snapshot) return null;
  return (
    <TaskProgressIndicator
      snapshot={snapshot}
      isConversationRunning={isConversationRunning}
      labels={createTaskProgressIndicatorLabels(snapshot, t)}
    />
  );
}
