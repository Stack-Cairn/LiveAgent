// Line-level change stats for the collapsed Write/Edit tool bar. Edit uses the
// same diff engine as the expanded EditDiffView (generateDiffFile), so the
// collapsed +N/-N matches the expanded diff; when a field was truncated by the
// streaming preview protocol (or is too large to diff on every delta), we fall
// back to total line counts from the preview meta.
import { generateDiffFile } from "@git-diff-view/file";
import { fileToolFieldLines, readStreamPreviewMeta } from "./toolPreview";

export type FileChangeStats = {
  added?: number;
  removed?: number;
};

// Combined old+new char budget for the real line diff. The diff reruns on
// every streaming delta of a local round (full raw strings, no producer
// truncation), so bound the worst case; above the cap we show total line
// counts instead.
const MAX_DIFF_CHARS = 200_000;

function diffLineCounts(oldText: string, newText: string): FileChangeStats | undefined {
  if (!oldText && !newText) return { added: 0, removed: 0 };
  try {
    const file = generateDiffFile("old", oldText, "new", newText, "txt", "txt");
    file.initRaw();
    return { added: file.additionLength, removed: file.deletionLength };
  } catch {
    return undefined;
  }
}

export function deriveFileChangeStats(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}): FileChangeStats | undefined {
  const name = toolCall.name;
  if (name !== "Write" && name !== "Edit") return undefined;
  const args = toolCall.arguments ?? {};

  if (name === "Write") {
    // Write rewrites the whole file: added = total content lines, no removed.
    const added = fileToolFieldLines(args, "content");
    return added === undefined ? undefined : { added };
  }

  const addedTotal = fileToolFieldLines(args, "new_string");
  const removedTotal = fileToolFieldLines(args, "old_string");
  if (addedTotal === undefined && removedTotal === undefined) return undefined;

  const meta = readStreamPreviewMeta(args);
  const oldRaw = typeof args.old_string === "string" ? args.old_string : undefined;
  const newRaw = typeof args.new_string === "string" ? args.new_string : undefined;
  const truncated =
    meta?.fields.old_string?.truncated === true || meta?.fields.new_string?.truncated === true;

  if (
    oldRaw !== undefined &&
    newRaw !== undefined &&
    !truncated &&
    oldRaw.length + newRaw.length <= MAX_DIFF_CHARS
  ) {
    const counts = diffLineCounts(oldRaw, newRaw);
    if (counts) return counts;
  }
  // Fallback: total lines per side (truncated stream / oversized / mid-stream
  // with only one field present — the present side still ticks live).
  return { added: addedTotal, removed: removedTotal };
}
