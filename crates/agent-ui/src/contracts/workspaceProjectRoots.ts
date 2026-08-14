import type { WorkspaceProject } from "@liveagent/app/lib/settings";

export type WorkspaceProjectRootAccess = "read" | "write";
export type WorkspaceProjectRootState = "active" | "missing" | "changed" | "pending-approval";

export type WorkspaceProjectRootGrant = {
  id: string;
  alias: string;
  displayPath: string;
  access: WorkspaceProjectRootAccess;
  state: WorkspaceProjectRootState;
};

export type WorkspaceProjectRootDraft = Pick<
  WorkspaceProjectRootGrant,
  "id" | "alias" | "displayPath" | "access"
>;

/**
 * Host-provided adapter for project-scoped filesystem grants. Grants remain in
 * the desktop host and are intentionally excluded from normal settings sync.
 */
export type WorkspaceProjectRootClient = {
  list: (project: WorkspaceProject) => Promise<readonly WorkspaceProjectRootGrant[]>;
  save: (
    project: WorkspaceProject,
    roots: readonly WorkspaceProjectRootDraft[],
  ) => Promise<readonly WorkspaceProjectRootGrant[]>;
};
