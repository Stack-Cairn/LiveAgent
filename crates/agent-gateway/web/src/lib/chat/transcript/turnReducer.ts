import type { ToolCall } from "@/lib/agentTypes";
import { isAbortLikeError } from "@/lib/chat/chatPageHelpers";
import {
  enrichHostedSearchBlockWithText,
  mergeHostedSearchBlocks,
  normalizeHostedSearchBlock,
} from "@/lib/chat/hostedSearch";
import { toolArgsProgress } from "@/lib/chat/toolPreview";
import { summarizeToolCall } from "@/lib/chat/uiMessages";
import {
  buildAssistantMeta,
  buildHostedSearchEntry,
  buildToolCallEntry,
  buildToolResultEntry,
  type ChatEntry,
  formatLiveErrorMessage,
  hashText,
  hashValue,
  isCheckpointTokenEvent,
  isMatchingToolCallEntry,
  isMatchingToolResultEntry,
  normalizeCheckpointEntry,
  normalizeToolArguments,
  normalizeToolCallLike,
  safeStringify,
  stripRecoveredToolCallMarkup,
} from "@/lib/chatUi";
import type { ChatEvent } from "@/lib/gatewayTypes";

import type { Turn, TurnPhase } from "./types";

// Applies one assistant-side stream event to a turn. Every merge/dedup scan
// is bounded by the turn (and, within it, the segment since the last
// checkpoint/error entry) — the turn boundary replaces every "walk the tail
// back to the last user bubble" scan of the old flat-entry pipeline.
//
// Entry ids are deterministic in the run namespace (`r:<runId>:…`) so a
// resubscribe replay rebuilds identical ids and nothing remounts.

export function optimisticUserEntryId(clientRequestId: string): string {
  return `ou:${clientRequestId}`;
}

export function seededUserEntryId(runId: string): string {
  return `r:${runId}:u`;
}

export function createTurn(params: {
  key: string;
  runId?: string;
  clientRequestId?: string;
  user?: Turn["user"];
  phase?: TurnPhase;
}): Turn {
  return {
    key: params.key,
    runId: params.runId ?? "",
    clientRequestId: params.clientRequestId ?? "",
    user: params.user ?? null,
    entries: [],
    phase: params.phase ?? "pending",
    folded: false,
  };
}

function turnNamespace(turn: Turn): string {
  return `r:${turn.runId || turn.key}`;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readRound(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 0 ? Math.floor(value) : undefined;
}

function recordHasEntries(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

// Start index of the current segment: entries after the last checkpoint or
// standalone error entry (both flush the assistant group in the row builder,
// so merges must not reach across them).
function segmentStartIndex(entries: ChatEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const kind = entries[index]?.kind;
    if (kind === "checkpoint" || kind === "error") {
      return index + 1;
    }
  }
  return 0;
}

function findLastSegmentAssistantIndex(entries: ChatEntry[], round?: number): number {
  const start = segmentStartIndex(entries);
  for (let index = entries.length - 1; index >= start; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant" && (round === undefined || entry.round === round)) {
      return index;
    }
  }
  return -1;
}

function countSegmentEntries(entries: ChatEntry[], matcher: (entry: ChatEntry) => boolean): number {
  const start = segmentStartIndex(entries);
  let count = 0;
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry && matcher(entry)) {
      count += 1;
    }
  }
  return count;
}

function countTurnEntries(entries: ChatEntry[], matcher: (entry: ChatEntry) => boolean): number {
  let count = 0;
  for (const entry of entries) {
    if (matcher(entry)) {
      count += 1;
    }
  }
  return count;
}

function segmentHasAssistantText(entries: ChatEntry[]): boolean {
  const start = segmentStartIndex(entries);
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant" && entry.text.trim()) {
      return true;
    }
  }
  return false;
}

function hasSegmentEntry(entries: ChatEntry[], matcher: (entry: ChatEntry) => boolean): boolean {
  const start = segmentStartIndex(entries);
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry && matcher(entry)) {
      return true;
    }
  }
  return false;
}

