import {
  type GroupedRoundBlock,
  groupRoundBlocks,
} from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import { isTaskToolBlock } from "@liveagent/ui/lib/chat/taskProgress";
import {
  CHECKPOINT_ROW_ESTIMATE_PX,
  estimateAssistantRowHeight,
  estimateUserRowHeight,
  measureEstimateText,
} from "@liveagent/ui/lib/transcript-virtual/rowEstimates";
import type {
  RenderSummaryCard,
  RenderTimelineItem,
  RenderUserMessage,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptState } from "../../../lib/chat/conversation/liveTranscriptStore";
import { getRoundText, type LiveRound, type UiRound } from "../../../lib/chat/messages/uiMessages";

const TRANSCRIPT_ROW_GAP_PX = 24;
const ASSISTANT_UNIT_GAP_PX = 8;

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
  isRoundHead: boolean;
  isRoundTail: boolean;
  hasRunningToolCall: boolean;
};

export type AssistantPlaceholderRenderUnit = {
  kind: "placeholder";
  showFallbackStatus: boolean;
};

export type AssistantFooterRenderUnit = {
  kind: "footer";
  timestamp?: number;
  replyText: string;
  retryTarget: RenderUserMessage | null;
  rounds: (UiRound | LiveRound)[];
  hasChangedFilesCandidate: boolean;
};

export type AssistantStatusRenderUnit = {
  kind: "status";
};

export type AssistantRenderUnit =
  | AssistantBlockRenderUnit
  | AssistantPlaceholderRenderUnit
  | AssistantStatusRenderUnit
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

