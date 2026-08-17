import { type WorkspaceProject, workspaceProjectPathKey } from "../../../lib/settings";

/**
 * focusedPane → activeProject 的解析核心:聚焦 Pane(或其兜底目标)携带的
 * projectPathKey 映射到 Right Dock 应跟随的工作区项目。
 *
 * 不变量(docs/design/session-workbench-multi-conversation-implementation-task.md §7.4):
 * - archived / missing 项目不激活——Pane 进 blocked 态,dock 保持原项目;
 * - 陈旧的 ProjectRef(合成 key、已删除项目)绝不回退到另一个项目;
 * - 匹配按规范化 path key,与 blocked 判定使用同一套键空间。
 */
export function resolveWorkbenchPaneProject(
  projectPathKey: string | undefined,
  input: {
    workspaceProjects: readonly WorkspaceProject[];
    archivedWorkspaceProjectPathKeys: ReadonlySet<string>;
    missingWorkspaceProjectPathKeys: ReadonlySet<string>;
  },
): WorkspaceProject | null {
  if (!projectPathKey) return null;
  if (input.archivedWorkspaceProjectPathKeys.has(projectPathKey)) return null;
  if (input.missingWorkspaceProjectPathKeys.has(projectPathKey)) return null;
  return (
    input.workspaceProjects.find(
      (project) => workspaceProjectPathKey(project.path) === projectPathKey,
    ) ?? null
  );
}
