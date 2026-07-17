import type {
  RenderSummaryCard,
  RenderTimelineItem,
  RenderUserMessage,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptState } from "../../../lib/chat/conversation/liveTranscriptStore";
import { getRoundText, type LiveRound, type UiRound } from "../../../lib/chat/messages/uiMessages";
import {
  CHECKPOINT_ROW_ESTIMATE_PX,
  estimateAssistantRowHeight,
  estimateUserRowHeight,
} from "../../../lib/transcript-virtual/rowEstimates";

// The transcript's single row list: committed history rows plus (while a run
// is active) one live assistant tail row, all rendered by one virtualizer in
// one container. Folding a finished reply into history is a pure data
// transition — the row key, the round keys and the block ids all carry over,
// so React reconciles the settled reply in place and nothing remounts.

export type SummaryRow = {
  kind: "summary";
  key: string;
  estimate: number;
  item: RenderSummaryCard;
};

export type UserRow = {
  kind: "user";
  key: string;
  estimate: number;
  item: RenderUserMessage;
};

export type AssistantRow = {
  kind: "assistant";
  key: string;
  estimate: number;
  // Live rows stream from the live store; settled rows come from history.
  live: boolean;
  // Stream-born rows keep Streamdown's streaming mode forever (mirrors the
  // WebUI invariant): the mode of a row never flips, so the streaming→static
  // re-parse cannot happen.
  renderMode: "streaming" | "static";
  rounds: (UiRound | LiveRound)[];
  timestamp?: number;
  compacted: boolean;
  replyText: string;
  // Retry re-sends the nearest preceding user prompt through the edit-resend
  // truncation pipeline; resolved at build time so rows stay self-contained.
  retryTarget: RenderUserMessage | null;
};

export type TranscriptRow = SummaryRow | UserRow | AssistantRow;

export type TranscriptRowsSnapshot = {
  rows: TranscriptRow[];
  // Index of the first live row; -1 when idle. Rows at or after this index
  // are force-mounted by the virtualizer's live range extractor.
  liveStartIndex: number;
};

export type LiveTailInput = LiveTranscriptState & {
  isSending: boolean;
};

function computeAssistantEstimate(rounds: (UiRound | LiveRound)[]): number {
  let textChars = 0;
  let toolCount = 0;
  let thinkingCount = 0;
  for (const round of rounds) {
    for (const block of round.blocks) {
      if (block.kind === "text") {
        textChars += block.text.length;
      } else if (block.kind === "thinking") {
        thinkingCount += 1;
      } else {
        toolCount += 1;
      }
    }
  }
  return estimateAssistantRowHeight({ textChars, toolCount, thinkingCount });
}