// Fills empty tool-call arguments in place when a later event carries the
// full payload (tool_call_delta upgrades, tool_result argument echoes).
function mergeSegmentToolCallArguments(
  entries: ChatEntry[],
  params: {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    round?: number;
  },
): { entries: ChatEntry[]; matched: boolean } {
  const incomingArgs = normalizeToolArguments(params.arguments);
  const hasIncomingArgs = recordHasEntries(incomingArgs);
  const incomingId = readString(params.id).trim();
  const incomingName = readString(params.name).trim();
  const start = segmentStartIndex(entries);

  for (let index = entries.length - 1; index >= start; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "tool_call") {
      continue;
    }
    if (params.round !== undefined && entry.round !== params.round) {
      continue;
    }

    const existingArgs = normalizeToolArguments(entry.toolCall.arguments);
    const hasExistingArgs = recordHasEntries(existingArgs);
    let matches = false;
    let canUpdate = false;

    if (incomingId !== "") {
      matches = entry.toolCall.id === incomingId;
      if (matches && hasIncomingArgs) {
        // Monotonic guard for file tools: streamed args only grow, so a
        // lower-progress writer (late delta replay, lagging snapshot echo)
        // must never roll the entry back.
        const incomingProgress = toolArgsProgress(
          incomingName || entry.toolCall.name,
          incomingArgs,
        );
        const existingProgress = toolArgsProgress(entry.toolCall.name, existingArgs);
        const regressed =
          incomingProgress !== undefined &&
          existingProgress !== undefined &&
          incomingProgress < existingProgress;
        canUpdate = !regressed && safeStringify(existingArgs) !== safeStringify(incomingArgs);
      }
    } else if (incomingName !== "" && entry.toolCall.name === incomingName) {
      const sameArguments = safeStringify(existingArgs) === safeStringify(incomingArgs);
      matches = sameArguments || (!hasExistingArgs && hasIncomingArgs);
      canUpdate = matches && !hasExistingArgs && hasIncomingArgs;
    }

    if (!matches) {
      continue;
    }
    if (!canUpdate) {
      return { entries, matched: true };
    }

    const nextToolCall = {
      ...entry.toolCall,
      id: incomingId || entry.toolCall.id,
      name: incomingName || entry.toolCall.name,
      arguments: incomingArgs,
    } as ToolCall;
    const next = entries.slice();
    next[index] = {
      ...entry,
      toolCall: nextToolCall,
      summary: summarizeToolCall(nextToolCall),
      text: safeStringify(nextToolCall.arguments),
    };
    return { entries: next, matched: true };
  }

  return { entries, matched: false };
}

// Hosted-search blocks stream before the text that cites them; once the
// segment has assistant text, backfill citation sources into source-less
// search entries.
function enrichSegmentHostedSearches(entries: ChatEntry[]): ChatEntry[] {
  const start = segmentStartIndex(entries);

  // Cheap pre-check: without a source-less search there is nothing to
  // enrich, and this runs after every token append.
  let hasSourcelessSearch = false;
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind === "hosted_search" && entry.hostedSearch.sources.length === 0) {
      hasSourcelessSearch = true;
      break;
    }
  }
  if (!hasSourcelessSearch) {
    return entries;
  }

  let allText = "";
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant") {
      allText += entry.text;
    }
  }
  if (allText === "") {
    return entries;
  }

  let next: ChatEntry[] | null = null;
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind !== "hosted_search" || entry.hostedSearch.sources.length > 0) {
      continue;
    }

    let nextSearchIndex = entries.length;
    for (let probe = index + 1; probe < entries.length; probe += 1) {
      if (entries[probe]?.kind === "hosted_search") {
        nextSearchIndex = probe;
        break;
      }
    }

    let nearbyText = "";
    for (let probe = index + 1; probe < nextSearchIndex; probe += 1) {
      const textEntry = entries[probe];
      if (textEntry?.kind === "assistant") {
        nearbyText += textEntry.text;
      }
    }

    const enriched = enrichHostedSearchBlockWithText(entry.hostedSearch, nearbyText || allText);
    if (enriched.sources.length === entry.hostedSearch.sources.length) {
      continue;
    }

    if (!next) {
      next = entries.slice();
    }
    next[index] = { ...entry, hostedSearch: enriched };
  }

  return next ?? entries;
}

function withEntries(turn: Turn, entries: ChatEntry[]): Turn {
  return entries === turn.entries ? turn : { ...turn, entries };
}

