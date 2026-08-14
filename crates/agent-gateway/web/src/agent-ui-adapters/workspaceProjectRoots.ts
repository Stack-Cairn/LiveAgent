import type {
  WorkspaceProjectRootClient,
  WorkspaceProjectRootGrant,
} from "@liveagent/ui/contracts/workspaceProjectRoots";
import type { GatewayWebSocketClientLike, GatewayWorkspaceRootGrant } from "../lib/gatewaySocket";

function toProjectRootGrant(grant: GatewayWorkspaceRootGrant): WorkspaceProjectRootGrant {
  return {
    id: grant.id,
    alias: grant.alias,
    displayPath: grant.displayPath,
    access: grant.access,
    state: grant.state,
  };
}

export function createGatewayWorkspaceProjectRootClient(
  api: Pick<
    GatewayWebSocketClientLike,
    "listWorkspaceRootGrants" | "applyWorkspaceRootGrants" | "revokeWorkspaceRootGrants"
  >,
): WorkspaceProjectRootClient {
  return {
    list: async (project) =>
      (await api.listWorkspaceRootGrants(project.id, project.path)).map(toProjectRootGrant),
    save: async (project, roots) =>
      (
        await api.applyWorkspaceRootGrants(
          project.id,
          project.path,
          roots.map((root) => ({
            ...(root.id.startsWith("draft-") ? {} : { id: root.id }),
            alias: root.alias,
            displayPath: root.displayPath,
            access: root.access,
          })),
        )
      ).map(toProjectRootGrant),
    revoke: (project) => api.revokeWorkspaceRootGrants(project.id),
  };
}
