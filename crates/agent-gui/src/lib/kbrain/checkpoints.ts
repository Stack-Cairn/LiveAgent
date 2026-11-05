import type { CheckpointRewindClient } from "@liveagent/ui/lib/chat/checkpointRewind";
import { createKBrainClient } from "./client";
import { getKBrainSessionId } from "./mapping";
import { getConfiguredKBrainConnection } from "./runtimeConnection";

function connection() {
  const value = getConfiguredKBrainConnection();
  if (!value) throw new Error("K-brain backend connection is not ready");
  return value;
}

/**
 * Checkpoints are keyed by the K-brain session, while the desktop and the
 * gateway bridge address conversations by their local id. Unmapped ids (a
 * conversation that never reached the backend) are sent as-is so K-brain can
 * answer with its own empty/not-found result.
 */
function backendId(conversationId: string, baseUrl: string | undefined): string {
  const id = conversationId.trim();
  return getKBrainSessionId(id, baseUrl) ?? id;
}

export const kBrainCheckpointClient: CheckpointRewindClient = {
  list: async (conversationId) => {
    const options = getConfiguredKBrainConnection();
    if (!options) return [];
    const rows = await createKBrainClient(options).listCheckpoints(
      backendId(conversationId, options.baseUrl),
    );
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
    const options = connection();
    const row = await createKBrainClient(options).checkpointPreview(
      backendId(conversationId, options.baseUrl),
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
    const options = connection();
    const row = await createKBrainClient(options).checkpointRewind(
      backendId(conversationId, options.baseUrl),
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
