export type FileMentionKind = "file" | "dir";

export type FileMentionReference = {
  path: string;
  kind: FileMentionKind;
};

export function escapeMarkdownReferenceLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

export function unescapeMarkdownReferenceLabel(value: string) {
  return value.replace(/\\([\\[\]()])/g, "$1");
}

export function formatMarkdownReferenceDestination(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (/[\s()<>]/.test(normalized)) {
    return `<${normalized.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
  }
  return normalized;
}

export function normalizeMarkdownReferenceDestination(value: string) {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return unescapeMarkdownReferenceLabel(inner).replace(/%3C/gi, "<").replace(/%3E/gi, ">");
}

export function normalizeMentionPath(value: string) {
  return value.trim().replace(/\\/g, "/");
}

function validateRelativeMentionPath(path: string) {
  if (!path || path.startsWith("/") || path.startsWith("#")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  return !path.split("/").some((part) => !part || part === "." || part === "..");
}

export function createFileMentionReference(
  rawPath: string,
  kind: FileMentionKind,
): FileMentionReference | null {
  const normalized = normalizeMentionPath(rawPath);
  const path = normalized.replace(/\/+$/, "");
  if (!validateRelativeMentionPath(path)) return null;
  return { path, kind };
}

export function parseFileMentionPath(rawPath: string): FileMentionReference | null {
  const normalized = normalizeMentionPath(rawPath);
  const kind: FileMentionKind = normalized.endsWith("/") ? "dir" : "file";
  return createFileMentionReference(normalized, kind);
}

export function fileMentionDisplayName(reference: Pick<FileMentionReference, "path" | "kind">) {
  const labelPath = reference.path.replace(/\/+$/, "");
  return labelPath.split("/").pop() || labelPath || reference.path;
}

export function fileMentionTitle(reference: Pick<FileMentionReference, "path" | "kind">) {
  return reference.path;
}

export function formatFileMentionToken(reference: Pick<FileMentionReference, "path" | "kind">) {
  const normalized = createFileMentionReference(reference.path, reference.kind);
  if (!normalized) return reference.path;
  const target = normalized.kind === "dir" ? `${normalized.path}/` : normalized.path;
  return `[${escapeMarkdownReferenceLabel(fileMentionDisplayName(normalized))}](${formatMarkdownReferenceDestination(target)})`;
}

export function parseMarkdownFileMentionReference(
  label: string,
  rawDestination: string,
): FileMentionReference | null {
  const reference = parseFileMentionPath(normalizeMarkdownReferenceDestination(rawDestination));
  if (!reference) return null;
  const normalizedLabel = unescapeMarkdownReferenceLabel(label.trim());
  return normalizedLabel === fileMentionDisplayName(reference) ? reference : null;
}
