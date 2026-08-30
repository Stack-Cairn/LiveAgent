export type FileMentionKind = "file" | "dir";

export type FileMentionReference = {
  path: string;
  kind: FileMentionKind;
};

export type ConversationMentionReference = {
  id: string;
  title: string;
  cwd?: string;
  updatedAt?: number;
};

export const MAX_CONVERSATION_MENTION_REFERENCES = 3;

export const MARKDOWN_REFERENCE_PATTERN = /\[((?:\\.|[^\]\\\r\n])+)]\((<[^>\r\n]+>|[^)\r\n]+)\)/g;

function trimUnicodeWhitespace(value: string) {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

function collapseUnicodeWhitespace(value: string) {
  return trimUnicodeWhitespace(value).replace(/\p{White_Space}+/gu, " ");
}

function truncateUnicodeScalars(value: string, maxLength: number) {
  return [...value].slice(0, maxLength).join("");
}

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
  const baseName = labelPath.split("/").pop() || labelPath || reference.path;
  return baseName;
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

function normalizeConversationMentionId(value: string) {
  const id = trimUnicodeWhitespace(value);
  const characters = [...id];
  if (!id || characters.length > 256) return "";
  for (const character of id) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return "";
  }
  return id;
}

export function createConversationMentionReference(
  input: ConversationMentionReference,
): ConversationMentionReference | null {
  const id = normalizeConversationMentionId(input.id);
  const title = truncateUnicodeScalars(collapseUnicodeWhitespace(input.title), 240);
  if (!id || !title) return null;
  const cwd = input.cwd ? trimUnicodeWhitespace(input.cwd) || undefined : undefined;
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : undefined;
  return {
    id,
    title,
    ...(cwd ? { cwd } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

export function normalizeConversationMentionReferences(
  references: readonly ConversationMentionReference[] | null | undefined,
  currentConversationId?: string,
) {
  const normalized: ConversationMentionReference[] = [];
  const seen = new Set<string>();
  const currentId = currentConversationId
    ? normalizeConversationMentionId(currentConversationId)
    : "";
  for (const reference of references ?? []) {
    const next = createConversationMentionReference(reference);
    if (!next || next.id === currentId || seen.has(next.id)) continue;
    seen.add(next.id);
    normalized.push(next);
    if (normalized.length >= MAX_CONVERSATION_MENTION_REFERENCES) break;
  }
  return normalized;
}

export function formatConversationMentionToken(reference: ConversationMentionReference) {
  const normalized = createConversationMentionReference(reference);
  if (!normalized) return reference.title || reference.id;
  const label = `conversation: ${normalized.title}`;
  const destination = `conversation:${encodeURIComponent(normalized.id)}`;
  return `[${escapeMarkdownReferenceLabel(label)}](${destination})`;
}

export function parseMarkdownConversationMentionReference(
  label: string,
  rawDestination: string,
): ConversationMentionReference | null {
  const destination = normalizeMarkdownReferenceDestination(rawDestination);
  if (!destination.toLowerCase().startsWith("conversation:")) return null;
  let id = "";
  try {
    id = decodeURIComponent(destination.slice("conversation:".length));
  } catch {
    return null;
  }
  const normalizedLabel = unescapeMarkdownReferenceLabel(label.trim());
  const titleMatch = /^conversation:\s*(.+)$/i.exec(normalizedLabel);
  if (!titleMatch?.[1]) return null;
  return createConversationMentionReference({ id, title: titleMatch[1] });
}

export type AppMentionReference = {
  name: string;
  /** macOS bundle id；其他平台可能缺失，此时以 path 兜底标识。 */
  bundleId?: string;
  path: string;
};

/** Serialize an app mention so the model can address the app via the CUA
 *  toolset: the visible name plus the stable identity (bundle id, or the
 *  install path when the platform has no bundle ids). 组件内序列化与发送
 *  路径（composerDraft）共用这一份实现。 */
export function formatAppMentionToken(app: AppMentionReference) {
  const identity = app.bundleId?.trim() || app.path.trim();
  if (!identity || identity === app.name) return `app "${app.name}"`;
  return `app "${app.name}" (${identity})`;
}

export function parseMarkdownFileMentionReference(
  label: string,
  rawDestination: string,
): FileMentionReference | null {
  const reference = parseFileMentionPath(normalizeMarkdownReferenceDestination(rawDestination));
  if (!reference) return null;
  const normalizedLabel = unescapeMarkdownReferenceLabel(label.trim());
  const displayName = fileMentionDisplayName(reference);
  return normalizedLabel === displayName ? reference : null;
}

export type CodeMentionReference = {
  path: string;
  startLine: number;
  endLine: number;
};

function normalizeCodeMentionLine(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export function createCodeMentionReference(raw: {
  path: string;
  startLine: number;
  endLine: number;
}): CodeMentionReference | null {
  const path = normalizeMentionPath(raw.path).replace(/\/+$/, "");
  if (!validateRelativeMentionPath(path)) return null;
  const startLine = normalizeCodeMentionLine(raw.startLine, 1);
  const endLine = Math.max(startLine, normalizeCodeMentionLine(raw.endLine, startLine));
  return { path, startLine, endLine };
}

export function codeMentionLineLabel(
  reference: Pick<CodeMentionReference, "startLine" | "endLine">,
) {
  return reference.startLine === reference.endLine
    ? `${reference.startLine}`
    : `${reference.startLine}～${reference.endLine}`;
}

export function codeMentionDisplayName(reference: Pick<CodeMentionReference, "path">) {
  const fileName = reference.path.split("/").pop() || reference.path;
  return fileName;
}

export function codeMentionTitle(reference: CodeMentionReference) {
  return `${reference.path}:${codeMentionLineLabel(reference)}`;
}

function codeMentionLineToken(reference: Pick<CodeMentionReference, "startLine" | "endLine">) {
  return reference.startLine === reference.endLine
    ? `${reference.startLine}`
    : `${reference.startLine}-${reference.endLine}`;
}

function codeMentionTokenLabel(reference: CodeMentionReference) {
  return `${codeMentionDisplayName(reference)}:${codeMentionLineToken(reference)}`;
}

function codeMentionTokenDestination(reference: CodeMentionReference) {
  const fragment =
    reference.startLine === reference.endLine
      ? `L${reference.startLine}`
      : `L${reference.startLine}-L${reference.endLine}`;
  return `${reference.path}#${fragment}`;
}

/** Serialize a code reference as a markdown link the model can follow:
 *  [ChatPage.tsx:100-128](crates/…/ChatPage.tsx#L100-L128) — path and line
 *  range only, never the referenced content itself. */
export function formatCodeMentionToken(reference: CodeMentionReference) {
  const normalized = createCodeMentionReference(reference);
  if (!normalized) return reference.path;
  return `[${escapeMarkdownReferenceLabel(codeMentionTokenLabel(normalized))}](${formatMarkdownReferenceDestination(codeMentionTokenDestination(normalized))})`;
}

export function parseMarkdownCodeMentionReference(
  label: string,
  rawDestination: string,
): CodeMentionReference | null {
  const destination = normalizeMarkdownReferenceDestination(rawDestination);
  const hashIndex = destination.lastIndexOf("#L");
  if (hashIndex <= 0) return null;
  const fragmentMatch = /^L(\d{1,7})(?:-L(\d{1,7}))?$/.exec(destination.slice(hashIndex + 1));
  if (!fragmentMatch) return null;
  const reference = createCodeMentionReference({
    path: destination.slice(0, hashIndex),
    startLine: Number(fragmentMatch[1]),
    endLine: Number(fragmentMatch[2] ?? fragmentMatch[1]),
  });
  if (!reference) return null;
  const normalizedLabel = unescapeMarkdownReferenceLabel(label.trim());
  return normalizedLabel === codeMentionTokenLabel(reference) ? reference : null;
}