function applyTokenEvent(turn: Turn, event: Extract<ChatEvent, { type: "token" }>): Turn {
  if (isCheckpointTokenEvent(event)) {
    const checkpoint = normalizeCheckpointEntry({
      id: event.checkpoint?.summaryId,
      content: event.text,
      timestamp: event.checkpoint?.timestamp,
      summaryMeta: {
        coveredMessageCount: event.checkpoint?.coveredMessageCount,
        generatedBy: event.checkpoint?.generatedBy,
      },
      checkpoint: event.checkpoint,
      fallbackId: `${turnNamespace(turn)}:cp:${countTurnEntries(
        turn.entries,
        (entry) => entry.kind === "checkpoint",
      )}`,
    });
    if (
      !checkpoint ||
      turn.entries.some(
        (entry) => entry.kind === "checkpoint" && entry.summaryId === checkpoint.summaryId,
      )
    ) {
      return turn;
    }
    return withEntries(turn, [...turn.entries, checkpoint]);
  }

  const text = stripRecoveredToolCallMarkup(event.text ?? "");
  const round = readRound(event.round);
  const meta = buildAssistantMeta({
    provider: event.provider,
    model: event.model,
    api: event.api,
    stopReason: event.stopReason,
    usage: event.usage,
  });

  if (text === "" && !meta) {
    return turn;
  }

  const entries = turn.entries;
  const tail = entries.at(-1);
  const assistantIndex =
    tail?.kind === "assistant" && (round === undefined || tail.round === round)
      ? entries.length - 1
      : text === ""
        ? findLastSegmentAssistantIndex(entries, round)
        : -1;
  if (assistantIndex >= 0) {
    const target = entries[assistantIndex];
    if (target?.kind !== "assistant") return turn;
    const next = entries.slice();
    next[assistantIndex] = {
      ...target,
      text: target.text + text,
      round: round ?? target.round,
      meta: meta ? { ...(target.meta ?? {}), ...meta } : target.meta,
    };
    return withEntries(turn, enrichSegmentHostedSearches(next));
  }

  const occurrence = countSegmentEntries(
    entries,
    (entry) => entry.kind === "assistant" && entry.round === round,
  );
  const next: ChatEntry[] = [
    ...entries,
    {
      id: `${turnNamespace(turn)}:a:${round ?? 0}:${occurrence}`,
      kind: "assistant",
      text,
      round,
      meta,
    },
  ];
  return withEntries(turn, enrichSegmentHostedSearches(next));
}

function applyThinkingEvent(turn: Turn, event: Extract<ChatEvent, { type: "thinking" }>): Turn {
  const text = stripRecoveredToolCallMarkup(event.text ?? "");
  if (text === "") {
    return turn;
  }
  const round = readRound(event.round);
  const entries = turn.entries;
  const last = entries.at(-1);
  if (last?.kind === "thinking" && last.round === round) {
    return withEntries(turn, [...entries.slice(0, -1), { ...last, text: last.text + text }]);
  }
  const occurrence = countSegmentEntries(
    entries,
    (entry) => entry.kind === "thinking" && entry.round === round,
  );
  return withEntries(turn, [
    ...entries,
    {
      id: `${turnNamespace(turn)}:th:${round ?? 0}:${occurrence}`,
      kind: "thinking",
      round,
      text,
    },
  ]);
}

function applyToolCallEvent(
  turn: Turn,
  event: Extract<ChatEvent, { type: "tool_call" | "tool_call_delta" }>,
): Turn {
  const round = readRound(event.round);
  const eventToolCall = normalizeToolCallLike(event);
  const merged = mergeSegmentToolCallArguments(turn.entries, {
    id: eventToolCall.id,
    name: eventToolCall.name,
    arguments: eventToolCall.arguments,
    round,
  });
  if (merged.matched) {
    return withEntries(turn, merged.entries);
  }

  const explicitId = readString(eventToolCall.id).trim();
  const baseId = explicitId
    ? `${turnNamespace(turn)}:tc:${round ?? 0}:${explicitId}`
    : `${turnNamespace(turn)}:tc:${round ?? 0}:${readString(eventToolCall.name).trim() || "Tool"}:${hashValue(
        normalizeToolArguments(eventToolCall.arguments),
      )}`;
  const occurrence = countTurnEntries(
    turn.entries,
    (entry) => entry.kind === "tool_call" && entry.id.startsWith(baseId),
  );
  const stableId = `${baseId}:${occurrence}`;

  return withEntries(turn, [
    ...turn.entries,
    buildToolCallEntry(
      {
        id: eventToolCall.id,
        name: eventToolCall.name,
        arguments: eventToolCall.arguments,
      },
      round,
      { entryId: stableId, fallbackToolCallId: stableId },
    ),
  ]);
}

