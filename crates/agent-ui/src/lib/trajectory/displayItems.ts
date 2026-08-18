/**
 * 布局 → 最终显示序列。
 *
 * 折叠、搜索过滤都在这里落定，组件只负责把结果画出来。放在纯逻辑层是为了能直接
 * 测折叠语义——「折叠一个 turn 之后还剩哪些行」这种规则埋在组件里就没法验证。
 */

import type { TrajectoryRecord, TrajectoryTurnModel } from "./types";

export type TrajectoryDisplayItem =
  | {
      kind: "turnHeader";
      key: string;
      turn: number | null;
      collapsible: boolean;
      collapsed: boolean;
      hiddenCount: number;
    }
  | { kind: "record"; key: string; record: TrajectoryRecord };

export const TRAJECTORY_DISPLAY_HEIGHTS = {
  turnHeader: 24,
  record: 30,
} as const;

export function trajectoryDisplayItemHeight(item: TrajectoryDisplayItem): number {
  return item.kind === "turnHeader"
    ? TRAJECTORY_DISPLAY_HEIGHTS.turnHeader
    : TRAJECTORY_DISPLAY_HEIGHTS.record;
}

/** 一个 turn 里除首行外还有内容才值得提供折叠。 */
function visibleRecordsOf(turn: TrajectoryTurnModel): TrajectoryRecord[] {
  return turn.groups.flatMap((group) =>
    group.records.filter((record) => record.requestOnly !== true),
  );
}

/**
 * 判断某条记录是否因为其上游 assistant 被折叠而应隐藏。
 *
 * 折叠 Calls 的语义是「收起这一步的工具调用」，所以隐藏范围是紧跟在被折叠
 * assistant 之后、直到下一条 assistant 之前的所有 tool/subtool。
 */
function collapsedCallIndexes(
  records: readonly TrajectoryRecord[],
  collapsedAssistants: ReadonlySet<string>,
): Set<number> {
  const hidden = new Set<number>();
  let activeCollapsedAssistant: string | null = null;
  for (const record of records) {
    if (record.kind === "message") {
      activeCollapsedAssistant = collapsedAssistants.has(record.recordId) ? record.recordId : null;
      continue;
    }
    if (activeCollapsedAssistant === null) continue;
    if (record.kind === "tool" || record.kind === "subtool") hidden.add(record.index);
  }
  return hidden;
}

/**
 * 计算最终显示序列。
 *
 * @param turns - 布局结果。
 * @param options - 折叠状态与搜索命中集合。
 * @returns 扁平显示项；搜索无命中时为空数组。
 */
export function buildTrajectoryDisplayItems(
  turns: readonly TrajectoryTurnModel[],
  options: {
    collapsedTurns: ReadonlySet<number>;
    collapsedAssistants: ReadonlySet<string>;
    searchMatchIndexes: ReadonlySet<number> | null;
  },
): readonly TrajectoryDisplayItem[] {
  const items: TrajectoryDisplayItem[] = [];

  for (const [turnOrder, turn] of turns.entries()) {
    const records = visibleRecordsOf(turn);
    if (records.length === 0) continue;

    // 搜索时折叠一律让位：命中的行必须可见，否则用户搜到了却看不到。
    const searching = options.searchMatchIndexes !== null;
    const matching = searching
      ? records.filter((record) => options.searchMatchIndexes?.has(record.index) === true)
      : records;
    if (matching.length === 0) continue;

    const hiddenByCalls = searching
      ? new Set<number>()
      : collapsedCallIndexes(records, options.collapsedAssistants);
    const turnCollapsed = !searching && turn.turn !== null && options.collapsedTurns.has(turn.turn);

    const kept = matching.filter((record) => !hiddenByCalls.has(record.index));
    const shown = turnCollapsed ? kept.slice(0, 1) : kept;
    const hiddenCount = records.length - shown.length;

    if (turn.turn !== null) {
      items.push({
        kind: "turnHeader",
        key: `turn-${turn.turn}-${turnOrder}`,
        turn: turn.turn,
        collapsible: kept.length > 1,
        collapsed: turnCollapsed,
        hiddenCount: Math.max(0, hiddenCount),
      });
    }

    for (const record of shown) {
      items.push({ kind: "record", key: record.recordId, record });
    }
  }

  return items;
}

/** 可折叠的 turn 号集合，供「全部折叠」按钮判定状态。 */
export function collapsibleTrajectoryTurns(
  turns: readonly TrajectoryTurnModel[],
): readonly number[] {
  return turns.flatMap((turn) =>
    turn.turn !== null && visibleRecordsOf(turn).length > 1 ? [turn.turn] : [],
  );
}

/** 名下带工具调用、因而可折叠的 assistant 记录身份。 */
export function collapsibleTrajectoryAssistants(
  turns: readonly TrajectoryTurnModel[],
): readonly string[] {
  const ids: string[] = [];
  for (const turn of turns) {
    const records = visibleRecordsOf(turn);
    for (const [index, record] of records.entries()) {
      if (record.kind !== "message") continue;
      const next = records[index + 1];
      if (next?.kind === "tool" || next?.kind === "subtool") ids.push(record.recordId);
    }
  }
  return ids;
}
