import { generateDiffFile } from "@git-diff-view/file";
import { fileToolFieldLines, readStreamPreviewMeta } from "./toolPreview";

export type FileChangeStats = {
  added?: number;
  removed?: number;
};

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
  return { added: addedTotal, removed: removedTotal };
}
