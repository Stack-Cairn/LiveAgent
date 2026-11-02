import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import { type ReactNode, useCallback } from "react";
import { createKBrainClient } from "../../../lib/kbrain/client";
import { getConfiguredKBrainConnection } from "../../../lib/kbrain/runtimeConnection";
import type { WorkspaceProject } from "../../../lib/settings";
import { listWorkspaceRootGrants } from "../../../lib/workspaceRootGrants";

const client: CheckpointRewindClient = {
  list: async (conversationId) => {
    const connection = getConfiguredKBrainConnection();
    if (!connection) return [];
    const rows = await createKBrainClient(connection).listCheckpoints(conversationId);
    return rows.map((row) => ({
      turnSeq: row.turn_seq,
      turnId: row.turn_id,
      fileCount: row.file_count,
      dirCount: row.dir_count,
      incomplete: row.incomplete,
      firstCapturedAt: row.first_captured_at,
    }));
  },
  preview: async ({ conversationId, turnSeq, authorizedRoots }) => {
    const connection = getConfiguredKBrainConnection();
    if (!connection) throw new Error("K-brain backend connection is not ready");
    const row = await createKBrainClient(connection).checkpointPreview(
      conversationId,
      turnSeq,
      authorizedRoots,
    );
    return {
      turnSeq: row.turn_seq,
      restoreFiles: row.restore_files,
      deleteFiles: row.delete_files,
      cleanFiles: row.clean_files,
      skippedDirs: row.skipped_dirs,
      missingBlobs: row.missing_blobs,
      unresolvableFiles: row.unresolvable_files,
      captureErrors: row.capture_errors,
      entries: row.entries.map((entry) => ({
        path: entry.path,
        key: entry.key,
        action: entry.action,
        ...(entry.current_hash ? { currentHash: entry.current_hash } : {}),
      })),
    };
  },
  rewind: async ({ conversationId, turnSeq, authorizedRoots, expected }) => {
    const connection = getConfiguredKBrainConnection();
    if (!connection) throw new Error("K-brain backend connection is not ready");
    const row = await createKBrainClient(connection).checkpointRewind(
      conversationId,
      turnSeq,
      authorizedRoots,
      expected,
    );
    return {
      turnSeq: row.turn_seq,
      restoredFiles: row.restored_files,
      deletedFiles: row.deleted_files,
      cleanFiles: row.clean_files,
      skippedDirs: row.skipped_dirs,
      captureErrors: row.capture_errors,
      conflicts: row.conflicts,
      failed: row.failed,
    };
  },
};

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
      client={client}
      conversationId={props.conversationId}
      disabled={props.disabled}
      resolveAuthorizedRoots={resolveAuthorizedRoots}
      onRewound={props.onRewound}
    >
      {props.children}
    </CheckpointRewindProvider>
  );
}
