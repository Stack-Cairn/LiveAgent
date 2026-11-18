import type { EditorRemoteSource } from "@liveagent/ui/components/workspace-editor/workspaceEditorFileIo";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";

export const WORKSPACE_TEXT_PAGE_BYTES = 256 * 1024;
export const WORKSPACE_EDITABLE_TEXT_MAX_BYTES = 16 * 1024 * 1024;

export type WorkspaceTextRange = {
  content: string;
  offset: number;
  nextOffset: number;
  sizeBytes: number;
  mtimeMs: number;
};

export type WorkspaceTextRangeSource = {
  workdir: string;
  path: string;
  projectPathKey: string;
  remote?: EditorRemoteSource;
};

type WorkspaceTextRangeResponse = {
  content: string;
  previewOffset?: number;
  previewNextOffset?: number | null;
  sizeBytes: number;
  mtimeMs: number;
};

export async function readWorkspaceTextRange(
  source: WorkspaceTextRangeSource,
  offset: number,
  sftpClient?: SftpClient,
): Promise<WorkspaceTextRange | null> {
  if (source.remote) {
    if (!sftpClient) return null;
    const page = await sftpClient.readText({
      sessionId: source.remote.sessionId,
      projectPathKey: source.projectPathKey,
      workdir: source.workdir,
      path: source.path,
      offset,
      maxBytes: WORKSPACE_TEXT_PAGE_BYTES,
      strictUtf8: true,
    });
    return {
      content: page.content,
      offset: page.offset,
      nextOffset: page.offset + page.bytesRead,
      sizeBytes: page.sizeBytes,
      mtimeMs: page.entry?.mtime ?? 0,
    };
  }
  const page = await invokeFs<WorkspaceTextRangeResponse>("fs_read_editable_text", {
    workdir: source.workdir,
    path: source.path,
    preview_offset: offset,
  });
  if (typeof page.previewOffset !== "number") return null;
  return {
    content: page.content,
    offset: page.previewOffset,
    nextOffset: page.previewNextOffset ?? page.sizeBytes,
    sizeBytes: page.sizeBytes,
    mtimeMs: page.mtimeMs,
  };
}
