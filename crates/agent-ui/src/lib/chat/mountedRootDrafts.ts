import { rootAliasFromPath } from "../../components/chat/workspace-project-settings/workspaceProjectSettingsUtils";
import type {
  WorkspaceProjectRootDraft,
  WorkspaceProjectRootGrant,
} from "../../contracts/workspaceProjectRoots";

export type MountedRootDraftsResult = {
  /** 现有授权 + 新增文件夹合并后的完整草稿列表（save 需要全量提交）。 */
  drafts: WorkspaceProjectRootDraft[];
  addedPaths: string[];
  skippedInsideWorkspace: string[];
  skippedOverlapping: string[];
};

function normalizeDirPath(path: string) {
  const trimmed = path.trim().replace(/\\/g, "/");
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function pathsOverlap(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 把拖入上传区的文件夹合并进现有附属目录草稿。工作空间内部的目录本就可
 * 访问，与现有授权重叠的目录会被后端事务性拒绝，两类都预先跳过并分别上
 * 报，保证一次混合拖入不会因个别目录导致整批失败。
 */
export function buildMountedRootDrafts(params: {
  projectPath: string;
  existingGrants: readonly WorkspaceProjectRootGrant[];
  folderPaths: readonly string[];
  now?: number;
}): MountedRootDraftsResult {
  const { projectPath, existingGrants, folderPaths } = params;
  const now = params.now ?? Date.now();
  const workspacePath = normalizeDirPath(projectPath);
  const drafts: WorkspaceProjectRootDraft[] = existingGrants.map((grant) => ({
    id: grant.id,
    alias: grant.alias,
    displayPath: grant.displayPath,
    access: grant.access,
  }));
  const aliases = new Set(existingGrants.map((grant) => grant.alias));
  const mountedPaths = existingGrants.map((grant) => normalizeDirPath(grant.displayPath));
  const addedPaths: string[] = [];
  const skippedInsideWorkspace: string[] = [];
  const skippedOverlapping: string[] = [];

  for (const folderPath of folderPaths) {
    const normalized = normalizeDirPath(folderPath);
    if (!normalized) continue;
    if (
      workspacePath &&
      (normalized === workspacePath || normalized.startsWith(`${workspacePath}/`))
    ) {
      skippedInsideWorkspace.push(normalized);
      continue;
    }
    if (mountedPaths.some((mounted) => pathsOverlap(mounted, normalized))) {
      skippedOverlapping.push(normalized);
      continue;
    }
    const alias = rootAliasFromPath(normalized, aliases);
    aliases.add(alias);
    mountedPaths.push(normalized);
    drafts.push({
      id: `draft-${now}-${drafts.length}`,
      alias,
      displayPath: normalized,
      access: "read",
    });
    addedPaths.push(normalized);
  }

  return { drafts, addedPaths, skippedInsideWorkspace, skippedOverlapping };
}
