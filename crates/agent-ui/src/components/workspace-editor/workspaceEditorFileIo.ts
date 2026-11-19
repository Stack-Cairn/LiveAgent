import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { invokeFs, isFsBackendError } from "@liveagent/ui/lib/tools/fsBackend";
import { WORKSPACE_EDITABLE_TEXT_MAX_BYTES } from "./workspaceTextRange";

// Data-source dispatch for WorkspaceCodeEditorOverlay tabs. Local tabs go
// through the workspace fs backend; remote tabs go through the SFTP session
// of the SSH terminal the file was opened from.

export type EditorRemoteSource = {
  sessionId: string;
};

class EditorFileTooLargeError extends Error {}

export function isEditorFileTooLarge(error: unknown) {
  if (error instanceof EditorFileTooLargeError) return true;
  if (isFsBackendError(error) && error.code === "too_large") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /file is too large to edit|file exceeds [\d.]+ MiB|exceeds the editable file limit/i.test(
    message,
  );
}

export type EditorReadResult = {
  path: string;
  content: string;
  mtimeMs: number;
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
};

export type EditorWriteResult =
  | {
      kind: "ok";
      mtimeMs: number;
      contentHash: string;
      sizeBytes: number;
      totalLines: number | null;
    }
  | { kind: "conflict" };

export type EditorFileIo = {
  read(params: { workdir: string; path: string }): Promise<EditorReadResult>;
  write(params: {
    workdir: string;
    path: string;
    content: string;
    expectedMtimeMs: number;
    expectedContentHash: string;
    expectedSizeBytes: number;
  }): Promise<EditorWriteResult>;
};

type LocalReadResponse = {
  path: string;
  content: string;
  mtimeMs: number;
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
};

type LocalWriteResponse = {
  path: string;
  bytesWritten: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
};

function isLocalVersionConflict(error: unknown) {
  if (isFsBackendError(error) && error.code === "stale_file") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /file changed since (?:the last full )?read/i.test(message);
}

function countLines(content: string) {
  if (!content) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export const localEditorFileIo: EditorFileIo = {
  async read(params) {
    return invokeFs<LocalReadResponse>("fs_read_editable_text", {
      workdir: params.workdir,
      path: params.path,
    });
  },
  async write(params) {
    try {
      const response = await invokeFs<LocalWriteResponse>("fs_write_text", {
        workdir: params.workdir,
        path: params.path,
        content: params.content,
        mode: "rewrite",
        expected_mtime_ms: params.expectedMtimeMs,
        expected_content_hash: params.expectedContentHash,
      });
      return {
        kind: "ok",
        mtimeMs: response.mtimeMs,
        contentHash: response.contentHash,
        sizeBytes: response.bytesWritten,
        totalLines: response.totalLines,
      };
    } catch (error) {
      if (isLocalVersionConflict(error)) return { kind: "conflict" };
      throw error;
    }
  },
};

export function createRemoteSftpEditorFileIo(params: {
  sftpClient: SftpClient;
  sessionId: string;
  projectPathKey: string;
  onTooLarge: () => string;
}): EditorFileIo {
  const { sftpClient, sessionId, projectPathKey, onTooLarge } = params;
  return {
    async read(readParams) {
      const response = await sftpClient.readText({
        sessionId,
        projectPathKey,
        workdir: readParams.workdir,
        path: readParams.path,
        maxBytes: WORKSPACE_EDITABLE_TEXT_MAX_BYTES,
        strictUtf8: true,
      });
      if (response.truncated) {
        throw new EditorFileTooLargeError(onTooLarge());
      }
      return {
        path: response.path,
        content: response.content,
        mtimeMs: response.entry?.mtime ?? 0,
        contentHash: response.contentHash ?? "",
        sizeBytes: response.entry?.sizeBytes ?? response.sizeBytes,
        totalLines: countLines(response.content),
      };
    },
    async write(writeParams) {
      const response = await sftpClient.writeText({
        sessionId,
        projectPathKey,
        workdir: writeParams.workdir,
        path: writeParams.path,
        content: writeParams.content,
        // 0 means "no baseline" (missing entry / empty file): skip that guard
        // instead of passing 0, matching the gateway's 0→None convention so
        // both transports behave identically.
        expectedContentHash: writeParams.expectedContentHash || undefined,
        expectedMtime: writeParams.expectedMtimeMs > 0 ? writeParams.expectedMtimeMs : undefined,
        expectedSizeBytes:
          writeParams.expectedSizeBytes > 0 ? writeParams.expectedSizeBytes : undefined,
      });
      if (response.action === "conflict") return { kind: "conflict" };
      return {
        kind: "ok",
        mtimeMs: response.entry?.mtime ?? 0,
        contentHash: response.contentHash ?? "",
        sizeBytes:
          response.entry?.sizeBytes ?? new TextEncoder().encode(writeParams.content).length,
        totalLines: null,
      };
    },
  };
}
