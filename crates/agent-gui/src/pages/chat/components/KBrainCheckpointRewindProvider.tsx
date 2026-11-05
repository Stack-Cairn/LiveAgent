import {
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import { type ReactNode, useCallback } from "react";
import { kBrainCheckpointClient } from "../../../lib/kbrain/checkpoints";
import type { WorkspaceProject } from "../../../lib/settings";
import { listWorkspaceRootGrants } from "../../../lib/workspaceRootGrants";

export function KBrainCheckpointRewindProvider(props: {
  children: ReactNode;
  conversationId: string;
  workspaceRoot?: string;
  project?: Pick<WorkspaceProject, "id" | "path"> | null;
  disabled?: boolean;
  onRewound?: (info: CheckpointRewoundInfo) => void;
}) {
  const resolveAuthorizedRoots = useCallback(async () => {
    const roots: string[] = [];
    const add = (value?: string | null) => {
      const root = value?.trim();
      if (root && !roots.includes(root)) roots.push(root);
    };
    add(props.workspaceRoot);
    if (props.project) {
      try {
        const grants = await listWorkspaceRootGrants(props.project);
        for (const grant of grants)
          if (grant.state === "active" && grant.access === "write") add(grant.canonicalPath);
      } catch {
        // A failed grant lookup must not broaden the writable root set.
      }
    }
    return roots;
  }, [props.project, props.workspaceRoot]);

  return (
    <CheckpointRewindProvider
      client={kBrainCheckpointClient}
      conversationId={props.conversationId}
      disabled={props.disabled}
      resolveAuthorizedRoots={resolveAuthorizedRoots}
      onRewound={props.onRewound}
    >
      {props.children}
    </CheckpointRewindProvider>
  );
}
