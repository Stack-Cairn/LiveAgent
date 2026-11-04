import {
  stripMarkdownForFind,
  type TranscriptFindEntry,
} from "@liveagent/ui/lib/transcript-find/transcriptFind";
import type { AssistantUnitRow, TranscriptRow } from "./rowModel";

function unitText(unit: AssistantUnitRow["unit"]): string {
  // Message text only: thinking, tool cards and the work trace render
  // collapsed and would produce matches nobody can see.
  if (unit.kind !== "block" || unit.block.kind !== "text") return "";
  return stripMarkdownForFind(unit.block.text);
}

/** Searchable text per virtual row, keyed like the rendered `data-row-key`. */
export function buildTranscriptFindEntries(rows: readonly TranscriptRow[]): TranscriptFindEntry[] {
  const entries: TranscriptFindEntry[] = [];
  for (const row of rows) {
    let text = "";
    if (row.kind === "user") {
      text = row.item.text;
    } else if (row.kind === "assistant-unit") {
      text = unitText(row.unit);
    } else if (row.kind === "assistant-activity") {
      text = row.units
        .map((unit) => unitText(unit.unit))
        .filter(Boolean)
        .join("\n\n");
    }
    if (text) entries.push({ rowKey: row.key, text });
  }
  return entries;
}
