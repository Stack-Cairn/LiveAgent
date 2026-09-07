import {
  type AppSettings,
  closeRightDockBackgroundTasksTabState,
  updateRightDockProjectState,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { closeRightDockToolTabState } from "../../components/project-tools/rightDockModel";
import { getManagedProcessState } from "../managed-process/store";
import type { ProjectToolSurfaceKind } from "../workbench/types";

/**
 * Closing a project tool pane closes the tool everywhere: the dock must not
 * re-surface the tab the moment the lease is released. Tool tabs drop their
 * persisted `tools[kind]` entry (the file tree's per-project UI state is
 * part of that entry and is recreated on the next open); the derived
 * background-tasks tab is hidden the same way its own close button hides it,
 * snapshotting the currently visible process ids so a newly started process
 * still brings it back. A tool that was never in the dock is a no-op.
 */
export function releaseProjectToolFromDock(
  prev: AppSettings,
  tool: ProjectToolSurfaceKind,
  projectPathKey: string,
): AppSettings {
  if (tool === "backgroundTasks") {
    const visibleIds = getManagedProcessState().processes.map((process) => process.id);
    const projectKeys = new Set(Object.keys(prev.customSettings.rightDock.projects));
    const originProjectKey = workspaceProjectPathKey(projectPathKey);
    if (originProjectKey) projectKeys.add(originProjectKey);

    // Background tasks are a window-wide surface backed by one global process
    // registry. Close every persisted dock projection before releasing the
    // workbench lease; otherwise a derived tab (opened=false but a process is
    // visible), or another project's opened tab, immediately resurfaces.
    let next = prev;
    for (const key of projectKeys) {
      next = updateRightDockProjectState(next, key, (current) => {
        const visible =
          current.backgroundTasks.opened ||
          visibleIds.some((id) => !current.backgroundTasks.dismissedIds.includes(id));
        return visible ? closeRightDockBackgroundTasksTabState(current, visibleIds) : current;
      });
    }
    return next;
  }
  return updateRightDockProjectState(prev, projectPathKey, (current) => {
    return closeRightDockToolTabState(current, tool, null);
  });
}
