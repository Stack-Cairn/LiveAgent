// Reply continuity across context compaction.
//
// A compaction that lands in the middle of a reply is persisted as
// `assistant(A) → checkpoint → assistant(B)` with no user message between
// the halves. Rendered naively that reads as two replies separated by a
// card. This module is the single place that folds such a chain back into
// ONE reply: the checkpoint becomes a zero-block "seam round" placed between
// the halves, so every downstream consumer (turn layout, changed-files
// aggregation, usage entries, reply text) sees one continuous round
// sequence and the transcript renders one avatar, one work trace with an
// inline seam milestone, one answer and one footer.
//
// Both frontends feed their own row/item shapes through the generic
// stitcher; the seam payload is a structural subset of the GUI summary item
// and the WebUI checkpoint row, so either can be passed as-is.

export type CompactionSeam = {
  key: string;
  summaryId: string;
  content: string;
  coveredMessageCount: number;
  generatedBy: {
    providerId: string;
    model: string;
    promptVersion?: string;
  };
  contextUsageTokens?: number;
  timestamp?: number;
};

/**
 * A checkpoint projected into the round sequence of a reply. It carries no
 * content blocks, so block-level consumers (changed files, reply text,
 * usage) skip it transparently; only the turn layout materializes it as a
 * `checkpoint` work entry.
 */
export type CompactionSeamRound = {
  round: number;
  key: string;
  blocks: [];
  runningToolCallIds: [];
  thinkingOpen: false;
  /** Never set; present so the seam satisfies round-shaped consumers. */
  meta?: undefined;
  checkpoint: CompactionSeam;
};

const seamRoundCache = new WeakMap<CompactionSeam, CompactionSeamRound>();

export function createCompactionSeamRound(seam: CompactionSeam): CompactionSeamRound {
  const cached = seamRoundCache.get(seam);
  if (cached) return cached;
  const round: CompactionSeamRound = {
    round: 0,
    key: seam.key,
    blocks: [],
    runningToolCallIds: [],
    thinkingOpen: false,
    checkpoint: seam,
  };
  seamRoundCache.set(seam, round);
  return round;
}

export function getCompactionSeam(round: object): CompactionSeam | null {
  const candidate = (round as { checkpoint?: unknown }).checkpoint;
  if (!candidate || typeof candidate !== "object") return null;
  const seam = candidate as Partial<CompactionSeam>;
  return typeof seam.key === "string" && typeof seam.content === "string"
    ? (seam as CompactionSeam)
    : null;
}

