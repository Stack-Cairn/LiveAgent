import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";

type ImportReadableFilesResponse = {
  files: PendingUploadedFile[];
  skipped: string[];
};

const READABLE_FILE_KINDS = new Set([
  "text",
  "image",
  "pdf",
  "notebook",
  "word",
  "spreadsheet",
  "archive",
]);

// Exported for tests. Gateway errors are JSON with an error/message field;
// anything else (a reverse proxy's HTML error page, a truncated body) must
// not leak into the UI verbatim — map it to a friendly message instead.
export async function readFetchError(response: Response, fallback: string) {
  const fallbackWithStatus = `${fallback}（HTTP ${response.status}）`;
  if (response.status === 413) {
    return "文件过大，服务器拒绝接收（HTTP 413）。请压缩文件后重试，或调大反向代理的请求体大小限制。";
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

  if (!relativePath || !fileName || !Number.isFinite(sizeBytes) || !READABLE_FILE_KINDS.has(kind)) {
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

export async function importReadableFiles(
  token: string,
  agentId: string,
  workdir: string,
  files: File[],
): Promise<ImportReadableFilesResponse> {
  const normalizedToken = token.trim();
  const normalizedAgentId = agentId.trim();
  const normalizedWorkdir = workdir.trim();
  if (!normalizedToken) {
    throw new Error("Gateway token is required");
  }
  if (!normalizedAgentId) {
    throw new Error("agent_id is required");
  }
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

  const url = new URL(`${window.location.origin}/api/files/import`);
  url.searchParams.set("agent_id", normalizedAgentId);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
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
