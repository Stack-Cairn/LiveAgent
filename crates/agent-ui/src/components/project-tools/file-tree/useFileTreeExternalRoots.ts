// External (multi-root) grants for a project's file tree. Shared by the
// Right Dock panel and the Workbench file tree pane so both hosts render the
// same roots regardless of which one currently holds the interactive tree.

import type { WorkspaceProject } from "@liveagent/app/lib/settings";
import type { WorkspaceProjectRootClient } from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileTreeExternalRoot } from "./model";

const NO_EXTERNAL_FILE_TREE_ROOTS: FileTreeExternalRoot[] = [];

export function useFileTreeExternalRoots(params: {
  workspaceProject?: WorkspaceProject;
  workspaceProjectRootClient?: WorkspaceProjectRootClient;
  /** Bump to re-list after a grant mutation elsewhere in the app. */
  workspaceRootRevision?: number;
}): {
  externalRoots: readonly FileTreeExternalRoot[];
  refreshExternalRoots: () => Promise<void>;
} {
  const { workspaceProject, workspaceProjectRootClient, workspaceRootRevision = 0 } = params;
  const [externalRoots, setExternalRoots] = useState<FileTreeExternalRoot[]>([]);
  const [scope, setScope] = useState("");
  const requestRef = useRef(0);
  // Scope pins the fetched roots to the project they were listed for, so a
  // project switch never briefly shows the previous project's grants.
  const workspaceRootScope = workspaceProject
    ? `${workspaceProject.id}\u0000${workspaceProject.path}`
    : "";
  const refreshExternalRoots = useCallback(
    async (_revision?: number) => {
      const requestId = ++requestRef.current;
      if (!workspaceProject || !workspaceProjectRootClient) {
        setExternalRoots([]);
        setScope(workspaceRootScope);
        return;
      }
      try {
        const grants = await workspaceProjectRootClient.list(workspaceProject);
        if (requestId !== requestRef.current) return;
        setExternalRoots(
          grants
            .filter(
              (grant) => grant.state === "active" && grant.id.trim() && grant.displayPath.trim(),
            )
            .map((grant) => ({
              id: grant.id.trim(),
              name: grant.alias.trim() || grant.displayPath.trim(),
              cwd: grant.displayPath.trim(),
            })),
        );
        setScope(workspaceRootScope);
      } catch {
        if (requestId === requestRef.current) {
          setExternalRoots([]);
          setScope(workspaceRootScope);
        }
      }
    },
    [workspaceProject, workspaceProjectRootClient, workspaceRootScope],
  );
  useEffect(() => {
    void refreshExternalRoots(workspaceRootRevision);
  }, [refreshExternalRoots, workspaceRootRevision]);
  return {
    externalRoots: scope === workspaceRootScope ? externalRoots : NO_EXTERNAL_FILE_TREE_ROOTS,
    refreshExternalRoots,
  };
}
