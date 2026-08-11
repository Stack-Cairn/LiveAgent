import { WorkspaceCloneTaskOverlay } from "@liveagent/ui/components/chat/WorkspaceCloneTaskOverlay";
import {
  cancelWorkspaceCloneTask,
  dismissWorkspaceCloneTask,
  useWorkspaceCloneTasks,
} from "../pages/chat/workspace/cloneTasks";

export function WorkspaceCloneTaskOverlayAdapter(props: {
  onOpenWorkspace: (path: string) => void;
}) {
  const tasks = useWorkspaceCloneTasks();
  return (
    <WorkspaceCloneTaskOverlay
      tasks={tasks}
      onCancel={(taskId) => void cancelWorkspaceCloneTask(taskId)}
      onDismiss={dismissWorkspaceCloneTask}
      onOpenWorkspace={props.onOpenWorkspace}
    />
  );
}
