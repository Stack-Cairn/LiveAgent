import { type ChatEntry, safeStringify } from "@/lib/chatUi";

import type { HistoryApplyMode, Turn, UserChatEntry } from "./types";

// History ↔ stream reconciliation. The persisted history and the streamed
// turns describe the same conversation, so they are aligned structurally —
// by persisted message refs where available, by end-anchored position
// otherwise — never by content hashing. A logical turn renders from exactly
// one source: while a stream turn covers it, its history twin is
// enrichment-only (messageRef for edit/resend, untrimmed tool payloads) and
// is never emitted as rows.

export type HistoryTurn = {
  user: UserChatEntry | null;
  entries: ChatEntry[];
};

export type AlignResult = {
  historyEntries: ChatEntry[];
  turns: Turn[];
  changed: boolean;
};

export function groupHistoryEntriesIntoTurns(entries: ChatEntry[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | null = null;
  for (const entry of entries) {
    if (entry.kind === "user") {
      if (current) {
        turns.push(current);
      }
      current = { user: entry, entries: [] };
      continue;
    }
    if (!current) {
      // Window cut mid-turn: leading assistant-side content without its user
      // message forms a headless turn.
      current = { user: null, entries: [] };
    }
    current.entries.push(entry);
  }
  if (current) {
    turns.push(current);
  }
  return turns;
}

function flattenHistoryTurns(turns: HistoryTurn[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (const turn of turns) {
    if (turn.user) {
      entries.push(turn.user);
    }
    entries.push(...turn.entries);
  }
  return entries;
}

function historyTurnHasAssistantContent(turn: HistoryTurn): boolean {
  return turn.entries.some((entry) => entry.kind !== "checkpoint");
}

function stableUserMessageId(user: UserChatEntry): string {
  return user.messageId?.trim() || user.messageRef?.messageId.trim() || "";
}

// The desktop assigns the user message id before persistence and mirrors that
// same id through user_message/runtime snapshots. History exposes it through
// messageRef, so matching is exact even when prompts and replies repeat. The
// timestamp/user-only fallbacks cover only identity-less malformed data and
// can never consume a completed historical exchange by content similarity.
function historyTurnMatchesActiveTurn(historyTurn: HistoryTurn, activeTurn: Turn): boolean {
  if (!historyTurn.user || !activeTurn.user) {
    return false;
  }
  const historyMessageId = stableUserMessageId(historyTurn.user);
  const activeMessageId = stableUserMessageId(activeTurn.user);
  if (historyMessageId || activeMessageId) {
    return (
      historyMessageId !== "" && activeMessageId !== "" && historyMessageId === activeMessageId
    );
  }

  const historyTimestamp = historyTurn.user.timestamp;
  const activeTimestamp = activeTurn.user.timestamp;
  if (
    typeof historyTimestamp === "number" &&
    typeof activeTimestamp === "number" &&
    historyTimestamp === activeTimestamp
  ) {
    return true;
  }

  if (!historyTurnHasAssistantContent(historyTurn)) {
    return historyTurn.user.text.trim() === activeTurn.user.text.trim();
  }
  return false;
}

function isLocalTurn(turn: Turn): boolean {
  return turn.key.startsWith("local:");
}

function isActiveTurn(turn: Turn): boolean {
  return turn.phase === "pending" || turn.phase === "streaming";
}

function enrichUserSlot(user: UserChatEntry, historyUser: UserChatEntry): UserChatEntry {
  let next = user;
  if (historyUser.messageRef && user.messageRef?.messageId !== historyUser.messageRef.messageId) {
    next = { ...next, messageRef: historyUser.messageRef };
  }
  if (next.attachments.length === 0 && historyUser.attachments.length > 0) {
    next = { ...next, attachments: historyUser.attachments };
  }
  return next;
}

// Upgrades a stream turn's payloads with their persisted twins (the live
// path trims large arguments/results; history carries the full content).
// Matching is by tool-call identity, falling back to same-kind ordinal —
// never by content. Streamed assistant/thinking text is already complete and
// is never replaced; but a turn that lost its content, or kept possibly
// incomplete content across a reset whose replay could not cover the run
// (contentStale), adopts the persisted entries wholesale — that is the only
// content history is authoritative for.
function enrichTurnFromHistory(turn: Turn, historyTurn: HistoryTurn): Turn {
  let next = turn;

  if (turn.user && historyTurn.user) {
    const nextUser = enrichUserSlot(turn.user, historyTurn.user);
    if (nextUser !== turn.user) {
      next = { ...next, user: nextUser };
    }
  }

  if (
    (next.entries.length === 0 || next.contentStale === true) &&
    historyTurn.entries.length > 0 &&
    next.phase === "settled"
  ) {
    return {
      ...next,
      entries: historyTurn.entries,
      contentStale: false,
      inferredLossErrorEntryId: undefined,
    };
  }

  const historyToolCalls = historyTurn.entries.filter(
    (entry): entry is Extract<ChatEntry, { kind: "tool_call" }> => entry.kind === "tool_call",
  );
  const historyToolResults = historyTurn.entries.filter(
    (entry): entry is Extract<ChatEntry, { kind: "tool_result" }> => entry.kind === "tool_result",
  );
  if (historyToolCalls.length === 0 && historyToolResults.length === 0) {
    return next;
  }

  let entries: ChatEntry[] | null = null;
  let toolCallOrdinal = 0;
  let toolResultOrdinal = 0;
  for (let index = 0; index < next.entries.length; index += 1) {
    const entry = next.entries[index];
    if (!entry) continue;

    if (entry.kind === "tool_call") {
      const ordinal = toolCallOrdinal++;
      const twin =
        historyToolCalls.find(
          (candidate) =>
            entry.toolCall.id.trim() !== "" && candidate.toolCall.id === entry.toolCall.id,
        ) ?? historyToolCalls[ordinal];
      if (
        twin &&
        (safeStringify(twin.toolCall) !== safeStringify(entry.toolCall) ||
          twin.summary !== entry.summary)
      ) {
        if (!entries) entries = next.entries.slice();
        entries[index] = { ...twin, id: entry.id, round: entry.round };
      }
      continue;
    }

    if (entry.kind === "tool_result") {
      const ordinal = toolResultOrdinal++;
      const twin =
        historyToolResults.find(
          (candidate) =>
            entry.toolResult.toolCallId.trim() !== "" &&
            candidate.toolResult.toolCallId === entry.toolResult.toolCallId,
        ) ?? historyToolResults[ordinal];
      if (twin && safeStringify(twin.toolResult) !== safeStringify(entry.toolResult)) {
        if (!entries) entries = next.entries.slice();
        entries[index] = { ...twin, id: entry.id, round: entry.round };
      }
    }
  }
  if (entries) {
    next = next === turn ? { ...turn, entries } : { ...next, entries };
  }
  return next;
}

// Persistence-lag protection. The desktop reports run_finished before its
// final history flush lands (the post-run persist is fire-and-forget), so a
// window fetched in that gap carries the exchange's user message WITHOUT its
// reply. Such a user-only twin must never count as covering a settled turn
// that holds streamed assistant content: the turn keeps rendering (it holds
// the only copy of the reply), its echo is trimmed from the window so the
// prompt renders once, and the twin's messageRef is adopted so the next
// full window ref-matches and takes over normally.
//
// Matching is ref-anchored where the turn carries a persisted ref; ref-less
// turns pair end-anchored against trailing user-only window turns, guarded
// by prompt-text equality so a foreign client's just-persisted prompt is
// never mistaken for the settled turn's own echo.
function protectLaggedSettledTurns(
  historyTurns: HistoryTurn[],
  turns: Turn[],
): { historyTurns: HistoryTurn[]; protectedTurns: Map<Turn, Turn> } {
  const protectedTurns = new Map<Turn, Turn>();
  const settledWithContent = turns.filter(
    (turn) =>
      !isActiveTurn(turn) && !isLocalTurn(turn) && turn.user !== null && turn.entries.length > 0,
  );
  if (settledWithContent.length === 0) {
    return { historyTurns, protectedTurns };
  }

  const adoptTwinUser = (turn: Turn, twin: HistoryTurn): Turn => {
    if (!turn.user || !twin.user) {
      return turn;
    }
    const user = enrichUserSlot(turn.user, twin.user);
    return user === turn.user ? turn : { ...turn, user };
  };

  let remaining = historyTurns;

  // Ref-anchored: the persisted user message is in the window but carries no
  // assistant content yet.
  for (const turn of settledWithContent) {
    const ref = turn.user?.messageRef?.messageId;
    if (!ref) continue;
    const twinIndex = remaining.findIndex(
      (candidate) => candidate.user?.messageRef?.messageId === ref,
    );
    if (twinIndex < 0) continue;
    const twin = remaining[twinIndex];
    if (!twin || historyTurnHasAssistantContent(twin)) continue;
    protectedTurns.set(turn, adoptTwinUser(turn, twin));
    remaining = [...remaining.slice(0, twinIndex), ...remaining.slice(twinIndex + 1)];
  }

  // Positional: trailing user-only window turns are the persist-lagged
  // echoes of the freshest exchanges; pair them end-anchored with ref-less
  // settled turns holding content, gated by identical prompt text. A
  // trailing echo with no matching turn (e.g. a queued next prompt whose
  // persist overtook the lagging reply flush) is skipped, not a pairing
  // stop — the reply's turn may sit right behind it.
  const reflessSettled = settledWithContent.filter(
    (turn) => !turn.user?.messageRef && !protectedTurns.has(turn),
  );
  let trailingUserOnly = 0;
  while (trailingUserOnly < remaining.length) {
    const candidate = remaining[remaining.length - 1 - trailingUserOnly];
    if (!candidate?.user || historyTurnHasAssistantContent(candidate)) {
      break;
    }
    trailingUserOnly += 1;
  }
  const matchedTwinIndexes = new Set<number>();
  let turnCursor = reflessSettled.length - 1;
  for (let offset = 0; offset < trailingUserOnly && turnCursor >= 0; offset += 1) {
    const twinIndex = remaining.length - 1 - offset;
    const twin = remaining[twinIndex];
    const turn = reflessSettled[turnCursor];
    if (!twin?.user || !turn?.user) {
      continue;
    }
    if (twin.user.text.trim() !== turn.user.text.trim()) {
      continue;
    }
    protectedTurns.set(turn, adoptTwinUser(turn, twin));
    matchedTwinIndexes.add(twinIndex);
    turnCursor -= 1;
  }
  if (matchedTwinIndexes.size > 0) {
    remaining = remaining.filter((_, index) => !matchedTwinIndexes.has(index));
  }

  return { historyTurns: remaining, protectedTurns };
}

// The guarded full-repaint fallback: history becomes authoritative for
// everything it covers. Turns whose content history cannot know yet are
// kept — a persisted-ref lookup misses (persistence lag), a user-only twin
// whose reply flush is still in flight (see protectLaggedSettledTurns), or a
// local error pseudo-turn that was never on the server. Worst case is a
// repaint, never a duplicate and never on-screen content loss.
function replaceAll(entries: ChatEntry[], turns: Turn[], historyTurns: HistoryTurn[]): AlignResult {
  const protection = protectLaggedSettledTurns(historyTurns, turns);
  const remainingHistoryTurns = protection.historyTurns;
  const protectedTurns = protection.protectedTurns;
  const knownRefs = new Set(
    remainingHistoryTurns.flatMap((turn) =>
      turn.user?.messageRef?.messageId ? [turn.user.messageRef.messageId] : [],
    ),
  );
  const kept = turns.flatMap((turn) => {
    const protectedTurn = protectedTurns.get(turn);
    if (protectedTurn) {
      return [protectedTurn];
    }
    if (isLocalTurn(turn) || isActiveTurn(turn)) {
      return [turn];
    }
    const ref = turn.user?.messageRef?.messageId;
    return ref !== undefined && !knownRefs.has(ref) ? [turn] : [];
  });
  return {
    historyEntries: protectedTurns.size > 0 ? flattenHistoryTurns(remainingHistoryTurns) : entries,
    turns: kept,
    changed: true,
  };
}

// mode "replace" — a full (re)load of the conversation (switch-in,
// load-more). The parsed history becomes the folded region; settled turns
// covered by it are dropped in its favor (deterministic parse ids keep the
// previously-loaded region id-stable), turns history cannot know yet
// survive, and pending/streaming turns — the active exchange — always
// survive with their persisted echoes trimmed so the prompt renders once.
// "Covered" requires the reply, not just the prompt: a settled turn whose
// window twin is still user-only (the desktop's post-run flush races the
// fetch) keeps rendering its streamed content (protectLaggedSettledTurns).
function alignReplace(params: { turns: Turn[]; entries: ChatEntry[] }): AlignResult {
  let historyTurns = groupHistoryEntriesIntoTurns(params.entries);

  // Trim persisted echoes of active exchanges. Ref-anchored first (covers
  // edit-resends whose turn already carries the base ref)…
  const activeWithUser = params.turns.filter((turn) => isActiveTurn(turn) && turn.user !== null);
  const activeRefs = new Set(
    activeWithUser.flatMap((turn) =>
      turn.user?.messageRef?.messageId ? [turn.user.messageRef.messageId] : [],
    ),
  );
  if (activeRefs.size > 0) {
    historyTurns = historyTurns.filter(
      (turn) =>
        !turn.user?.messageRef?.messageId || !activeRefs.has(turn.user.messageRef.messageId),
    );
  }

  // …then pair the remaining ref-less active prompts with the trailing
  // persisted turns. History may already contain a partial assistant reply:
  // opening a running conversation races history.get against chat.subscribe,
  // so limiting this match to user-only turns leaves two copies when history
  // wins that race. Stable message ids disambiguate repeated prompts and
  // repeated replies; the live turn remains authoritative only after proof.
  const reflessActive = activeWithUser.filter((turn) => !turn.user?.messageRef);
  const enrichedActive = new Map<Turn, Turn>();
  const matchedHistoryIndexes = new Set<number>();
  let historyCursor = historyTurns.length - 1;
  for (let activeCursor = reflessActive.length - 1; activeCursor >= 0; activeCursor -= 1) {
    const historyTurn = historyTurns[historyCursor];
    const keptTurn = reflessActive[activeCursor];
    const historyUser = historyTurn?.user;
    const keptUser = keptTurn?.user;
    if (
      !historyTurn ||
      !keptTurn ||
      !historyUser ||
      !keptUser ||
      !historyTurnMatchesActiveTurn(historyTurn, keptTurn)
    ) {
      break;
    }
    const enrichedUser = enrichUserSlot(keptUser, historyUser);
    if (enrichedUser !== keptUser) {
      enrichedActive.set(keptTurn, { ...keptTurn, user: enrichedUser });
    }
    matchedHistoryIndexes.add(historyCursor);
    historyCursor -= 1;
  }
  if (matchedHistoryIndexes.size > 0) {
    historyTurns = historyTurns.filter((_, index) => !matchedHistoryIndexes.has(index));
  }

  // Settled turns whose persisted echo reached the window without its reply
  // (post-run flush still in flight) survive with their echo trimmed.
  const protection = protectLaggedSettledTurns(historyTurns, params.turns);
  historyTurns = protection.historyTurns;
  const protectedTurns = protection.protectedTurns;

  // Decide which settled turns the fetched window covers. Ref-anchored turns
  // are covered exactly when their persisted message is in the window. The
  // window is always a suffix of the conversation, so for ref-less settled
  // turns — the freshest exchanges, whose persistence is the most likely to
  // lag the fetch — the number of window turns left after ref matching says
  // how many of them are covered; the newest excess survives, or the last
  // reply would blank on a reload racing persistence.
  const knownRefs = new Set(
    historyTurns.flatMap((turn) =>
      turn.user?.messageRef?.messageId ? [turn.user.messageRef.messageId] : [],
    ),
  );
  const settledTurns = params.turns.filter(
    (turn) => !isActiveTurn(turn) && !isLocalTurn(turn) && !protectedTurns.has(turn),
  );
  const refMatchedCount = settledTurns.filter((turn) => {
    const ref = turn.user?.messageRef?.messageId;
    return ref !== undefined && knownRefs.has(ref);
  }).length;
  const reflessSettled = settledTurns.filter((turn) => !turn.user?.messageRef);
  const historyUserCount = historyTurns.filter((turn) => turn.user !== null).length;
  const coveredRefless = Math.min(
    reflessSettled.length,
    Math.max(0, historyUserCount - refMatchedCount),
  );
  const keptRefless = new Set(reflessSettled.slice(coveredRefless));

  const turns = params.turns.flatMap((turn) => {
    const protectedTurn = protectedTurns.get(turn);
    if (protectedTurn) {
      return [protectedTurn];
    }
    if (isActiveTurn(turn)) {
      return [enrichedActive.get(turn) ?? turn];
    }
    if (isLocalTurn(turn)) {
      return [turn];
    }
    const ref = turn.user?.messageRef?.messageId;
    if (ref !== undefined) {
      return knownRefs.has(ref) ? [] : [turn];
    }
    return keptRefless.has(turn) ? [turn] : [];
  });

  return {
    historyEntries: flattenHistoryTurns(historyTurns),
    turns,
    changed: true,
  };
}

// mode "enrich" — the quiet idle refresh. At idle the rendered conversation
// is exactly historyEntries + turns, so the incoming window's user-turn
// count discriminates every case:
//
//   |V| <  |S|            partial window too small to say anything — skip
//   |V| <  region + |S|   suffix window: pair the last |S| turns, leave the
//                         existing history region untouched
//   |V| == region + |S|   full window: pair the last |S| turns, everything
//                         older becomes the history region
//   |V| >  region + |S|   history knows exchanges this client never streamed
//                         — guarded full repaint (persist-lagged and local
//                         turns survive; see replaceAll)
//
// Paired turns are upgraded in place (messageRef, full tool payloads); the
// pairing is positional, end-anchored, guarded by persisted message ids
// where both sides carry one.
function alignEnrich(params: {
  historyEntries: ChatEntry[];
  turns: Turn[];
  entries: ChatEntry[];
}): AlignResult {
  const unchanged: AlignResult = {
    historyEntries: params.historyEntries,
    turns: params.turns,
    changed: false,
  };

  // Never merge under an active exchange (callers gate on idle; keep the
  // invariant local too).
  if (params.turns.some(isActiveTurn)) {
    return unchanged;
  }

  const historyTurns = groupHistoryEntriesIntoTurns(params.entries);
  const historyWithUser = historyTurns.filter((turn) => turn.user !== null);
  const storeWithUser = params.turns.filter((turn) => turn.user !== null);
  const regionUserCount = params.historyEntries.reduce(
    (count, entry) => (entry.kind === "user" ? count + 1 : count),
    0,
  );

  if (historyWithUser.length < storeWithUser.length) {
    return unchanged;
  }
  if (historyWithUser.length > regionUserCount + storeWithUser.length) {
    return replaceAll(params.entries, params.turns, historyTurns);
  }

  // messageRef guard: conflicting persisted identities mean the store turns
  // are stale — repaint rather than mis-enrich.
  for (let pair = 0; pair < storeWithUser.length; pair += 1) {
    const storeTurn = storeWithUser[storeWithUser.length - 1 - pair];
    const historyTurn = historyWithUser[historyWithUser.length - 1 - pair];
    const storeRef = storeTurn?.user?.messageRef?.messageId;
    const historyRef = historyTurn?.user?.messageRef?.messageId;
    if (storeRef && historyRef && storeRef !== historyRef) {
      return replaceAll(params.entries, params.turns, historyTurns);
    }
  }

  let turns = params.turns;
  for (let pair = 0; pair < storeWithUser.length; pair += 1) {
    const storeTurn = storeWithUser[storeWithUser.length - 1 - pair];
    const historyTurn = historyWithUser[historyWithUser.length - 1 - pair];
    if (!storeTurn || !historyTurn) continue;
    const enriched = enrichTurnFromHistory(storeTurn, historyTurn);
    if (enriched !== storeTurn) {
      if (turns === params.turns) turns = params.turns.slice();
      const index = turns.indexOf(storeTurn);
      if (index >= 0) {
        turns[index] = enriched;
      }
    }
  }

  // A suffix window says nothing about older rows: keep the region as-is.
  if (historyWithUser.length < regionUserCount + storeWithUser.length) {
    if (turns === params.turns) {
      return unchanged;
    }
    return { historyEntries: params.historyEntries, turns, changed: true };
  }

  // Full window: everything older than the paired turns renders from
  // history. Parse ids are deterministic, so an id-level comparison detects
  // every structural change; identical content reparses to identical ids.
  const pairStart =
    storeWithUser.length === 0
      ? historyTurns.length
      : historyTurns.indexOf(historyWithUser[historyWithUser.length - storeWithUser.length]!);
  const nextHistoryEntries = flattenHistoryTurns(historyTurns.slice(0, pairStart));

  const historyChanged =
    nextHistoryEntries.length !== params.historyEntries.length ||
    nextHistoryEntries.some((entry, index) => params.historyEntries[index]?.id !== entry.id);

  if (!historyChanged && turns === params.turns) {
    return unchanged;
  }
  return {
    historyEntries: historyChanged ? nextHistoryEntries : params.historyEntries,
    turns,
    changed: true,
  };
}

export function alignHistory(params: {
  historyEntries: ChatEntry[];
  turns: Turn[];
  entries: ChatEntry[];
  mode: HistoryApplyMode;
}): AlignResult {
  if (params.mode === "replace") {
    return alignReplace({ turns: params.turns, entries: params.entries });
  }
  return alignEnrich(params);
}
