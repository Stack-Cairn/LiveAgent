import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceProject } from "./settings";

export type WorkspaceRootAccess = "read" | "write";
export type WorkspaceRootGrantState = "active" | "missing" | "changed";

export type WorkspaceRootGrant = {
  id: string;
  projectId: string;
  projectPathKey: string;
  alias: string;
  displayPath: string;
  canonicalPath: string;
  access: WorkspaceRootAccess;
  state: WorkspaceRootGrantState;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceRootGrantDraft = {
  id?: string;
  alias: string;
  displayPath: string;
  access: WorkspaceRootAccess;
};

function commandArgs(project: Pick<WorkspaceProject, "id" | "path">) {
  return {
    projectId: project.id,
    projectPath: project.path,
  };
}

export async function listWorkspaceRootGrants(project: Pick<WorkspaceProject, "id" | "path">) {
  return invoke<WorkspaceRootGrant[]>("workspace_root_grants_list", commandArgs(project));
}

export async function applyWorkspaceRootGrants(
  project: Pick<WorkspaceProject, "id" | "path">,
  grants: readonly WorkspaceRootGrantDraft[],
) {
  return invoke<WorkspaceRootGrant[]>("workspace_root_grants_apply", {
    ...commandArgs(project),
    grants,
  });
}

export async function revokeWorkspaceRootGrants(project: Pick<WorkspaceProject, "id">) {
  await invoke("workspace_root_grants_revoke", {
    projectId: project.id,
  });
}
