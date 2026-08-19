export type TrajectoryDiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

const MAX_LCS_LINES = 500;
const MAX_LCS_CELLS = 160_000;

function coarseDiff(before: readonly string[], after: readonly string[]): TrajectoryDiffLine[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...before.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
    ...before
      .slice(prefix, before.length - suffix)
      .map((text) => ({ kind: "removed" as const, text })),
    ...after.slice(prefix, after.length - suffix).map((text) => ({ kind: "added" as const, text })),
    ...before.slice(before.length - suffix).map((text) => ({ kind: "context" as const, text })),
  ];
}

/** Deterministic line diff with a bounded LCS fallback for very large prompts. */
export function diffTrajectoryText(beforeText: string, afterText: string): TrajectoryDiffLine[] {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  if (
    before.length > MAX_LCS_LINES ||
    after.length > MAX_LCS_LINES ||
    before.length * after.length > MAX_LCS_CELLS
  ) {
    return coarseDiff(before, after);
  }

  const width = after.length + 1;
  const table = new Uint16Array((before.length + 1) * width);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      table[index] =
        before[left] === after[right]
          ? table[(left + 1) * width + right + 1] + 1
          : Math.max(table[(left + 1) * width + right], table[left * width + right + 1]);
    }
  }

  const lines: TrajectoryDiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      lines.push({ kind: "context", text: before[left] });
      left += 1;
      right += 1;
    } else if (table[(left + 1) * width + right] >= table[left * width + right + 1]) {
      lines.push({ kind: "removed", text: before[left] });
      left += 1;
    } else {
      lines.push({ kind: "added", text: after[right] });
      right += 1;
    }
  }
  while (left < before.length) lines.push({ kind: "removed", text: before[left++] });
  while (right < after.length) lines.push({ kind: "added", text: after[right++] });
  return lines;
}
