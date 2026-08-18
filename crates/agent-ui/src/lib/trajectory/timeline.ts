/**
 * 时间轴投影：把账本记录压到三条泳道上。
 *
 * 两种域：`sequence` 每条记录等宽按序排列，回答「走了多少步、什么形状」；
 * `duration` 按真实耗时排宽度并压缩空闲间隙，回答「时间花在哪」。
 *
 * 降级账本（从 messages 推导，无时间）必须锁在 `sequence`：`duration` 会因为所有
 * 记录 startedAt 为 null 而退化成空模型。
 */

import type {
  TrajectoryRecord,
  TrajectoryRecordKind,
  TrajectoryStatus,
  TrajectoryTurnModel,
} from "./types";

/** 水平投影模式。 */
export type TrajectoryTimelineMode = "sequence" | "duration";

/** 当前投影域内的闭区间选择。 */
export type TrajectoryTimeRange = {
  start: number;
  end: number;
};

/** 一条记录在当前投影域内的位置。 */
export type TrajectoryTimelineSpan = TrajectoryTimeRange & {
  index: number;
  kind: TrajectoryRecordKind;
  isError: boolean;
  label: string;
  lane: number;
  /** 泳道内错行：并行的记录各占一行（0 起），让并发关系可见。 */
  row: number;
  status: TrajectoryStatus;
};

/** 一个回合段在当前投影域内的位置；回合带用它画整段。 */
export type TrajectoryTimelineTurnBoundary = {
  turn: number;
  time: number;
  /** 回合段右端（投影域，开区间语义与 span.end 一致）。 */
  end: number;
  /**
   * 回合的净活跃毫秒：回合内所有记录原始时间区间并集的覆盖量（并行的
   * 工具重叠只算一次，回合内的空闲间隙不计）。与投影模式无关 —— sequence
   * 的 time/end 是序号，不能拿差值当时间，回合带数字以本字段为准。
   */
  activeMs: number | null;
};

/** duration 模式被压缩掉的空闲间隙：投影位置 + 原始毫秒。 */
export type TrajectoryTimelineIdleGap = {
  at: number;
  ms: number;
};

export type TrajectoryTimelineModel = TrajectoryTimeRange & {
  spans: readonly TrajectoryTimelineSpan[];
  turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
  /** 每条泳道占用的行数（≥1）；工具泳道并行越多行越多。 */
  laneRows: readonly [number, number, number];
  /** 压缩掉的空闲间隙；sequence 恒为空。 */
  idleGaps: readonly TrajectoryTimelineIdleGap[];
};

/** 三条泳道：0 Input、1 Model、2 Tools。 */
export const TRAJECTORY_TIMELINE_LANES = 3;

/** 单条泳道最多错行数；再多的并行容忍少量重叠，避免时间轴被撑高。 */
const MAX_LANE_ROWS = 4;
/** 浮点容差：首尾相接的区间不算重叠。 */
const OVERLAP_EPSILON = 1e-6;

export function trajectoryLaneFor(kind: TrajectoryRecordKind): number {
  if (kind === "tool" || kind === "subtool") return 2;
  if (kind === "message" || kind === "compacted") return 1;
  return 0;
}

