/**
 * 账本的增量全文索引。
 *
 * 会话级常驻：只有某条记录的源字段真正变化时才重建它的索引项，流式期间反复重算
 * 整个会话会把主线程拖垮。
 */

import { flattenTrajectoryRecords } from "./layout";
import type { TrajectoryRecord, TrajectoryTurnModel } from "./types";

type SearchEntry = {
  readonly sources: readonly string[];
  readonly text: string;
};

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordSources(
  turn: number | null,
  group: string,
  record: TrajectoryRecord,
): readonly string[] {
  const blocks = [...(record.sourceBlocks ?? []), ...(record.outputBlocks ?? [])];
  return [
    turn === null ? "between turns" : `turn ${turn}`,
    group,
    record.kind,
    record.kind === "message" ? "assistant" : "",
    record.text,
    record.result ?? "",
    record.inputDetail ?? "",
    record.outputDetail ?? "",
    record.schemaDetail ?? "",
    record.callId ?? "",
    record.toolName ?? "",
    record.provider ?? "",
    record.model ?? "",
    record.stopReason ?? "",
    record.error ?? "",
    ...blocks.flatMap((block) => [
      block.type,
      block.content,
      block.callId ?? "",
      block.toolName ?? "",
      block.imageAlt ?? "",
    ]),
  ];
}

/** 视图级索引实例；随会话视图创建与销毁。 */
export class TrajectorySearchIndex {
  private readonly entries = new Map<string, SearchEntry>();
  private source: readonly (readonly TrajectoryTurnModel[])[] | undefined;

  /**
   * 同步一批布局切片（已完成布局 + 流式布局）。
   *
   * @param layouts - 同一视图的布局切片。
   * @returns 索引版本是否变化。
   */
  update(layouts: readonly (readonly TrajectoryTurnModel[])[]): boolean {
    if (this.source === layouts) return false;
    this.source = layouts;
    const seen = new Set<string>();
    for (const turns of layouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const record of group.records) {
            if (record.requestOnly === true) continue;
            const sources = recordSources(turn.turn, group.title, record);
            const previous = this.entries.get(record.recordId);
            const entry =
              previous !== undefined && sameSources(previous.sources, sources)
                ? previous
                : { sources, text: sources.join("\n").toLocaleLowerCase() };
            this.entries.set(record.recordId, entry);
            seen.add(record.recordId);
          }
        }
      }
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.entries.delete(id);
    }
    return true;
  }

  /**
   * 对最新索引版本匹配查询。
   *
   * @param query - 空格分隔的大小写不敏感词，全部命中才算匹配。
   * @returns 命中的记录身份；空查询返回 null 表示「不过滤」。
   */
  search(query: string): ReadonlySet<string> | null {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    const matches = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (terms.every((term) => entry.text.includes(term))) matches.add(id);
    }
    return matches;
  }
}

/**
 * 把命中的记录身份换算成记录下标，供时间轴高亮与账本过滤共用。
 *
 * @param layouts - 与索引同源的布局切片。
 * @param matched - `search` 的返回值。
 * @returns 命中下标集合；`matched` 为 null 时同样返回 null。
 */
export function trajectorySearchMatchIndexes(
  layouts: readonly (readonly TrajectoryTurnModel[])[],
  matched: ReadonlySet<string> | null,
): ReadonlySet<number> | null {
  if (matched === null) return null;
  const indexes = new Set<number>();
  for (const turns of layouts) {
    for (const record of flattenTrajectoryRecords(turns)) {
      if (matched.has(record.recordId)) indexes.add(record.index);
    }
  }
  return indexes;
}
