import {
  type AssistantTurnLayoutEntry,
  type GroupedRoundBlock,
  resolveAssistantTurnLayout,
} from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import {
  assembleContinuousReply,
  type CompactionSeamRound,
  type ReplyStitchClass,
  rekeyContinuationRounds,
  stitchCompactedReplies,
} from "@liveagent/ui/lib/chat/replyContinuity";
import {
  CHECKPOINT_ROW_ESTIMATE_PX,
  estimateAssistantRowHeight,
  estimateUserRowHeight,
  measureEstimateText,
} from "@liveagent/ui/lib/transcript-virtual/rowEstimates";
import type {
  RenderAssistantGroup,
  RenderSummaryCard,
  RenderTimelineItem,
  RenderUserMessage,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptState } from "../../../lib/chat/conversation/liveTranscriptStore";
import { getRoundText, type LiveRound, type UiRound } from "../../../lib/chat/messages/uiMessages";

const TRANSCRIPT_ROW_GAP_PX = 24;
const ASSISTANT_UNIT_GAP_PX = 8;

type ReplyRound = UiRound | LiveRound | CompactionSeamRound;

function classifyTimelineItem(item: RenderTimelineItem): ReplyStitchClass {
  if (item.kind === "user") return "user";
  if (item.kind === "summary") return "checkpoint";
  return "assistant";
}

/**
 * Stitch `assistant → summary → assistant` chains (a compaction that landed
 * mid-reply) into one continuous reply. History rounds are per-group
 * ordinals, so continuation parts are re-keyed positionally; the live turn
 * uses the same re-keying (see buildLiveReplyRounds) so its persisted twin
 * lands on identical unit keys at settle.
 */
function assembleHistoryReply(items: readonly RenderTimelineItem[]) {
  return assembleContinuousReply<RenderTimelineItem, UiRound>(items, {
    classify: classifyTimelineItem,
    roundsOf: (item) => (item.kind === "assistant" ? item.rounds : []),
    seamOf: (item) => item as RenderSummaryCard,
    rekeyParts: true,
  });
}

/**
 * The committed prefix of the reply that is still streaming. A compaction
 * that fires mid-run commits the first half of the reply plus its checkpoint
 * into history (`assistant → summary`) and restarts the live transcript for
 * the continuation. Those trailing items belong to the live reply: they are
 * absorbed into the live activity row so one avatar / one work trace / one
 * footer covers the whole reply, and the checkpoint renders as a seam inside
 * it instead of a card between two half-replies.
 *
 * Returns the index of the first absorbed item, or -1 when nothing should be
 * absorbed: the trailing chain must end with a checkpoint (a trailing
 * assistant item is the persisted twin of a settled reply — see
 * adoptSettledTwin) and must either contain an assistant part or precede a
 * live continuation that already has content (an idle manual compaction
 * produces a checkpoint with neither, and that one is an exchange divider).
 */
function findLiveReplyLeader(
  historyItems: readonly RenderTimelineItem[],
  historyLenAtStart: number,
  liveHasContent: boolean,
): number {
  const last = historyItems[historyItems.length - 1];
  if (!last || last.kind !== "summary" || historyItems.length - 1 < historyLenAtStart) return -1;
  let leader = -1;
  let firstAssistant = -1;
  for (let index = historyItems.length - 1; index >= historyLenAtStart; index -= 1) {
    const item = historyItems[index];
    if (!item || item.kind === "user") break;
    leader = index;
    if (item.kind === "assistant") firstAssistant = index;
  }
  if (firstAssistant !== -1) return firstAssistant;
  return liveHasContent ? leader : -1;
}

/**
 * Rounds of the live reply: the absorbed committed prefix (re-keyed exactly
 * as the persisted twin will be) followed by the streaming continuation,
 * re-keyed as the next part so settle lands on identical unit keys.
 */
function buildLiveReplyRounds(
  absorbed: readonly RenderTimelineItem[],
  tailRounds: readonly (UiRound | LiveRound)[],
): ReplyRound[] {
  if (absorbed.length === 0) return tailRounds as ReplyRound[];
  const prefix = assembleHistoryReply(absorbed);
  return [...prefix.rounds, ...rekeyContinuationRounds(tailRounds, prefix.partCount)];
}

