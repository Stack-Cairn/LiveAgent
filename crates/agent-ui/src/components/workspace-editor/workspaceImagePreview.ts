const WORKSPACE_IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const WORKSPACE_PDF_EXTENSIONS = new Set(["pdf"]);

const WORKSPACE_HTML_EXTENSIONS = new Set(["html", "htm"]);

const WORKSPACE_MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);

const WORKSPACE_DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "rtf"]);

const WORKSPACE_SPREADSHEET_EXTENSIONS = new Set([
  "csv",
  "ods",
  "tsv",
  "xls",
  "xlsm",
  "xlsx",
  "xltm",
  "xltx",
]);

const WORKSPACE_AUDIO_EXTENSIONS = new Set(["flac", "m4a", "mp3", "oga", "ogg", "wav"]);

const WORKSPACE_VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

const WORKSPACE_TEXT_EXTENSIONS = new Set(["log", "txt"]);

export type WorkspacePreviewKind =
  | "audio"
  | "document"
  | "html"
  | "image"
  | "markdown"
  | "pdf"
  | "spreadsheet"
  | "text"
  | "video";

export function workspacePathExtension(path: string) {
  const normalized = path.trim().replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex < 0) return "";
  return name.slice(extensionIndex + 1).toLowerCase();
}

export function isWorkspaceImagePath(path: string) {
  return WORKSPACE_IMAGE_EXTENSIONS.has(workspacePathExtension(path));
}

export function getWorkspacePreviewKind(path: string): WorkspacePreviewKind | null {
  const extension = workspacePathExtension(path);
  if (!extension) return null;
  if (WORKSPACE_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (WORKSPACE_PDF_EXTENSIONS.has(extension)) return "pdf";
  if (WORKSPACE_HTML_EXTENSIONS.has(extension)) return "html";
  if (WORKSPACE_MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (WORKSPACE_DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (WORKSPACE_SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet";
  if (WORKSPACE_AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (WORKSPACE_VIDEO_EXTENSIONS.has(extension)) return "video";
  if (WORKSPACE_TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

export function isWorkspacePreviewPath(path: string) {
  return getWorkspacePreviewKind(path) !== null;
}

export function isWorkspaceEditablePreviewPath(path: string) {
  const extension = workspacePathExtension(path);
  if (!extension) return false;
  return (
    WORKSPACE_HTML_EXTENSIONS.has(extension) ||
    WORKSPACE_MARKDOWN_EXTENSIONS.has(extension) ||
    WORKSPACE_TEXT_EXTENSIONS.has(extension) ||
    extension === "csv" ||
    extension === "tsv"
  );
}
