// K-brain 的行式 diff（permission.requested.preview.diff、edit/write 结果里的 diff 块）：
// 每行 "<行号> <标记> <正文>"，标记是 ' '、'-'、'+'；不带行号时是 "<标记> <正文>"；
// 超出行数上限时末尾一行是 "… +N more lines" 之类的说明。这里只解析，不重新计算 diff。

export type DiffTextRow =
  | { type: "ctx" | "add" | "del"; lineNumber: number | null; text: string }
  | { type: "note"; lineNumber: null; text: string };

const NUMBERED_ROW = /^(\d+) ([ +-]) (.*)$/;
const BARE_ROW = /^([ +-]) (.*)$/;

function rowType(mark: string): "ctx" | "add" | "del" {
  return mark === "+" ? "add" : mark === "-" ? "del" : "ctx";
}

export function parseDiffRowsText(diff: string): DiffTextRow[] {
  if (!diff) return [];
  const rows: DiffTextRow[] = [];
  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    const numbered = NUMBERED_ROW.exec(raw);
    if (numbered) {
      rows.push({
        type: rowType(numbered[2]),
        lineNumber: Number.parseInt(numbered[1], 10),
        text: numbered[3],
      });
      continue;
    }
    // 空行的行尾空格被吃掉时只剩 "1 +"、"1"。
    const emptyNumbered = /^(\d+)(?: ([+-]))? ?$/.exec(raw);
    if (emptyNumbered) {
      rows.push({
        type: rowType(emptyNumbered[2] ?? " "),
        lineNumber: Number.parseInt(emptyNumbered[1], 10),
        text: "",
      });
      continue;
    }
    const bare = BARE_ROW.exec(raw);
    if (bare) {
      rows.push({ type: rowType(bare[1]), lineNumber: null, text: bare[2] });
      continue;
    }
    if (raw.trim()) rows.push({ type: "note", lineNumber: null, text: raw.trim() });
  }
  return rows;
}
