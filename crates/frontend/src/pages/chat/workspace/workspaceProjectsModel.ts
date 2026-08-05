import { listChatHistory } from "../../../lib/chat/history/chatHistory";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  type WorkspaceProject,
} from "../../../lib/settings";
import { fallbackWorkspaceProjectName } from "../../../lib/workspaceProjects";

const PROJECT_HISTORY_DELETE_PAGE_SIZE = 200;

export async function listChatHistoryIdsForProjectPath(projectPath: string) {
  const cwd = projectPath.trim();
  if (!cwd) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await listChatHistory(pageNumber, PROJECT_HISTORY_DELETE_PAGE_SIZE, { cwd });
    for (const item of page.items) {
      const id = item.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    if (
      page.items.length === 0 ||
      ids.length >= page.totalCount ||
      page.items.length < PROJECT_HISTORY_DELETE_PAGE_SIZE
    ) {
      break;
    }
  }
  return ids;
}

export function getDefaultWorkspaceProjectPath(system: AppSettings["system"]) {
  return (
    system.workspaceProjects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.path ||
    system.workdir
  );
}

export function createWorkspaceProjectFromPath(path: string, kind: WorkspaceProject["kind"]) {
  const now = Date.now();
  return {
    id: `${kind}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: fallbackWorkspaceProjectName(path),
    path,
    kind,
    createdAt: now,
    updatedAt: now,
  } satisfies WorkspaceProject;
}
