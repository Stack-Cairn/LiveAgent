// Line comments attached to a rendered git diff, and their conversion into
// composer draft segments ("file:line — comment" plus the code line) so a
// batch of review notes can be handed to the agent as one context block.

import type { MentionComposerDraftSegment } from "../../components/chat/MentionComposerModel";
import { createCodeMentionReference, formatCodeMentionToken } from "./mentionReferences";

export type DiffLineCommentSide = "old" | "new";
export type DiffLineCommentLineKind = "add" | "delete" | "context";

export type DiffLineComment = {
  /** Stable per (file, side, line): one comment per diff line. */
  id: string;
  /** File identity (old + new path) from diffLineCommentFileKey; independent
   *  of the file's position in the patch so reloads keep the comment. */
  fileKey: string;
  path: string;
  side: DiffLineCommentSide;
  lineNumber: number;
  lineKind: DiffLineCommentLineKind;
  /** The commented code line without the diff marker or trailing newline. */
  code: string;
  comment: string;
};

export type DiffLineCommentInput = Omit<DiffLineComment, "id">;

export const DIFF_LINE_COMMENT_MAX_CODE_CHARS = 2000;

export function diffLineCommentFileKey(oldPath: string, newPath: string): string {
  return `${oldPath}\u0000${newPath}`;
}

export function diffLineCommentId(
  input: Pick<DiffLineComment, "fileKey" | "side" | "lineNumber">,
): string {
  return `${input.fileKey}\u0000${input.side}\u0000${input.lineNumber}`;
}

export function normalizeDiffLineCommentText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
}

function normalizeDiffLineCode(value: string): string {
  const code = value.replace(/\r\n?/g, "\n").replace(/\n+$/u, "").split("\n")[0] ?? "";
  return code.length > DIFF_LINE_COMMENT_MAX_CODE_CHARS
    ? `${code.slice(0, DIFF_LINE_COMMENT_MAX_CODE_CHARS)}…`
    : code;
}

/** Adds a comment, or replaces the existing one on the same line. A blank
 *  comment removes the line's comment instead. */
export function upsertDiffLineComment(
  comments: readonly DiffLineComment[],
  input: DiffLineCommentInput,
): DiffLineComment[] {
  const id = diffLineCommentId(input);
  const comment = normalizeDiffLineCommentText(input.comment);
  if (!comment) return removeDiffLineComment(comments, id);
  const next: DiffLineComment = {
    ...input,
    id,
    comment,
    code: normalizeDiffLineCode(input.code),
    lineNumber: Math.max(1, Math.floor(input.lineNumber)),
  };
  const index = comments.findIndex((entry) => entry.id === id);
  if (index < 0) return [...comments, next];
  const copy = comments.slice();
  copy[index] = next;
  return copy;
}

export function removeDiffLineComment(
  comments: readonly DiffLineComment[],
  id: string,
): DiffLineComment[] {
  const next = comments.filter((entry) => entry.id !== id);
  return next.length === comments.length ? (comments as DiffLineComment[]) : next;
}

/** Drops comments whose file is no longer part of the rendered diff
 *  (another file/commit selected), so no pending comment is ever invisible. */
export function pruneDiffLineComments(
  comments: readonly DiffLineComment[],
  fileKeys: Iterable<string>,
): DiffLineComment[] {
  const keys = new Set(fileKeys);
  const next = comments.filter((entry) => keys.has(entry.fileKey));
  return next.length === comments.length ? (comments as DiffLineComment[]) : next;
}

export function sortDiffLineComments(
  comments: readonly DiffLineComment[],
  fileOrder: readonly string[] = [],
): DiffLineComment[] {
  const order = new Map(fileOrder.map((key, index) => [key, index]));
  return comments.slice().sort((left, right) => {
    const leftFile = order.get(left.fileKey) ?? Number.MAX_SAFE_INTEGER;
    const rightFile = order.get(right.fileKey) ?? Number.MAX_SAFE_INTEGER;
    if (leftFile !== rightFile) return leftFile - rightFile;
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    if (left.lineNumber !== right.lineNumber) return left.lineNumber - right.lineNumber;
    return left.side === right.side ? 0 : left.side === "old" ? -1 : 1;
  });
}

function diffMarker(kind: DiffLineCommentLineKind) {
  if (kind === "add") return "+";
  if (kind === "delete") return "-";
  return " ";
}

function codeFence(code: string) {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Location of the commented line: a code-mention chip when the line exists
 *  in the new file, otherwise plain `path:line (deleted)` text since the old
 *  line number does not resolve against the working tree. */
function diffLineCommentLocationSegment(comment: DiffLineComment): MentionComposerDraftSegment {
  if (comment.side === "new") {
    const reference = createCodeMentionReference({
      path: comment.path,
      startLine: comment.lineNumber,
      endLine: comment.lineNumber,
    });
    if (reference) return { type: "codeMention", reference };
  }
  const suffix = comment.side === "old" ? " (deleted)" : "";
  return { type: "text", text: `${comment.path}:${comment.lineNumber}${suffix}` };
}

export function buildDiffLineCommentSegments(
  comments: readonly DiffLineComment[],
  options: { heading?: string } = {},
): MentionComposerDraftSegment[] {
  if (comments.length === 0) return [];
  const segments: MentionComposerDraftSegment[] = [];
  const pushText = (text: string) => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") {
      last.text += text;
    } else {
      segments.push({ type: "text", text });
    }
  };
  const heading = options.heading?.trim();
  if (heading) pushText(`${heading}\n\n`);
  comments.forEach((comment, index) => {
    if (index > 0) pushText("\n\n");
    segments.push(diffLineCommentLocationSegment(comment));
    const body = normalizeDiffLineCommentText(comment.comment);
    const line = `${diffMarker(comment.lineKind)}${comment.code}`;
    const fence = codeFence(line);
    pushText(` — ${body}\n${fence}diff\n${line}\n${fence}`);
  });
  return segments;
}

/** Plain-text rendering of the segments as the composer serializes them. */
export function formatDiffLineCommentsMarkdown(
  comments: readonly DiffLineComment[],
  options: { heading?: string } = {},
): string {
  return buildDiffLineCommentSegments(comments, options)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      if (segment.type === "codeMention") return formatCodeMentionToken(segment.reference);
      return "";
    })
    .join("");
}

/** Separator placed before a block appended to existing composer text so it
 *  starts on its own paragraph. */
export function composerBlockSeparator(existing: string): string {
  if (!existing || /^\s*$/.test(existing)) return "";
  if (existing.endsWith("\n\n")) return "";
  if (existing.endsWith("\n")) return "\n";
  return "\n\n";
}
