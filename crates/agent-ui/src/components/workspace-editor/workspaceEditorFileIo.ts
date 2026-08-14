import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { invokeFs, isFsBackendError } from "@liveagent/ui/lib/tools/fsBackend";

// Data-source dispatch for WorkspaceCodeEditorOverlay tabs. Local tabs go
// through the workspace fs backend; remote tabs go through the SFTP session
// of the SSH terminal the file was opened from.

export type EditorRemoteSource = {
  sessionId: string;
};

// Mirrors EDITABLE_TEXT_MAX_BYTES (fs.rs) and SFTP_READ_TEXT_MAX_BYTES so
// remote files can be opened up to the same size as local ones.
export const REMOTE_EDITABLE_TEXT_MAX_BYTES = 3 * 1024 * 1024;

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
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
};

function isLocalVersionConflict(error: unknown) {
  if (isFsBackendError(error) && error.code === "stale_file") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("File changed since the last full Read");
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
        sizeBytes: new TextEncoder().encode(params.content).length,
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
        maxBytes: REMOTE_EDITABLE_TEXT_MAX_BYTES,
        strictUtf8: true,
      });
      // A truncated buffer written back would destroy the file's tail, so
      // oversized files are rejected outright instead of opened read-only.
      if (response.truncated) {
        throw new Error(onTooLarge());
      }
      return {
        path: response.path,
        content: response.content,
        mtimeMs: response.entry?.mtime ?? 0,
        // Remote conflict detection uses mtime+size (checked server-side
        // under the SFTP connection lock); there is no content hash.
        contentHash: "",
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
        expectedMtime: writeParams.expectedMtimeMs > 0 ? writeParams.expectedMtimeMs : undefined,
        expectedSizeBytes:
          writeParams.expectedSizeBytes > 0 ? writeParams.expectedSizeBytes : undefined,
      });
      if (response.action === "conflict") return { kind: "conflict" };
      const contentBytes = new TextEncoder().encode(writeParams.content).length;
      return {
        kind: "ok",
        mtimeMs: response.entry?.mtime ?? 0,
        contentHash: "",
        sizeBytes: response.entry?.sizeBytes ?? contentBytes,
        totalLines: null,
      };
    },
  };
}