export type SummaryRow = {
  kind: "summary";
  key: string;
  estimate: number;
  renderCost: number;
  gapAfter: number;
  anchorUserKey: string | null;
  item: RenderSummaryCard;
};

export type UserRow = {
  kind: "user";
  key: string;
  estimate: number;
  renderCost: number;
  gapAfter: number;
  anchorUserKey: string;
  item: RenderUserMessage;
};

export type AssistantBlockRenderUnit = {
  kind: "block";
  block: GroupedRoundBlock;
  roundMeta?: UiRound["meta"];
  runningToolCallIds: string[];
  thinkingOpen: boolean;
  isLatestThinking: boolean;
  isRoundTail: boolean;
  hasRunningToolCall: boolean;
};

export type AssistantPlaceholderRenderUnit = {
  kind: "placeholder";
  showFallbackStatus: boolean;
};

export type AssistantWorkTraceRenderUnit = {
  kind: "work-trace";
  durationMs?: number;
  entries: AssistantTurnLayoutEntry[];
  latestToolGroupKey: string | null;
  /** 回合已有总结文案（answer 层非空）：落定后工作区块可自动折叠成一行。 */
  hasAnswer: boolean;
};

export type AssistantFooterRenderUnit = {
  kind: "footer";
  timestamp?: number;
  replyText: string;
  retryTarget: RenderUserMessage | null;
  rounds: ReplyRound[];
  hasChangedFilesCandidate: boolean;
};

export type AssistantRenderUnit =
  | AssistantBlockRenderUnit
  | AssistantWorkTraceRenderUnit
  | AssistantPlaceholderRenderUnit
  | AssistantFooterRenderUnit;

export type AssistantUnitRow = {
  kind: "assistant-unit";
  key: string;
  replyKey: string;
  estimate: number;
  renderCost: number;
  gapAfter: number;
  anchorUserKey: string | null;
  live: boolean;
  mutable: boolean;
  renderMode: "streaming" | "static";
  compacted: boolean;
  showAvatar: boolean;
  unit: AssistantRenderUnit;
};

export type AssistantActivityRow = {
  kind: "assistant-activity";
  key: string;
  replyKey: string;
  estimate: number;
  renderCost: number;
  gapAfter: number;
  anchorUserKey: string | null;
  live: boolean;
  units: AssistantUnitRow[];
};

export type TranscriptRow = SummaryRow | UserRow | AssistantUnitRow | AssistantActivityRow;

export type TranscriptRowsSnapshot = {
  rows: TranscriptRow[];
  // Exactly one stable activity row is force-mounted for the active reply.
  // Its completed and mutable child units reconcile inside that outer row.
  liveStartIndex: number;
};

export type LiveTailInput = LiveTranscriptState & {
  isSending: boolean;
  // 手动压缩空闲态：live store 只置 running、不置 isSending，但仍要显示「正在
  // 压缩」状态行。该标记只并入 live tail 可见性 gate，不改变其他 isSending 语义。
  isCompactionRunning?: boolean;
};