function applyToolResultEvent(
  turn: Turn,
  event: Extract<ChatEvent, { type: "tool_result" }>,
): Turn {
  const round = readRound(event.round);
  const resultToolCall = normalizeToolCallLike(event);
  const hasResultToolCallArgs = recordHasEntries(normalizeToolArguments(resultToolCall.arguments));
  const merged = mergeSegmentToolCallArguments(turn.entries, {
    id: resultToolCall.id,
    name: resultToolCall.name,
    arguments: resultToolCall.arguments,
    round,
  });
  const entries = merged.entries;
  if (
    hasSegmentEntry(entries, (entry) =>
      isMatchingToolResultEntry(entry, {
        toolCallId: resultToolCall.id ?? event.id,
        toolName: resultToolCall.name ?? event.name,
        content: event.content,
        isError: event.isError,
        round,
      }),
    )
  ) {
    return withEntries(turn, entries);
  }

  const explicitId = readString(resultToolCall.id ?? event.id).trim();
  const baseId = explicitId
    ? `${turnNamespace(turn)}:tr:${round ?? 0}:${explicitId}`
    : `${turnNamespace(turn)}:tr:${round ?? 0}:${readString(resultToolCall.name ?? event.name).trim() || "Tool"}:${
        event.isError ? "error" : "ok"
      }:${hashValue(event.content)}`;
  const occurrence = countTurnEntries(
    turn.entries,
    (entry) => entry.kind === "tool_result" && entry.id.startsWith(baseId),
  );
  const stableId = `${baseId}:${occurrence}`;
  const shouldPrependToolCall =
    hasResultToolCallArgs &&
    !merged.matched &&
    !hasSegmentEntry(entries, (entry) =>
      isMatchingToolCallEntry(entry, {
        id: resultToolCall.id,
        name: resultToolCall.name,
        arguments: resultToolCall.arguments,
        round,
      }),
    );

  return withEntries(turn, [
    ...entries,
    ...(shouldPrependToolCall
      ? [
          buildToolCallEntry(
            {
              id: resultToolCall.id,
              name: resultToolCall.name,
              arguments: resultToolCall.arguments,
            },
            round,
            {
              entryId: `${stableId}:tc`,
              fallbackToolCallId: `${stableId}:tc`,
            },
          ),
        ]
      : []),
    buildToolResultEntry(
      {
        toolCallId: resultToolCall.id ?? event.id,
        toolName: resultToolCall.name ?? event.name,
        content: event.content,
        details: event.details,
        isError: event.isError,
      },
      round,
      { entryId: stableId, fallbackToolCallId: stableId },
    ),
  ]);
}

function applyHostedSearchEvent(
  turn: Turn,
  event: Extract<ChatEvent, { type: "hosted_search" }>,
): Turn {
  const round = readRound(event.round);
  const hostedSearch = normalizeHostedSearchBlock({
    type: "hostedSearch",
    id: event.id,
    provider: event.provider,
    status: event.status,
    queries: event.queries,
    sources: event.sources,
    updatedAt: event.updatedAt,
  });
  if (!hostedSearch) return turn;

  const entries = turn.entries;
  const start = segmentStartIndex(entries);
  for (let index = entries.length - 1; index >= start; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === "hosted_search" &&
      entry.round === round &&
      entry.hostedSearch.id === hostedSearch.id
    ) {
      const next = entries.slice();
      next[index] = {
        ...entry,
        hostedSearch: mergeHostedSearchBlocks(entry.hostedSearch, hostedSearch),
      };
      return withEntries(turn, enrichSegmentHostedSearches(next));
    }
  }

  const baseId = `${turnNamespace(turn)}:hs:${round ?? 0}:${
    readString(hostedSearch.id).trim() || hashValue(hostedSearch.queries)
  }`;
  const occurrence = countTurnEntries(
    entries,
    (entry) => entry.kind === "hosted_search" && entry.id.startsWith(baseId),
  );
  const next: ChatEntry[] = [
    ...entries,
    buildHostedSearchEntry(hostedSearch, round, {
      entryId: occurrence === 0 ? baseId : `${baseId}:${occurrence}`,
    }),
  ];
  return withEntries(turn, enrichSegmentHostedSearches(next));
}

