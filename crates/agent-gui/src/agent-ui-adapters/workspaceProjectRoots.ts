import type {
  WorkspaceProjectRootClient,
  WorkspaceProjectRootGrant,
} from "@liveagent/ui/contracts/workspaceProjectRoots";
import {
  applyWorkspaceRootGrants,
  listWorkspaceRootGrants,
  revokeWorkspaceRootGrants,
  type WorkspaceRootGrant,
} from "../lib/workspaceRootGrants";

function toProjectRootGrant(grant: WorkspaceRootGrant): WorkspaceProjectRootGrant {
  return {
    id: grant.id,
    alias: grant.alias,
    displayPath: grant.displayPath,
    access: grant.access,
    state: grant.state,
  };
}

export const desktopWorkspaceProjectRootClient: WorkspaceProjectRootClient = {
  list: async (project) => (await listWorkspaceRootGrants(project)).map(toProjectRootGrant),
  save: async (project, roots) =>
    (
      await applyWorkspaceRootGrants(
        project,
        roots.map((root) => ({
          id: root.id.startsWith("draft-") ? undefined : root.id,
          alias: root.alias,
          displayPath: root.displayPath,
          access: root.access,
        })),
      )
    ).map(toProjectRootGrant),
  revoke: revokeWorkspaceRootGrants,
};
