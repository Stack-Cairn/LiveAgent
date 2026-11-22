import {
  stripMarkdownForFindOf,
  type TranscriptFindEntry,
} from "@liveagent/ui/lib/transcript-find/transcriptFind";
import type { AssistantUnitRow, TranscriptRow } from "./rowModel";

function unitText(unit: AssistantUnitRow["unit"]): string {
  // Message text only: thinking, tool cards and the work trace render
  // collapsed and would produce matches nobody can see.
  if (unit.kind !== "block" || unit.block.kind !== "text") return "";
  // Blocks come from the immutable per-round layout, so the stripped text is
  // kept on the block: only a block whose text changed is parsed again.
  return stripMarkdownForFindOf(unit.block, unit.block.text);
}

function rowText(row: TranscriptRow): string {
  if (row.kind === "user") return row.item.text;
  if (row.kind === "assistant-unit") return unitText(row.unit);
  if (row.kind === "assistant-activity") {
    return row.units
      .map((unit) => unitText(unit.unit))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

// Rows are immutable and history rows keep their identity while a reply
// streams, so each keeps its entry object (which in turn keeps its folded
// text in the match counter).
const entryByRow = new WeakMap<TranscriptRow, TranscriptFindEntry | null>();

/** Searchable text per virtual row, keyed like the rendered `data-row-key`. */
export function buildTranscriptFindEntries(rows: readonly TranscriptRow[]): TranscriptFindEntry[] {
  const entries: TranscriptFindEntry[] = [];
  for (const row of rows) {
    let entry = entryByRow.get(row);
    if (entry === undefined) {
      const text = rowText(row);
      entry = text ? { rowKey: row.key, text } : null;
      entryByRow.set(row, entry);
    }
    if (entry) entries.push(entry);
  }
  return entries;
}