function applyErrorEvent(turn: Turn, event: Extract<ChatEvent, { type: "error" }>): Turn {
  const round = readRound(event.round);
  const rawMessage = event.message ?? "";
  const message = formatLiveErrorMessage(rawMessage.trim() || "Request failed", false);
  if (isAbortLikeError(message)) {
    return turn;
  }
  const alreadyShown = turn.entries.some((entry) => {
    if (entry.kind === "error" || entry.kind === "assistant") {
      return entry.text.trim() === message;
    }
    return false;
  });
  if (alreadyShown) {
    return turn;
  }
  const text = `${segmentHasAssistantText(turn.entries) ? "\n\n" : ""}${message}`;
  return withEntries(turn, [
    ...turn.entries,
    {
      id: `${turnNamespace(turn)}:err:${round ?? 0}:${hashText(message)}`,
      kind: "assistant",
      round,
      text,
    },
  ]);
}

// Assistant-side stream events; user_message routing lives in the store (it
// picks the turn by client_request_id / run_id before any reducer runs).
export function applyEventToTurn(turn: Turn, event: ChatEvent): Turn {
  switch (event.type) {
    case "token":
      return applyTokenEvent(turn, event);
    case "thinking":
      return applyThinkingEvent(turn, event);
    case "tool_call":
    case "tool_call_delta":
      return applyToolCallEvent(turn, event);
    case "tool_result":
      return applyToolResultEvent(turn, event);
    case "hosted_search":
      return applyHostedSearchEvent(turn, event);
    case "error":
      return applyErrorEvent(turn, event);
    default:
      return turn;
  }
}

// Rebuilds a turn's content from a runtime snapshot (late join / reconnect
// mid-run). The rebuild targets the existing turn object: the turn key and an
// already-present user bubble keep their identity, so nothing remounts.
export function rebuildTurnFromSnapshot(turn: Turn, parsed: ChatEntry[]): Turn {
  const ns = turnNamespace(turn);
  // Index the delta-built tool calls: the snapshot's content is debounced
  // producer state and can lag the live delta stream, so a rebuild must never
  // roll a tool call's args back to a lower progress.
  const existingToolCalls = new Map<string, ChatEntry & { kind: "tool_call" }>();
  for (const entry of turn.entries) {
    if (entry.kind === "tool_call" && entry.toolCall.id) {
      existingToolCalls.set(entry.toolCall.id, entry);
    }
  }
  let user = turn.user;
  const entries: ChatEntry[] = [];
  for (const entry of parsed) {
    if (entry.kind === "user") {
      if (!user) {
        user = { ...entry, id: seededUserEntryId(turn.runId || turn.key) };
      } else if (entry.messageId && user.messageId !== entry.messageId) {
        user = { ...user, messageId: entry.messageId };
      }
      continue;
    }
    // Snapshot entries carry runtime-assigned ids that are stable per run;
    // prefixing with the turn namespace keeps them from colliding with other
    // runs while staying identical across repeated snapshots.
    let merged = entry;
    if (entry.kind === "tool_call") {
      const prev = existingToolCalls.get(entry.toolCall.id);
      if (prev) {
        const prevProgress = toolArgsProgress(
          prev.toolCall.name,
          normalizeToolArguments(prev.toolCall.arguments),
        );
        const snapshotProgress = toolArgsProgress(
          entry.toolCall.name,
          normalizeToolArguments(entry.toolCall.arguments),
        );
        if (
          prevProgress !== undefined &&
          snapshotProgress !== undefined &&
          snapshotProgress < prevProgress
        ) {
          merged = { ...entry, toolCall: prev.toolCall, summary: prev.summary, text: prev.text };
        }
      }
    }
    entries.push({ ...merged, id: `${ns}:s:${entry.id}` } as ChatEntry);
  }
  if (user === turn.user && entries.length === 0 && turn.entries.length === 0) {
    return turn;
  }
  // The snapshot is complete through its as_of_seq: a rebuild from it clears
  // any staleness a snapshot-less reset marked on this turn.
  return { ...turn, user, entries, contentStale: false };
}
