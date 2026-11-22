// Pending comments on earlier content: a snippet the user selected in the
// transcript (assistant/user message, code block), a file or diff line range,
// or an annotated image, plus the user's note about it. They wait as chips in
// the composer and are sent with the next message as one Markdown block that
// names each source, quotes the snippet and gives the comment.
//
// The block is model-facing text, so it is English like the attachment
// instruction; the chips that show it in the UI are localized.

import { createUuid } from "@liveagent/ui/lib/shared/id";
import { normalizeQuoteText } from "./transcriptQuote";

export type ComposerCommentSourceKind = "assistant" | "user" | "code" | "diff" | "image";

export type ComposerCommentSource = {
  kind: ComposerCommentSourceKind;
  /** File path (code/diff) or file name (image). */
  path?: string;
  startLine?: number;
  endLine?: number;
  /** Diff side the lines belong to: "old" lines were removed. */
  side?: "old" | "new";
  /** Fence language for code snippets ("diff" for diff hunks). */
  language?: string;
};

export type ComposerComment = {
  id: string;
  /** The commented snippet; empty for comments without a selection (image notes). */
  quote: string;
  /** Render the snippet as a fenced code block instead of a blockquote. */
  code?: boolean;
  comment: string;
  source: ComposerCommentSource;
};

export type ComposerCommentInput = Omit<ComposerComment, "id"> & { id?: string };

/** Upper bound on one comment's text; the snippet is bounded by the quote limit. */
export const COMPOSER_COMMENT_MAX_CHARS = 4000;
/** Upper bound on pending comments in one draft. */
export const COMPOSER_COMMENT_MAX_COUNT = 50;

const SOURCE_KINDS = new Set<ComposerCommentSourceKind>([
  "assistant",
  "user",
  "code",
  "diff",
  "image",
]);

function truncateChars(text: string, max: number) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("").replace(/\s+$/u, "")}…` : text;
}

/** Comment text: unified line endings, trailing spaces dropped, trimmed. */
export function normalizeComposerCommentText(raw: string) {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
  return truncateChars(text, COMPOSER_COMMENT_MAX_CHARS);
}

/** Code snippets keep their indentation; only line endings, trailing
 *  whitespace and surrounding blank lines are normalized. */
export function normalizeComposerCommentCode(raw: string) {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""));
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  return truncateChars(lines.join("\n"), 8000);
}

function normalizeLine(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

function normalizeSource(raw: unknown): ComposerCommentSource | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind as ComposerCommentSourceKind;
  if (!SOURCE_KINDS.has(kind)) return null;
  const source: ComposerCommentSource = { kind };
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (path) source.path = path;
  if ((kind === "code" || kind === "diff" || kind === "image") && !path) return null;
  const startLine = normalizeLine(record.startLine);
  const endLine = normalizeLine(record.endLine);
  if (startLine !== undefined) {
    source.startLine = startLine;
    source.endLine = Math.max(startLine, endLine ?? startLine);
  }
  if (record.side === "old" || record.side === "new") source.side = record.side;
  const language = typeof record.language === "string" ? record.language.trim() : "";
  if (language && /^[\w+#.-]{1,32}$/u.test(language)) source.language = language;
  return source;
}

/** Validates and normalizes a comment (from the UI, a stored draft or the
 *  clipboard). Returns null when it has no comment text or no usable source. */
export function normalizeComposerComment(raw: unknown): ComposerComment | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const source = normalizeSource(record.source);
  if (!source) return null;
  const comment = normalizeComposerCommentText(
    typeof record.comment === "string" ? record.comment : "",
  );
  if (!comment) return null;
  const code = record.code === true || source.kind === "code" || source.kind === "diff";
  const rawQuote = typeof record.quote === "string" ? record.quote : "";
  const quote = code ? normalizeComposerCommentCode(rawQuote) : normalizeQuoteText(rawQuote).trim();
  if (!quote && source.kind !== "image") return null;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : createUuid();
  return { id, quote, ...(code ? { code: true } : {}), comment, source };
}

export function createComposerComment(input: ComposerCommentInput): ComposerComment | null {
  return normalizeComposerComment(input);
}

/** Adds `comment`, or replaces the pending comment with the same id in place. */
export function upsertComposerComment(
  comments: readonly ComposerComment[],
  comment: ComposerComment,
): ComposerComment[] {
  const index = comments.findIndex((entry) => entry.id === comment.id);
  if (index < 0) {
    return comments.length >= COMPOSER_COMMENT_MAX_COUNT
      ? (comments as ComposerComment[])
      : [...comments, comment];
  }
  const next = comments.slice();
  next[index] = comment;
  return next;
}

export function removeComposerComment(
  comments: readonly ComposerComment[],
  id: string,
): ComposerComment[] {
  const next = comments.filter((entry) => entry.id !== id);
  return next.length === comments.length ? (comments as ComposerComment[]) : next;
}

export function composerCommentLineLabel(source: ComposerCommentSource) {
  if (source.startLine === undefined) return "";
  const end = source.endLine ?? source.startLine;
  return end === source.startLine ? `${source.startLine}` : `${source.startLine}-${end}`;
}

/** `path:12-14`, or the bare path without lines. */
export function composerCommentLocation(source: ComposerCommentSource) {
  const lines = composerCommentLineLabel(source);
  return source.path ? (lines ? `${source.path}:${lines}` : source.path) : "";
}

function inlineCode(text: string) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function codeFence(code: string) {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** The "On …:" line naming where the commented snippet comes from. */
export function describeComposerCommentSource(source: ComposerCommentSource) {
  const location = composerCommentLocation(source);
  switch (source.kind) {
    case "assistant":
      return "the assistant's reply";
    case "user":
      return "my earlier message";
    case "image":
      return `the attached image ${inlineCode(source.path ?? "")} (numbered markers)`;
    case "diff": {
      const side =
        source.side === "old" ? ", removed lines" : source.side === "new" ? ", new lines" : "";
      return `the diff of ${inlineCode(location)}${side}`;
    }
    default:
      return inlineCode(location);
  }
}

function formatQuote(comment: ComposerComment) {
  if (!comment.quote) return "";
  if (comment.code) {
    const fence = codeFence(comment.quote);
    return `${fence}${comment.source.language ?? ""}\n${comment.quote}\n${fence}`;
  }
  return comment.quote
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

export const COMPOSER_COMMENTS_HEADING = "Comments on specific content:";

/** One Markdown block for all pending comments, numbered in draft order. */
export function formatComposerCommentsBlock(comments: readonly ComposerComment[]) {
  const valid = comments.filter((comment) => comment.comment.trim());
  if (valid.length === 0) return "";
  const parts = valid.map((comment, index) => {
    const lines = [`${index + 1}. On ${describeComposerCommentSource(comment.source)}:`];
    const quote = formatQuote(comment);
    if (quote) lines.push(quote, "");
    lines.push(
      comment.source.kind === "image" ? comment.comment : `Comment: ${comment.comment.trim()}`,
    );
    return lines.join("\n");
  });
  return `${COMPOSER_COMMENTS_HEADING}\n\n${parts.join("\n\n")}`;
}

/** Appends the comments block to the message text as its own paragraph. */
export function appendComposerCommentsBlock(text: string, comments: readonly ComposerComment[]) {
  const block = formatComposerCommentsBlock(comments);
  if (!block) return text;
  const body = text.replace(/\s+$/u, "");
  return body ? `${body}\n\n${block}` : block;
}

/** One-line preview of a snippet for a chip. */
export function composerCommentPreview(text: string, max = 80) {
  return truncateChars(text.trim().replace(/\s+/gu, " "), max);
}