function buildReplyText(rounds: (UiRound | LiveRound)[]): string {
  return rounds
    .map((round) => getRoundText(round).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function isVisibleGroupedBlock(block: GroupedRoundBlock) {
  if (block.kind === "text" || block.kind === "thinking") {
    return block.text.trim().length > 0;
  }
  return !isTaskToolBlock(block);
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

function hasChangedFilesCandidate(rounds: (UiRound | LiveRound)[]) {
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

function measureBlockUnit(block: GroupedRoundBlock, hasUsage: boolean) {
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
  } else {
    estimate = 72;
    renderCost = 2;
  }
  return {
    estimate: Math.max(36, estimate) + (hasUsage ? 112 : 0),
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
    previous.unit.kind !== "block" ||
    next.unit.kind !== "block"
  ) {
    return false;
  }
  return (
    sameGroupedBlock(previous.unit.block, next.unit.block) &&
    previous.unit.roundMeta === next.unit.roundMeta &&
    sameStringArray(previous.unit.runningToolCallIds, next.unit.runningToolCallIds) &&
    previous.unit.thinkingOpen === next.unit.thinkingOpen &&
    previous.unit.isLatestThinking === next.unit.isLatestThinking &&
    previous.unit.isRoundHead === next.unit.isRoundHead &&
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
  rounds: (UiRound | LiveRound)[];
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

  rounds.forEach((round) => {
    const groupedBlocks = groupRoundBlocks(round.blocks).filter(isVisibleGroupedBlock);
    const runningToolCallIds = "runningToolCallIds" in round ? round.runningToolCallIds : [];
    const roundHasRunningToolCall = hasRunningToolCall(groupedBlocks, runningToolCallIds);
    let latestThinkingKey: string | null = null;
    for (let blockIndex = groupedBlocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = groupedBlocks[blockIndex];
      if (block?.kind === "thinking") {
        latestThinkingKey = block.key;
        break;
      }
    }

    groupedBlocks.forEach((block, blockIndex) => {
      const isRoundHead = blockIndex === 0;
      const isRoundTail = blockIndex === groupedBlocks.length - 1;
      const measurement = measureBlockUnit(block, Boolean(isRoundTail && round.meta?.usage));
      if (isRoundHead && round.meta?.pluginContext) {
        measurement.estimate += 28;
      }
      rows.push({
        kind: "assistant-unit",
        key: `${replyKey}:round:${round.key}:block:${block.key}`,
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
          block,
          roundMeta: round.meta,
          runningToolCallIds,
          thinkingOpen: "thinkingOpen" in round ? round.thinkingOpen : false,
          isLatestThinking: block.kind === "thinking" && block.key === latestThinkingKey,
          isRoundHead,
          isRoundTail,
          hasRunningToolCall: roundHasRunningToolCall,
        },
      });
    });
  });

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
    rows.push({
      kind: "assistant-unit",
      key: `${replyKey}:footer`,
      replyKey,
      estimate: rows.length === 0 ? 64 : 32,
      renderCost: 1,
      gapAfter: TRANSCRIPT_ROW_GAP_PX,
      anchorUserKey,
      live: true,
      mutable: true,
      renderMode,
      compacted,
      showAvatar: rows.length === 0,
      unit: { kind: "status" },
    });
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
        rounds,
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
  let rowCache = new WeakMap<
    RenderTimelineItem,
    {
      anchorUserKey: string | null;
      retryTarget: RenderUserMessage | null;
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

  const adoptSettledTwin = (
    historyItems: RenderTimelineItem[],
    turn: { replyKey: string; historyLenAtStart: number },
  ) => {
    for (let index = historyItems.length - 1; index >= turn.historyLenAtStart; index -= 1) {
      const item = historyItems[index];
      if (item?.kind === "assistant" && !streamOrigins.has(item.key)) {
        streamOrigins.set(item.key, turn.replyKey);
        if (rowCache.has(item)) {
          rowCache.delete(item);
          historyRowsCache = null;
        }
        return true;
      }
    }
    return false;
  };

  const buildHistoryRows = (
    item: RenderTimelineItem,
    retryTarget: RenderUserMessage | null,
  ): TranscriptRow[] => {
    const anchorUserKey = item.kind === "user" ? item.key : (retryTarget?.key ?? null);
    const cached = rowCache.get(item);
    if (cached && cached.anchorUserKey === anchorUserKey && cached.retryTarget === retryTarget) {
      return cached.rows;
    }

    let rows: TranscriptRow[];
    if (item.kind === "summary") {
      rows = [
        {
          kind: "summary",
          key: item.key,
          estimate: CHECKPOINT_ROW_ESTIMATE_PX,
          renderCost: 1,
          gapAfter: TRANSCRIPT_ROW_GAP_PX,
          anchorUserKey,
          item,
        },
      ];
    } else if (item.kind === "user") {
      rows = [
        {
          kind: "user",
          key: item.key,
          estimate: estimateUserRowHeight(item.text.length, item.attachments.length),
          renderCost: Math.min(4, 1 + item.attachments.length),
          gapAfter: TRANSCRIPT_ROW_GAP_PX,
          anchorUserKey: item.key,
          item,
        },
      ];
    } else {
      const originKey = streamOrigins.get(item.key);
      const assistantUnits = buildAssistantUnits({
        replyKey: originKey ?? item.key,
        live: false,
        renderMode: originKey ? "streaming" : "static",
        rounds: item.rounds,
        timestamp: item.timestamp,
        compacted: item.isFromCompactedSegment,
        replyText: buildReplyText(item.rounds),
        retryTarget,
        anchorUserKey,
      });
      rows = originKey ? [buildAssistantActivityRow(originKey, assistantUnits)] : assistantUnits;
    }
    rowCache.set(item, { anchorUserKey, retryTarget, rows });
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
      } else if (activeTurn.lastLiveUnits.some((row) => row.unit.kind === "block")) {
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
      for (const item of historyItems) {
        const itemRows = buildHistoryRows(item, retryTarget);
        historyRows.push(...itemRows);
        for (const row of itemRows) trackBirth(row.key);
        if (item.kind === "user") retryTarget = item;
      }
      historyRowsCache = { items: historyItems, rows: historyRows };
    }

    let rows = historyRows;
    let liveStartIndex = -1;
    if ((liveTailVisible || pendingSettle) && activeTurn) {
      let liveUnits = activeTurn.lastLiveUnits;
      if (liveTailVisible) {
        const rounds: (UiRound | LiveRound)[] =
          live.liveRounds.length > 0
            ? live.liveRounds
            : live.draftAssistantText
              ? [draftRound(live.draftAssistantText)]
              : [];
        liveUnits = buildAssistantUnits({
          replyKey: activeTurn.replyKey,
          live: true,
          renderMode: "streaming",
          rounds,
          compacted: false,
          replyText: "",
          retryTarget: null,
          anchorUserKey: historyRows.at(-1)?.anchorUserKey ?? null,
          liveUnitCache: activeTurn.liveUnitCache,
        });
        activeTurn.lastLiveUnits = liveUnits;
        activeTurn.settlingUnits = null;
      } else {
        if (!activeTurn.settlingUnits) {
          activeTurn.settlingUnits = activeTurn.lastLiveUnits
            .filter((row) => row.unit.kind !== "status")
            .map((row) => ({
              ...row,
              live: false,
              mutable: false,
            }));
        }
        liveUnits = activeTurn.settlingUnits;
      }
      const liveActivity = buildAssistantActivityRow(activeTurn.replyKey, liveUnits);
      rows = [...historyRows, liveActivity];
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
