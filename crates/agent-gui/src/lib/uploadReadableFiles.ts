import type { PendingUploadedFile } from "./chat/messages/uploadedFiles";
import { resolveHeadlessBaseUrl } from "./tauriBridge";

type ImportReadableFilesResponse = {
  files: PendingUploadedFile[];
  skipped: string[];
};

// Same protocol as the agent-gateway WebUI upload helper
// (crates/agent-gateway/web/src/lib/uploadReadableFiles.ts): multipart
// FormData → POST /api/files/import, server replies { files, skipped } with
// PendingUploadedFile entries. Headless mode has no gateway agent_id / Bearer
// token — the WebUI is served same-origin by the headless server, which
// exempts same-origin requests from token auth (matching /api/invoke).
//
// Gateway errors are JSON with an error/message field; anything else (a
// reverse proxy's HTML error page, a truncated body) must not leak into the
// UI verbatim — map it to a friendly message instead.
async function readFetchError(response: Response, fallback: string) {
  const fallbackWithStatus = `${fallback}（HTTP ${response.status}）`;
  if (response.status === 413) {
    return "文件过大，服务器拒绝接收（HTTP 413）。请压缩文件后重试，或调大 LIVEAGENT_HEADLESS_MAX_BODY_MB。";
  }
  const raw = (await response.text().catch(() => "")).trim();
  if (!raw) {
    return fallbackWithStatus;
  }

  try {
    const payload = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const errorText =
      typeof payload.error === "string"
        ? payload.error.trim()
        : typeof payload.message === "string"
          ? payload.message.trim()
          : "";
    return errorText || fallbackWithStatus;
  } catch {
    if (raw.startsWith("<") || raw.length > 300) {
      return fallbackWithStatus;
    }
    return raw;
  }
}

function normalizeUploadedFile(value: unknown): PendingUploadedFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const relativePath = typeof record.relativePath === "string" ? record.relativePath.trim() : "";
  const fileName = typeof record.fileName === "string" ? record.fileName.trim() : "";
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const sizeBytes = typeof record.sizeBytes === "number" ? record.sizeBytes : NaN;

  if (!relativePath || !fileName || !kind || !Number.isFinite(sizeBytes)) {
    return null;
  }

  return {
    relativePath,
    absolutePath:
      typeof record.absolutePath === "string" && record.absolutePath.trim()
        ? record.absolutePath.trim()
        : undefined,
    fileName,
    kind: kind as PendingUploadedFile["kind"],
    sizeBytes,
  };
}

/**
 * Upload files to the headless server via multipart (POST /api/files/import).
 * The browser sets the multipart boundary automatically; no Content-Type
 * header should be set manually. `agent_id` is omitted — headless mode is
 * single-agent and the server ignores it for protocol parity.
 */
export async function importReadableFilesViaMultipart(
  workdir: string,
  files: File[],
): Promise<ImportReadableFilesResponse> {
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) {
    throw new Error("项目目录未选择，无法导入文件。");
  }
  if (files.length === 0) {
    return { files: [], skipped: [] };
  }

  const formData = new FormData();
  formData.set("workdir", normalizedWorkdir);
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  const response = await fetch(`${resolveHeadlessBaseUrl()}/api/files/import`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readFetchError(response, "导入文件失败"));
  }

  const payload = (await response.json()) as {
    files?: unknown[];
    skipped?: unknown[];
  };

  return {
    files: Array.isArray(payload.files)
      ? payload.files
          .map(normalizeUploadedFile)
          .filter((file): file is PendingUploadedFile => file !== null)
      : [],
    skipped: Array.isArray(payload.skipped)
      ? payload.skipped.filter((item): item is string => typeof item === "string")
      : [],
  };
}