function isFinite_(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function visibleRecords(turn: TrajectoryTurnModel): TrajectoryRecord[] {
  return turn.groups.flatMap((group) =>
    group.records.filter((record) => record.requestOnly !== true),
  );
}

function spanOf(record: TrajectoryRecord): TrajectoryTimeRange | null {
  if (!isFinite_(record.startedAt)) return null;
  const durationMs = isFinite_(record.timeSeconds) ? Math.max(0, record.timeSeconds * 1000) : 0;
  return { start: record.startedAt, end: record.startedAt + durationMs };
}

/** 区间并集的覆盖量：并行重叠只算一次；没有任何正时长时返回 null。 */
function unionCoverageMs(ranges: readonly TrajectoryTimeRange[]): number | null {
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  let total = 0;
  let coveredUntil: number | null = null;
  for (const range of ordered) {
    if (coveredUntil !== null && range.end <= coveredUntil) continue;
    // 只累计超出已覆盖部分：与已覆盖区间脱开的空隙不计入。
    const addFrom = coveredUntil === null ? range.start : Math.max(range.start, coveredUntil);
    total += range.end - addFrom;
    coveredUntil = range.end;
  }
  return total > 0 ? total : null;
}

/** 回合净活跃毫秒：回合内可见记录原始区间并集。 */
function turnActiveMs(records: readonly TrajectoryRecord[]): number | null {
  const ranges = records
    .map((record) => spanOf(record))
    .filter((range): range is TrajectoryTimeRange => range !== null);
  return unionCoverageMs(ranges);
}

function toSpan(record: TrajectoryRecord, range: TrajectoryTimeRange): TrajectoryTimelineSpan {
  return {
    ...range,
    index: record.index,
    kind: record.kind,
    isError: record.isError,
    label: record.text,
    lane: trajectoryLaneFor(record.kind),
    row: 0,
    status: record.status,
  };
}

/**
 * 泳道内行打包：按开始时间扫一遍，把首尾相接或更晚的记录放进已占用行，重叠的
 * 开新行。行数上限 {@link MAX_LANE_ROWS}，超出的放到最早结束的行（容忍少量重叠）。
 * 就地写入 span.row，返回每泳道行数。
 */
function packLaneRows(spans: TrajectoryTimelineSpan[]): [number, number, number] {
  const rowEnds: number[][] = [[], [], []];
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  for (const span of ordered) {
    const ends = rowEnds[span.lane];
    let row = ends.findIndex((end) => span.start >= end - OVERLAP_EPSILON);
    if (row === -1 && ends.length < MAX_LANE_ROWS) {
      ends.push(span.end);
      row = ends.length - 1;
    } else if (row === -1) {
      row = ends.indexOf(Math.min(...ends));
      ends[row] = span.end;
    } else {
      ends[row] = Math.max(ends[row], span.end);
    }
    span.row = row;
  }
  return [
    Math.max(1, rowEnds[0].length),
    Math.max(1, rowEnds[1].length),
    Math.max(1, rowEnds[2].length),
  ];
}

function deriveSequenceTimeline(
  turns: readonly TrajectoryTurnModel[],
): TrajectoryTimelineModel | null {
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];

  for (const turn of turns) {
    const records = visibleRecords(turn);
    if (records.length === 0) continue;
    const base = spans.length;
    if (turn.turn !== null)
      turnBoundaries.push({
        turn: turn.turn,
        time: base,
        end: base + records.length,
        activeMs: turnActiveMs(records),
      });
    spans.push(
      ...records.map((record, offset) =>
        toSpan(record, { start: base + offset, end: base + offset + 1 }),
      ),
    );
  }

  if (spans.length === 0) return null;
  // sequence 每条记录独占一个单位区间，同泳道天然不重叠；打包只做形式确认。
  const laneRows = packLaneRows(spans);
  return { start: 0, end: spans.length, spans, turnBoundaries, laneRows, idleGaps: [] };
}

function deriveDurationTimeline(
  turns: readonly TrajectoryTurnModel[],
): TrajectoryTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = visibleRecords(turn).flatMap((record) => {
      const range = spanOf(record);
      return range === null ? [] : [toSpan(record, range)];
    });
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const rawSpans = timedTurns.flatMap((entry) => entry.rawSpans);
  if (rawSpans.length === 0) return null;

  // 空闲压缩：按开始时间扫过所有区间，累计「没有任何操作覆盖」的时长，后续区间
  // 整体左移相应量。人等模型和人等自己的间隙因此不会占满整个图。每个被删掉的
  // 间隙记下投影位置和原始毫秒，视图层用斜纹把它标出来，压缩不再静默。
  const idleGaps: TrajectoryTimelineIdleGap[] = [];
  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...rawSpans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (coveredUntil !== null && span.start > coveredUntil) {
      const ms = span.start - coveredUntil;
      idleGaps.push({ at: coveredUntil - removedIdle, ms });
      removedIdle += ms;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const entry of timedTurns) {
    const projected = entry.rawSpans.map((span): TrajectoryTimelineSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return { ...span, start: span.start - offset, end: span.end - offset };
    });
    spans.push(...projected);
    if (entry.turn !== null) {
      turnBoundaries.push({
        turn: entry.turn,
        time: Math.min(...projected.map((span) => span.start)),
        end: Math.max(...projected.map((span) => span.end)),
        activeMs: unionCoverageMs(entry.rawSpans),
      });
    }
  }

  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
    laneRows: packLaneRows(spans),
    idleGaps,
  };
}

/**
 * 把可见记录投影到三泳道时间轴。
 *
 * @param turns - 未过滤的布局结果。
 * @param mode - 投影模式。
 * @returns 时间轴模型；没有可见记录时为 null。
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = "sequence",
): TrajectoryTimelineModel | null {
  return mode === "duration" ? deriveDurationTimeline(turns) : deriveSequenceTimeline(turns);
}

/**
 * 找出与选区相交的记录下标。
 *
 * @param turns - 未过滤的布局结果。
 * @param range - 当前投影域内的闭区间。
 * @param mode - 投影模式，必须与产生 range 的模式一致。
 * @returns 命中的记录下标集合。
 */
export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = "sequence",
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    model?.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  );
}

/** 毫秒时长标签，带千分位。 */
export function formatTrajectoryDurationMs(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  return `${Math.round(milliseconds).toLocaleString("en-US")} ms`;
}

/** 秒时长标签，内部按毫秒呈现。 */
export function formatTrajectoryElapsedSeconds(seconds: number | null): string {
  return formatTrajectoryDurationMs(seconds === null ? null : seconds * 1000);
}