export function countCompactionSeams(rounds: readonly object[]): number {
  let count = 0;
  for (const round of rounds) {
    if (getCompactionSeam(round)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Round re-keying

type RekeyableRound = { round: number; key?: string };

const rekeyedRoundCache = new Map<number, WeakMap<object, RekeyableRound>>();

/**
 * Round keys are per-group ordinals (`r1`, `r2`, …) in persisted history and
 * runner round numbers while streaming, so the halves of a stitched reply
 * collide (`r1` in both) and a streamed continuation may not match its
 * persisted twin (the runner keeps counting after a post-tool compaction
 * but restarts after a mid-stream one). Every part after the first is
 * re-keyed by its POSITION inside the part (`p<ordinal>:r<n>`): the live
 * continuation and its persisted twin then agree by construction, which is
 * what keeps settling a stitched reply remount-free. Part 0 keeps its
 * original keys so ordinary replies are untouched.
 */
export function rekeyContinuationRounds<T extends RekeyableRound>(
  rounds: readonly T[],
  partOrdinal: number,
): T[] {
  if (partOrdinal <= 0) return rounds as T[];
  let cache = rekeyedRoundCache.get(partOrdinal);
  if (!cache) {
    cache = new WeakMap();
    rekeyedRoundCache.set(partOrdinal, cache);
  }
  return rounds.map((round, index) => {
    const cached = cache.get(round);
    if (cached) return cached as T;
    const rekeyed = { ...round, key: `p${partOrdinal}:r${index + 1}` };
    cache.set(round, rekeyed);
    return rekeyed;
  });
}

// ---------------------------------------------------------------------------
// Timeline stitching

export type ReplyStitchClass = "user" | "assistant" | "checkpoint" | "other";

export type StitchedTimelineGroup<T> =
  | { kind: "single"; item: T; index: number }
  | {
      kind: "reply";
      items: T[];
      start: number;
      /** Exclusive end index into the source list. */
      end: number;
    };

/**
 * Group a transcript into render units. A checkpoint is a seam of the reply
 * it interrupts exactly when an assistant part follows it without a user
 * message in between; a checkpoint that ends a run (idle manual compaction,
 * pre-send compaction, a run that stopped right after compacting) stays a
 * standalone divider. Leading checkpoints of a reply (compaction fired
 * before any content) fold into that reply as its first seam.
 */
export function stitchCompactedReplies<T>(
  items: readonly T[],
  classify: (item: T) => ReplyStitchClass,
): StitchedTimelineGroup<T>[] {
  const groups: StitchedTimelineGroup<T>[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index] as T;
    const itemClass = classify(item);
    if (itemClass !== "assistant" && itemClass !== "checkpoint") {
      groups.push({ kind: "single", item, index });
      index += 1;
      continue;
    }

    let runEnd = index;
    while (runEnd < items.length) {
      const runClass = classify(items[runEnd] as T);
      if (runClass !== "assistant" && runClass !== "checkpoint") break;
      runEnd += 1;
    }

    let replyEnd = runEnd;
    while (replyEnd > index && classify(items[replyEnd - 1] as T) === "checkpoint") {
      replyEnd -= 1;
    }

    if (replyEnd - index === 1) {
      // A lone assistant item is an ordinary reply; keep it on the untouched
      // single-item path so nothing about it changes.
      groups.push({ kind: "single", item: items[index] as T, index });
    } else if (replyEnd > index) {
      groups.push({
        kind: "reply",
        items: items.slice(index, replyEnd) as T[],
        start: index,
        end: replyEnd,
      });
    }
    for (let single = replyEnd; single < runEnd; single += 1) {
      groups.push({ kind: "single", item: items[single] as T, index: single });
    }
    index = runEnd;
  }
  return groups;
}

export type ContinuousReplyAdapters<TItem, TRound extends RekeyableRound> = {
  classify: (item: TItem) => ReplyStitchClass;
  roundsOf: (item: TItem) => readonly TRound[];
  seamOf: (item: TItem) => CompactionSeam;
  /**
   * Whether assistant parts after the first need positional re-keying. GUI
   * history rounds are per-group ordinals and collide; WebUI rounds already
   * carry a group-unique prefix.
   */
  rekeyParts: boolean;
};

export type ContinuousReply<TRound> = {
  rounds: (TRound | CompactionSeamRound)[];
  seamCount: number;
  partCount: number;
};

/**
 * Flatten the members of a stitched reply into one round sequence:
 * assistant parts contribute their rounds (re-keyed by part ordinal when
 * requested), checkpoints contribute a seam round at their position.
 */
export function assembleContinuousReply<TItem, TRound extends RekeyableRound>(
  items: readonly TItem[],
  adapters: ContinuousReplyAdapters<TItem, TRound>,
): ContinuousReply<TRound> {
  const rounds: (TRound | CompactionSeamRound)[] = [];
  let partCount = 0;
  let seamCount = 0;
  for (const item of items) {
    const itemClass = adapters.classify(item);
    if (itemClass === "checkpoint") {
      rounds.push(createCompactionSeamRound(adapters.seamOf(item)));
      seamCount += 1;
      continue;
    }
    if (itemClass !== "assistant") continue;
    const partRounds = adapters.roundsOf(item);
    rounds.push(
      ...(adapters.rekeyParts ? rekeyContinuationRounds(partRounds, partCount) : partRounds),
    );
    partCount += 1;
  }
  return { rounds, seamCount, partCount };
}