function buildReplyText(rounds: readonly ReplyRound[]): string {
  const finalAnswer = resolveAssistantTurnLayout(rounds, { live: false })
    .answer.flatMap((entry) => (entry.block.kind === "text" ? [entry.block.text.trim()] : []))
    .filter((text) => text.length > 0)
    .join("\n\n");
  if (finalAnswer) return finalAnswer;
  return rounds
    .map((round) => getRoundText(round).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function hasRunningToolCall(blocks: GroupedRoundBlock[], runningToolCallIds: string[]) {
  if (runningToolCallIds.length === 0) return false;
  const runningIds = new Set(runningToolCallIds);
  return blocks.some((block) => {
    if (block.kind === "tool") {
      return Boolean(block.item.toolCall.id && runningIds.has(block.item.toolCall.id));
    }
    if (block.kind === "toolGroup") {
      return block.items.some((item) =>
        Boolean(item.toolCall.id && runningIds.has(item.toolCall.id)),
      );
    }
    return false;
  });
}

function hasChangedFilesCandidate(rounds: readonly ReplyRound[]) {
  return rounds.some((round) =>
    round.blocks.some(
      (block) =>
        block.kind === "tool" &&
        (block.item.toolCall.name === "Write" ||
          block.item.toolCall.name === "Edit" ||
          block.item.toolCall.name === "Delete") &&
        Boolean(block.item.toolResult && !block.item.toolResult.isError),
    ),
  );
}

function measureBlockUnit(block: GroupedRoundBlock) {
  let estimate: number;
  let renderCost: number;
  if (block.kind === "text") {
    const measured = measureEstimateText(block.text);
    estimate =
      estimateAssistantRowHeight({
        proseChars: measured.proseChars,
        codeLines: measured.codeLines,
        codeFences: measured.codeFences,
        toolCount: 0,
        thinkingCount: 0,
      }) - 48;
    renderCost = Math.min(
      16,
      Math.max(
        1,
        1 +
          Math.ceil(measured.proseChars / 6_000) +
          Math.ceil(measured.codeLines / 120) +
          measured.codeFences,
      ),
    );
  } else if (block.kind === "thinking") {
    estimate = 42;
    renderCost = 1;
  } else if (block.kind === "toolGroup") {
    estimate = 64 + Math.min(48, block.items.length * 4);
    renderCost = Math.min(6, 1 + Math.ceil(block.items.length / 4));
  } else if (block.kind === "hostedSearch" || block.kind === "hostedSearchGroup") {
    estimate = 96;
    renderCost =
      block.kind === "hostedSearchGroup" ? Math.min(6, 1 + Math.ceil(block.items.length / 3)) : 2;
  } else if (block.kind === "checkpoint") {
    estimate = 36;
    renderCost = 1;
  } else {
    estimate = 72;
    renderCost = 2;
  }
  return {
    estimate: Math.max(36, estimate),
    renderCost,
  };
}

function sameStringArray(previous: string[], next: string[]) {
  return (
    previous === next ||
    (previous.length === next.length && previous.every((value, index) => value === next[index]))
  );
}

function sameGroupedBlock(previous: GroupedRoundBlock, next: GroupedRoundBlock) {
  if (previous.kind !== next.kind || previous.key !== next.key) return false;
  if (previous.kind === "text" || previous.kind === "thinking") {
    return next.kind === previous.kind && previous.text === next.text;
  }
  if (previous.kind === "tool") {
    return next.kind === "tool" && previous.item === next.item;
  }
  if (previous.kind === "hostedSearch") {
    return next.kind === "hostedSearch" && previous.item === next.item;
  }
  if (previous.kind === "checkpoint") {
    return next.kind === "checkpoint" && previous.seam === next.seam;
  }
  if (previous.kind === "toolGroup") {
    return (
      next.kind === "toolGroup" &&
      previous.items.length === next.items.length &&
      previous.items.every((item, index) => item === next.items[index])
    );
  }
  return (
    next.kind === "hostedSearchGroup" &&
    previous.items.length === next.items.length &&
    previous.items.every((item, index) => item === next.items[index])
  );
}

function canReuseLiveUnit(previous: AssistantUnitRow, next: AssistantUnitRow) {
  if (previous.mutable || next.mutable) return false;
  if (
    previous.key !== next.key ||
    previous.replyKey !== next.replyKey ||
    previous.estimate !== next.estimate ||
    previous.renderCost !== next.renderCost ||
    previous.gapAfter !== next.gapAfter ||
    previous.anchorUserKey !== next.anchorUserKey ||
    previous.live !== next.live ||
    previous.renderMode !== next.renderMode ||
    previous.compacted !== next.compacted ||
    previous.showAvatar !== next.showAvatar ||
    previous.unit.kind !== next.unit.kind
  ) {
    return false;
  }

  if (previous.unit.kind === "work-trace" && next.unit.kind === "work-trace") {
    const nextWorkTrace = next.unit;
    return (
      previous.unit.entries.length === nextWorkTrace.entries.length &&
      previous.unit.durationMs === nextWorkTrace.durationMs &&
      previous.unit.entries.every((entry, index) => {
        const nextEntry = nextWorkTrace.entries[index];
        return Boolean(
          nextEntry &&
            entry.key === nextEntry.key &&
            entry.roundKey === nextEntry.roundKey &&
            entry.roundMeta === nextEntry.roundMeta &&
            entry.thinkingOpen === nextEntry.thinkingOpen &&
            sameStringArray(entry.runningToolCallIds, nextEntry.runningToolCallIds) &&
            sameGroupedBlock(entry.block, nextEntry.block),
        );
      }) &&
      previous.unit.latestToolGroupKey === nextWorkTrace.latestToolGroupKey &&
      previous.unit.hasAnswer === nextWorkTrace.hasAnswer
    );
  }

  if (previous.unit.kind !== "block" || next.unit.kind !== "block") return false;
  return (
    sameGroupedBlock(previous.unit.block, next.unit.block) &&
    previous.unit.roundMeta === next.unit.roundMeta &&
    sameStringArray(previous.unit.runningToolCallIds, next.unit.runningToolCallIds) &&
    previous.unit.thinkingOpen === next.unit.thinkingOpen &&
    previous.unit.isLatestThinking === next.unit.isLatestThinking &&
    previous.unit.isRoundTail === next.unit.isRoundTail &&
    previous.unit.hasRunningToolCall === next.unit.hasRunningToolCall
  );
}

function buildAssistantActivityRow(
  replyKey: string,
  units: AssistantUnitRow[],
): AssistantActivityRow {
  const lastIndex = units.length - 1;
  return {
    kind: "assistant-activity",
    key: `${replyKey}:activity`,
    replyKey,
    estimate: units.reduce(
      (total, unit, index) => total + unit.estimate + (index < lastIndex ? unit.gapAfter : 0),
      0,
    ),
    renderCost: Math.min(
      32,
      Math.max(
        1,
        units.reduce((total, unit) => total + unit.renderCost, 0),
      ),
    ),
    gapAfter: units.at(-1)?.gapAfter ?? TRANSCRIPT_ROW_GAP_PX,
    anchorUserKey: units[0]?.anchorUserKey ?? null,
    live: units.some((unit) => unit.live),
    units,
  };
}

type BuildAssistantUnitsInput = {
  replyKey: string;
  live: boolean;
  renderMode: "streaming" | "static";
  rounds: readonly ReplyRound[];
  timestamp?: number;
  compacted: boolean;
  replyText: string;
  retryTarget: RenderUserMessage | null;
  anchorUserKey: string | null;
  liveUnitCache?: Map<string, AssistantUnitRow>;
};

function buildAssistantUnits(input: BuildAssistantUnitsInput): AssistantUnitRow[] {
  const {
    replyKey,
    live,
    renderMode,
    rounds,
    timestamp,
    compacted,
    replyText,
    retryTarget,
    anchorUserKey,
    liveUnitCache,
  } = input;
  const rows: AssistantUnitRow[] = [];
  const layout = resolveAssistantTurnLayout(rounds, { live });
  const visibleEntries = [...layout.work, ...layout.interaction, ...layout.answer];
  const roundTailKeys = new Map<string, string>();
  for (const entry of visibleEntries) roundTailKeys.set(entry.roundKey, entry.key);

  let latestToolGroupKey: string | null = null;
  for (let index = layout.work.length - 1; index >= 0; index -= 1) {
    const entry = layout.work[index];
    if (entry?.block.kind === "toolGroup") {
      latestToolGroupKey = entry.key;
      break;
    }
  }

  if (layout.work.length > 0 || live) {
    const workMeasurements = layout.work.map((entry) => measureBlockUnit(entry.block));
    rows.push({
      kind: "assistant-unit",
      key: `${replyKey}:work-trace`,
      replyKey,
      estimate: live
        ? Math.min(
            480,
            42 + workMeasurements.reduce((total, measurement) => total + measurement.estimate, 0),
          )
        : 42,
      renderCost: Math.min(
        16,
        Math.max(
          1,
          workMeasurements.reduce((total, measurement) => total + measurement.renderCost, 0),
        ),
      ),
      gapAfter: ASSISTANT_UNIT_GAP_PX,
      anchorUserKey,
      live,
      mutable: false,
      renderMode,
      compacted,
      showAvatar: true,
      unit: {
        kind: "work-trace",
        durationMs:
          !live && timestamp !== undefined && retryTarget?.timestamp !== undefined
            ? Math.max(0, timestamp - retryTarget.timestamp)
            : undefined,
        entries: layout.work,
        latestToolGroupKey,
        hasAnswer: layout.answer.length > 0,
      },
    });
  }

  for (const entry of [...layout.interaction, ...layout.answer]) {
    const measurement = measureBlockUnit(entry.block);
    rows.push({
      kind: "assistant-unit",
      key: `${replyKey}:round:${entry.roundKey}:block:${entry.block.key}`,
      replyKey,
      estimate: measurement.estimate,
      renderCost: measurement.renderCost,
      gapAfter: ASSISTANT_UNIT_GAP_PX,
      anchorUserKey,
      live,
      mutable: false,
      renderMode,
      compacted,
      showAvatar: rows.length === 0,
      unit: {
        kind: "block",
        block: entry.block,
        roundMeta: entry.roundMeta,
        runningToolCallIds: entry.runningToolCallIds,
        thinkingOpen: entry.thinkingOpen,
        isLatestThinking: false,
        isRoundTail: roundTailKeys.get(entry.roundKey) === entry.key,
        hasRunningToolCall: hasRunningToolCall([entry.block], entry.runningToolCallIds),
      },
    });
  }

  if (live) {
    const contentTailIndex = rows.length - 1;
    const contentTail = rows[contentTailIndex];
    if (contentTail) {
      rows[contentTailIndex] = {
        ...contentTail,
        gapAfter: ASSISTANT_UNIT_GAP_PX,
        mutable: true,
      };
    }
  } else {
    const changedFilesCandidate = hasChangedFilesCandidate(rounds);
    const contentTailIndex = rows.length - 1;
    const contentTail = rows[contentTailIndex];
    if (contentTail) {
      rows[contentTailIndex] = {
        ...contentTail,
        gapAfter: changedFilesCandidate ? ASSISTANT_UNIT_GAP_PX : 0,
      };
    }
    rows.push({
      kind: "assistant-unit",
      key: `${replyKey}:footer`,
      replyKey,
      estimate: changedFilesCandidate ? 272 : 32,
      renderCost: changedFilesCandidate ? 2 : 1,
      gapAfter: TRANSCRIPT_ROW_GAP_PX,
      anchorUserKey,
      live: false,
      mutable: false,
      renderMode,
      compacted,
      showAvatar: rows.length === 0 && rounds.length > 0,
      unit: {
        kind: "footer",
        timestamp,
        replyText,
        retryTarget,
        rounds: rounds as ReplyRound[],
        hasChangedFilesCandidate: changedFilesCandidate,
      },
    });
  }

  if (!liveUnitCache) return rows;

  const nextKeys = new Set<string>();
  const reconciled = rows.map((row) => {
    nextKeys.add(row.key);
    const previous = liveUnitCache.get(row.key);
    const next = previous && canReuseLiveUnit(previous, row) ? previous : row;
    liveUnitCache.set(row.key, next);
    return next;
  });
  for (const key of liveUnitCache.keys()) {
    if (!nextKeys.has(key)) liveUnitCache.delete(key);
  }
  return reconciled;
}

export type TranscriptRowModelOptions = {
  onRowsBorn?: (keys: readonly string[], isInitialBuild: boolean) => void;
};

export type TranscriptRowModel = {
  build: (historyItems: RenderTimelineItem[], live: LiveTailInput) => TranscriptRowsSnapshot;
  reset: () => void;
};

export function createTranscriptRowModel(options?: TranscriptRowModelOptions): TranscriptRowModel {
  // Keyed by the FIRST item of a render group: a plain user/summary item, or
  // the leading assistant part of a (possibly stitched) reply. `members`
  // records every item the cached rows were built from so a group that grows
  // (a checkpoint + continuation appended to the trailing reply) rebuilds.
  let rowCache = new WeakMap<
    RenderTimelineItem,
    {
      anchorUserKey: string | null;
      retryTarget: RenderUserMessage | null;
      members: readonly RenderTimelineItem[];
      rows: TranscriptRow[];
    }
  >();
  let historyRowsCache: { items: RenderTimelineItem[]; rows: TranscriptRow[] } | null = null;
  let streamOrigins = new Map<string, string>();
  let knownKeys = new Set<string>();
  let hasBuilt = false;
  let turnSeq = 0;
  let activeTurn: {
    replyKey: string;
    historyLenAtStart: number;
    liveUnitCache: Map<string, AssistantUnitRow>;
    lastLiveUnits: AssistantUnitRow[];
    settlingUnits: AssistantUnitRow[] | null;
  } | null = null;
  let pendingSettle: { replyKey: string; historyLenAtStart: number } | null = null;
  let deferredSettles: { replyKey: string; historyLenAtStart: number }[] = [];
  let draftRoundCache: { text: string; round: LiveRound } | null = null;

  const reset = () => {
    rowCache = new WeakMap();
    historyRowsCache = null;
    streamOrigins = new Map();
    knownKeys = new Set();
    hasBuilt = false;
    turnSeq = 0;
    activeTurn = null;
    pendingSettle = null;
    deferredSettles = [];
    draftRoundCache = null;
  };

  const draftRound = (text: string): LiveRound => {
    if (draftRoundCache?.text !== text) {
      draftRoundCache = {
        text,
        round: {
          round: 1,
          key: "r1",
          blocks: [{ kind: "text", id: "text-1", text }],
          runningToolCallIds: [],
          thinkingOpen: false,
        },
      };
    }
    return draftRoundCache.round;
  };

  // The persisted twin of a live turn is the whole reply it streamed. When
  // that reply compacted mid-way it is persisted as several items
  // (assistant → summary → assistant …); the origin alias attaches to the
  // LEADING assistant part, because that item keys the stitched group. Walk
  // back from the newest assistant item over assistant/summary items only —
  // a user item ends the reply.
  const findReplyLeader = (
    historyItems: RenderTimelineItem[],
    index: number,
    lowerBound: number,
  ) => {
    let leader = index;
    for (let cursor = index - 1; cursor >= lowerBound; cursor -= 1) {
      const item = historyItems[cursor];
      if (!item || item.kind === "user") break;
      if (item.kind === "assistant") leader = cursor;
    }
    return leader;
  };

  const adoptSettledTwin = (
    historyItems: RenderTimelineItem[],
    turn: { replyKey: string; historyLenAtStart: number },
  ) => {
    for (let index = historyItems.length - 1; index >= turn.historyLenAtStart; index -= 1) {
      const item = historyItems[index];
      if (item?.kind !== "assistant") continue;
      const leader = historyItems[findReplyLeader(historyItems, index, turn.historyLenAtStart)];
      if (!leader || leader.kind !== "assistant") return false;
      if (streamOrigins.has(leader.key)) return false;
      streamOrigins.set(leader.key, turn.replyKey);
      if (rowCache.has(leader)) {
        rowCache.delete(leader);
        historyRowsCache = null;
      }
      return true;
    }
    return false;
  };

  const sameMembers = (
    previous: readonly RenderTimelineItem[],
    next: readonly RenderTimelineItem[],
  ) => previous.length === next.length && previous.every((item, index) => item === next[index]);

  const buildHistoryRows = (
    members: readonly RenderTimelineItem[],
    retryTarget: RenderUserMessage | null,
  ): TranscriptRow[] => {
    const leader = members[0];
    if (!leader) return [];
    const anchorUserKey = leader.kind === "user" ? leader.key : (retryTarget?.key ?? null);
    const cached = rowCache.get(leader);
    if (
      cached &&
      cached.anchorUserKey === anchorUserKey &&
      cached.retryTarget === retryTarget &&
      sameMembers(cached.members, members)
    ) {
      return cached.rows;
    }

    let rows: TranscriptRow[];
    if (leader.kind === "summary") {
      rows = [
        {
          kind: "summary",
          key: leader.key,
          estimate: CHECKPOINT_ROW_ESTIMATE_PX,
          renderCost: 1,
          gapAfter: TRANSCRIPT_ROW_GAP_PX,
          anchorUserKey,
          item: leader,
        },
      ];
    } else if (leader.kind === "user") {
      rows = [
        {
          kind: "user",
          key: leader.key,
          estimate: estimateUserRowHeight(leader.text.length, leader.attachments.length),
          renderCost: Math.min(4, 1 + leader.attachments.length),
          gapAfter: TRANSCRIPT_ROW_GAP_PX,
          anchorUserKey: leader.key,
          item: leader,
        },
      ];
    } else {
      const originKey = streamOrigins.get(leader.key);
      const reply = assembleHistoryReply(members);
      const lastPart = members.reduce<RenderAssistantGroup | null>(
        (last, item) => (item.kind === "assistant" ? item : last),
        null,
      );
      const assistantUnits = buildAssistantUnits({
        replyKey: originKey ?? leader.key,
        live: false,
        renderMode: originKey ? "streaming" : "static",
        rounds: reply.rounds,
        timestamp: lastPart?.timestamp ?? leader.timestamp,
        compacted: members.every((item) => item.kind === "summary" || item.isFromCompactedSegment),
        replyText: buildReplyText(reply.rounds),
        retryTarget,
        anchorUserKey,
      });
      rows = originKey ? [buildAssistantActivityRow(originKey, assistantUnits)] : assistantUnits;
    }
    rowCache.set(leader, { anchorUserKey, retryTarget, members, rows });
    return rows;
  };

  // History rows for items[0, end): the same grouped/cached path as the full
  // build, so the prefix shares row identities with the complete history.
  const buildHistoryRowsUntil = (historyItems: RenderTimelineItem[], end: number) => {
    const prefixItems = historyItems.slice(0, end);
    const rows: TranscriptRow[] = [];
    let retryTarget: RenderUserMessage | null = null;
    for (const group of stitchCompactedReplies(prefixItems, classifyTimelineItem)) {
      const members = group.kind === "reply" ? group.items : [group.item];
      rows.push(...buildHistoryRows(members, retryTarget));
      if (group.kind === "single" && group.item.kind === "user") retryTarget = group.item;
    }
    return rows;
  };

  const build = (
    historyItems: RenderTimelineItem[],
    live: LiveTailInput,
  ): TranscriptRowsSnapshot => {
    const liveTailVisible =
      (live.isSending || live.isCompactionRunning === true) && !live.isSettled;
    const isInitialBuild = !hasBuilt;
    hasBuilt = true;

    if (liveTailVisible && pendingSettle && activeTurn) {
      if (!adoptSettledTwin(historyItems, pendingSettle)) {
        deferredSettles.push(pendingSettle);
      }
      pendingSettle = null;
      activeTurn = {
        replyKey: `live-turn-${++turnSeq}`,
        historyLenAtStart: historyItems.length,
        liveUnitCache: new Map(),
        lastLiveUnits: [],
        settlingUnits: null,
      };
    } else if (liveTailVisible && !activeTurn) {
      pendingSettle = null;
      activeTurn = {
        replyKey: `live-turn-${++turnSeq}`,
        historyLenAtStart: historyItems.length,
        liveUnitCache: new Map(),
        lastLiveUnits: [],
        settlingUnits: null,
      };
    } else if (!liveTailVisible && activeTurn) {
      // 落定交接：丢弃 activeTurn 的判据是「历史自 historyLenAtStart 起有没有
      // 新增的、尚未被认领的 assistant 孪生项」——adoptSettledTwin 的返回值正是
      // 这个判据（认领成功 ⇔ 窗口内有可领养孪生项）。不能改用「live 单元里有没有
      // 可见 block」：存在零可见 block 却有真实孪生行的 turn——被取消的 run 会
      // 持久化中止提示 assistant 项；仅输出 Task 工具的 run 其块被
      // isVisibleGroupedBlock 全部过滤。这类 turn 若被误判丢弃，孪生行永不被领养
      // → 以全新 key 重挂载（违反零 remount），persist 滞后时更会漏进下一个 run 的
      // historyLenAtStart 窗口被错位认领。
      const adopted = adoptSettledTwin(historyItems, activeTurn);
      if (adopted) {
        activeTurn = null;
      } else if (
        activeTurn.lastLiveUnits.some(
          (row) =>
            row.unit.kind === "block" ||
            (row.unit.kind === "work-trace" && row.unit.entries.length > 0),
        )
      ) {
        // 产出过内容 ⟹ 真实回复必将持久化：孪生行尚未落库（persist 滞后）时
        // 登记 pendingSettle，待其落库后按同一 replyKey 认领（零 remount）。
        pendingSettle = {
          replyKey: activeTurn.replyKey,
          historyLenAtStart: activeTurn.historyLenAtStart,
        };
      } else {
        // 既没产出内容、历史也没有可领养孪生项（空闲手动压缩落定成检查点卡片、
        // 或产出前即被取消的 run）→ 直接清掉，避免底部留下冻结的 settling 状态行。
        activeTurn = null;
      }
    } else if (!liveTailVisible && pendingSettle) {
      if (adoptSettledTwin(historyItems, pendingSettle)) pendingSettle = null;
    }

    if (deferredSettles.length > 0) {
      deferredSettles = deferredSettles.filter((turn) => !adoptSettledTwin(historyItems, turn));
    }

    const bornKeys: string[] = [];
    const trackBirth = (key: string) => {
      if (!knownKeys.has(key)) {
        knownKeys.add(key);
        bornKeys.push(key);
      }
    };

    let historyRows: TranscriptRow[];
    if (historyRowsCache?.items === historyItems) {
      historyRows = historyRowsCache.rows;
    } else {
      historyRows = [];
      let retryTarget: RenderUserMessage | null = null;
      for (const group of stitchCompactedReplies(historyItems, classifyTimelineItem)) {
        const members = group.kind === "reply" ? group.items : [group.item];
        const itemRows = buildHistoryRows(members, retryTarget);
        historyRows.push(...itemRows);
        for (const row of itemRows) trackBirth(row.key);
        if (group.kind === "single" && group.item.kind === "user") retryTarget = group.item;
      }
      historyRowsCache = { items: historyItems, rows: historyRows };
    }

    let rows = historyRows;
    let liveStartIndex = -1;
    if ((liveTailVisible || pendingSettle) && activeTurn) {
      // 运行中压缩：前半段回复已经作为历史项落库（assistant → summary），后半段
      // 仍在流式。把从本 turn 起点开始的尾部历史项（只允许 assistant/summary，
      // 遇 user 即止）并入 live 回合——前半段的轮次 + 检查点缝合轮 + 实时轮次
      // 组成一条连续回复，只渲染一个头像 / 一个工作区块。这些历史项在本次
      // 构建里不再单独出行；落定后由 adoptSettledTwin 以同一 replyKey 认领整条
      // 缝合回复（首段 assistant 项为 leader），单元 key 逐一对上、零 remount。
      const liveHasContent = live.liveRounds.length > 0 || Boolean(live.draftAssistantText);
      const absorbedLeaderIndex = liveTailVisible
        ? findLiveReplyLeader(historyItems, activeTurn.historyLenAtStart, liveHasContent)
        : -1;
      const absorbed = absorbedLeaderIndex === -1 ? [] : historyItems.slice(absorbedLeaderIndex);
      const visibleHistoryRows =
        absorbed.length > 0
          ? buildHistoryRowsUntil(historyItems, absorbedLeaderIndex)
          : historyRows;

      let liveUnits = activeTurn.lastLiveUnits;
      if (liveTailVisible) {
        const tailRounds: readonly (UiRound | LiveRound)[] =
          live.liveRounds.length > 0
            ? live.liveRounds
            : live.draftAssistantText
              ? [draftRound(live.draftAssistantText)]
              : [];
        const rounds = buildLiveReplyRounds(absorbed, tailRounds);
        liveUnits = buildAssistantUnits({
          replyKey: activeTurn.replyKey,
          live: true,
          renderMode: "streaming",
          rounds,
          compacted: false,
          replyText: "",
          retryTarget: null,
          anchorUserKey: visibleHistoryRows.at(-1)?.anchorUserKey ?? null,
          liveUnitCache: activeTurn.liveUnitCache,
        });
        activeTurn.lastLiveUnits = liveUnits;
        activeTurn.settlingUnits = null;
      } else {
        if (!activeTurn.settlingUnits) {
          activeTurn.settlingUnits = activeTurn.lastLiveUnits.map((row) => ({
            ...row,
            live: false,
            mutable: false,
          }));
        }
        liveUnits = activeTurn.settlingUnits;
      }
      const liveActivity = buildAssistantActivityRow(activeTurn.replyKey, liveUnits);
      rows = [...visibleHistoryRows, liveActivity];
      liveStartIndex = rows.length - 1;
      trackBirth(liveActivity.key);
    }

    if (bornKeys.length > 0 || isInitialBuild) {
      options?.onRowsBorn?.(bornKeys, isInitialBuild);
    }

    return { rows, liveStartIndex };
  };

  return { build, reset };
}
