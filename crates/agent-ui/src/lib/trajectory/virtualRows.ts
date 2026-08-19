/**
 * 记录 → 可测量的虚拟行。
 *
 * 分隔符类记录（`requestOnly`）本身零高度。让虚拟化器持有零高度条目会让滚动定位
 * 失准，因此把它们并进下一条内容行；序列末尾的分隔符单独成行并保留 CSS 约定的下缘
 * 留白。
 */

import type { TrajectoryRecord } from "./types";

const CONTENT_ROW_HEIGHT = 30;
const COLLAPSED_SUMMARY_HEIGHT = 20;
const TERMINAL_BOUNDARY_HEIGHT = 9;

/** 虚拟行投影所需的最小记录形状。 */
export type VirtualizableTrajectoryRecord = {
  record: TrajectoryRecord;
  /** 折叠摘要行的类别；普通内容行为 undefined。 */
  collapsedSummaryKind?: "turn" | "assistant";
};

export type TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> = {
  logicalIndex: number;
  item: T;
};

export type TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> = {
  entries: readonly TrajectoryVirtualRowEntry<T>[];
  height: number;
  key: string;
};

/**
 * React key、虚拟化器与滚动锚点共用的行身份。
 *
 * @param item - 待取身份的显示项。
 * @returns 对 DOM 安全的稳定身份。
 */
export function trajectoryVirtualRowKey(item: VirtualizableTrajectoryRecord): string {
  const identity = encodeURIComponent(item.record.recordId);
  return item.collapsedSummaryKind === undefined
    ? identity
    : `${identity}--summary--${item.collapsedSummaryKind}`;
}

/**
 * 把显示项序列折成可测量的虚拟行。
 *
 * @param items - 搜索与折叠过滤后的最终显示序列。
 * @returns 虚拟行；每行保留其成员的原始逻辑下标。
 */
export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
  items: readonly T[],
): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = [];
  let pending: TrajectoryVirtualRowEntry<T>[] = [];

  for (const [logicalIndex, item] of items.entries()) {
    const entry = { logicalIndex, item };
    if (item.record.requestOnly === true) {
      pending.push(entry);
      continue;
    }
    const entries = [...pending, entry];
    pending = [];
    rows.push({
      entries,
      height:
        item.collapsedSummaryKind === undefined ? CONTENT_ROW_HEIGHT : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRowKey(item),
    });
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map((entry) => trajectoryVirtualRowKey(entry.item)).join("|"),
    });
  }

  return rows;
}

export const TRAJECTORY_ROW_HEIGHTS = {
  content: CONTENT_ROW_HEIGHT,
  collapsedSummary: COLLAPSED_SUMMARY_HEIGHT,
  terminalBoundary: TERMINAL_BOUNDARY_HEIGHT,
} as const;