function buildReplyText(rounds: (UiRound | LiveRound)[]): string {
  return rounds
    .map((round) => getRoundText(round).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export type TranscriptRowModelOptions = {
  // Fired once per build that discovers new row keys (always fired for the
  // first build, even when empty, so the entrance registry can stamp the
  // initial rows as never-animating).
  onRowsBorn?: (keys: readonly string[], isInitialBuild: boolean) => void;
};

export type TranscriptRowModel = {
  build: (historyItems: RenderTimelineItem[], live: LiveTailInput) => TranscriptRowsSnapshot;
  reset: () => void;
};

export function createTranscriptRowModel(options?: TranscriptRowModelOptions): TranscriptRowModel {
  // Settled rows cache by item identity: a streaming commit leaves history
  // item objects untouched, so per-frame builds reuse every settled row and
  // memoized row components bail on identity.
  let rowCache = new WeakMap<RenderTimelineItem, TranscriptRow>();
  // The composed history-row array, reused while the historyItems array
  // identity is unchanged — live-store emits then skip the per-item walk
  // entirely instead of paying O(history) per frame.
  let historyRowsCache: { items: RenderTimelineItem[]; rows: TranscriptRow[] } | null = null;
  // Committed keys of stream-born replies → their live row key. Keying the
  // committed row with the live key is what makes settle remount-free.
  let streamOrigins = new Map<string, string>();
  // Every key ever produced, for O(new) birth reporting.
  let knownKeys = new Set<string>();
  let hasBuilt = false;
  let turnSeq = 0;
  // The active live turn, or a settled turn still waiting for its committed
  // twin to land in history (desktop persistence can lag the run's end).
  let activeTurn: { rowKey: string; historyLenAtStart: number } | null = null;
  let pendingSettle: { rowKey: string; historyLenAtStart: number } | null = null;
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
    draftRoundCache = null;
  };

  const draftRound = (text: string): LiveRound => {
    if (draftRoundCache?.text !== text) {
      // Mirrors what buildUiMessages will derive for a single-text reply
      // (round r1, block text-1), so the settled twin reconciles in place.
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
    turn: { rowKey: string; historyLenAtStart: number },
  ) => {
    for (let index = historyItems.length - 1; index >= turn.historyLenAtStart; index -= 1) {
      const item = historyItems[index];
      if (item?.kind === "assistant") {
        streamOrigins.set(item.key, turn.rowKey);
        // The twin can land while the run is still sending; drop any
        // un-aliased row built for it so the next build re-keys it onto the
        // live row instead of remounting.
        if (rowCache.has(item)) {
          rowCache.delete(item);
          historyRowsCache = null;
        }
        return true;
      }
    }
    return false;
  };

  const buildHistoryRow = (
    item: RenderTimelineItem,
    retryTarget: RenderUserMessage | null,
  ): TranscriptRow => {
    const cached = rowCache.get(item);
    if (cached) {
      return cached;
    }
    let row: TranscriptRow;
    if (item.kind === "summary") {
      row = { kind: "summary", key: item.key, estimate: CHECKPOINT_ROW_ESTIMATE_PX, item };
    } else if (item.kind === "user") {
      row = {
        kind: "user",
        key: item.key,
        estimate: estimateUserRowHeight(item.text.length),
        item,
      };
    } else {
      const originKey = streamOrigins.get(item.key);
      row = {
        kind: "assistant",
        key: originKey ?? item.key,
        estimate: computeAssistantEstimate(item.rounds),
        live: false,
        renderMode: originKey ? "streaming" : "static",
        rounds: item.rounds,
        timestamp: item.timestamp,
        compacted: item.isFromCompactedSegment,
        replyText: buildReplyText(item.rounds),
        retryTarget,
      };
    }
    rowCache.set(item, row);
    return row;
  };

  const build = (
    historyItems: RenderTimelineItem[],
    live: LiveTailInput,
  ): TranscriptRowsSnapshot => {
    const liveTailVisible = live.isSending;
    const isInitialBuild = !hasBuilt;
    hasBuilt = true;

    if (liveTailVisible && !activeTurn) {
      // A settled turn still waiting for its twin is superseded by the new
      // turn — the next assistant item would belong to the new run.
      pendingSettle = null;
      activeTurn = {
        rowKey: `live-turn-${++turnSeq}`,
        historyLenAtStart: historyItems.length,
      };
    } else if (!liveTailVisible && activeTurn) {
      if (!adoptSettledTwin(historyItems, activeTurn)) {
        pendingSettle = activeTurn;
      }
      activeTurn = null;
    } else if (!liveTailVisible && pendingSettle) {
      if (adoptSettledTwin(historyItems, pendingSettle)) {
        pendingSettle = null;
      }
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
        const row = buildHistoryRow(item, item.kind === "assistant" ? retryTarget : null);
        historyRows.push(row);
        trackBirth(row.key);
        if (item.kind === "user") {
          retryTarget = item;
        }
      }
      historyRowsCache = { items: historyItems, rows: historyRows };
    }

    let rows = historyRows;
    let liveStartIndex = -1;
    if (liveTailVisible && activeTurn) {
      const rounds: (UiRound | LiveRound)[] =
        live.liveRounds.length > 0
          ? live.liveRounds
          : live.draftAssistantText
            ? [draftRound(live.draftAssistantText)]
            : [];
      liveStartIndex = historyRows.length;
      trackBirth(activeTurn.rowKey);
      rows = [
        ...historyRows,
        {
          kind: "assistant",
          key: activeTurn.rowKey,
          estimate: rounds.length > 0 ? computeAssistantEstimate(rounds) : 80,
          live: true,
          renderMode: "streaming",
          rounds,
          compacted: false,
          replyText: "",
          retryTarget: null,
        },
      ];
    }

    if (bornKeys.length > 0 || isInitialBuild) {
      options?.onRowsBorn?.(bornKeys, isInitialBuild);
    }

    return { rows, liveStartIndex };
  };

  return { build, reset };
}
