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

async function readFetchError(response: Response, fallback: string) {
  const raw = (await response.text()).trim();
  if (!raw) {
    return fallback;
  }

  try {
    const payload = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const errorText =
      typeof payload.error === "string"
        ? payload.error.trim()
        : typeof payload.message === "string"
          ? payload.message.trim()
          : "";
    return errorText || raw;
  } catch {
    return raw;
  }
}

function normalizeUploadedFile(value: unknown): PendingUploadedFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const relativePath =
    typeof record.relativePath === "string" ? record.relativePath.trim() : "";
  const fileName = typeof record.fileName === "string" ? record.fileName.trim() : "";
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const sizeBytes = typeof record.sizeBytes === "number" ? record.sizeBytes : NaN;

  if (
    !relativePath ||
    !fileName ||
    !Number.isFinite(sizeBytes) ||
    !READABLE_FILE_KINDS.has(kind)
  ) {
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
  workdir: string,
  files: File[],
): Promise<ImportReadableFilesResponse> {
  const normalizedToken = token.trim();
  const normalizedWorkdir = workdir.trim();
  if (!normalizedToken) {
    throw new Error("Gateway token is required");
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

  const response = await fetch(`${window.location.origin}/api/files/import`, {
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
