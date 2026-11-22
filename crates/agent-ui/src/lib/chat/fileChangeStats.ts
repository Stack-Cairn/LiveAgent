import { structuredPatch } from "diff";
import { fileToolFieldLines, readStreamPreviewMeta } from "./toolPreview";

export type FileChangeStats = {
  added?: number;
  removed?: number;
};

const MAX_DIFF_CHARS = 200_000;

function diffLineCounts(oldText: string, newText: string): FileChangeStats | undefined {
  if (!oldText && !newText) return { added: 0, removed: 0 };
  try {
    // Count the hunk lines of the same patch the diff viewer renders, without
    // pulling the viewer's syntax highlighter into every bundle that shows stats.
    const patch = structuredPatch("old", "new", oldText, newText, "", "");
    let added = 0;
    let removed = 0;
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
    }
    return { added, removed };
  } catch {
    return undefined;
  }
}

export function deriveFileChangeStats(
  toolCall: {
    name: string;
    arguments?: Record<string, unknown>;
  },
  // 流式参数每个 delta 重派生一次；exact diff（Myers，上限 200K 字符）只应在
  // 参数定稿后计算，preferEstimate 让流式期直接走行数估算回退。
  options?: { preferEstimate?: boolean },
): FileChangeStats | undefined {
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
    !options?.preferEstimate &&
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
