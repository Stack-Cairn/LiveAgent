import type { ToolTraceItem } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import {
  type AssistantTurnLayoutEntry,
  isAgentToolName,
  resolveActiveWorkEntry,
} from "./assistantBubbleUtils";

export type WorkTraceReasoningSegment = { key: string; text: string };

/**
 * Reasoning folded into a tool activity group: one slot per uninterrupted
 * stretch, placed before the tool call at `beforeIndex` (or after the last
 * call when it equals the number of calls).
 */
export type WorkTraceReasoningSlot = {
  key: string;
  beforeIndex: number;
  segments: WorkTraceReasoningSegment[];
};

/**
 * One row of the processing trace as the transcript presents it.
 *
 * - `reasoning`: a stretch of consecutive reasoning segments with no tool call
 *   next to it (before the first progress note, or right before the answer).
 * - `activity`: a stage of tool calls together with the reasoning between and
 *   around them, in chronological order. Reasoning that sits between tool calls
 *   no longer splits the stage into alternating rows.
 * - `entry`: everything else, rendered as before (progress notes, hosted
 *   searches, standalone tool cards such as subagents, compaction seams).
 */
export type WorkTraceItem =
  | { kind: "entry"; key: string; entry: AssistantTurnLayoutEntry }
  | { kind: "reasoning"; key: string; segments: WorkTraceReasoningSegment[] }
  | {
      kind: "activity";
      key: string;
      items: ToolTraceItem[];
      runningToolCallIds: string[];
      reasoning: WorkTraceReasoningSlot[];
    };

function isStageEntry(entry: AssistantTurnLayoutEntry) {
  return entry.block.kind === "thinking" || entry.block.kind === "toolGroup";
}

function toSegment(entry: AssistantTurnLayoutEntry): WorkTraceReasoningSegment {
  return { key: entry.key, text: entry.block.kind === "thinking" ? entry.block.text : "" };
}

function buildStageItem(stage: AssistantTurnLayoutEntry[]): WorkTraceItem {
  const firstToolGroup = stage.find((entry) => entry.block.kind === "toolGroup");
  if (!firstToolGroup) {
    return { kind: "reasoning", key: stage[0]?.key ?? "", segments: stage.map(toSegment) };
  }
  const items: ToolTraceItem[] = [];
  const running = new Set<string>();
  const reasoning: WorkTraceReasoningSlot[] = [];
  for (const entry of stage) {
    if (entry.block.kind === "toolGroup") {
      items.push(...entry.block.items);
      for (const id of entry.runningToolCallIds) running.add(id);
      continue;
    }
    const previous = reasoning.at(-1);
    if (previous && previous.beforeIndex === items.length) {
      previous.segments.push(toSegment(entry));
    } else {
      reasoning.push({ key: entry.key, beforeIndex: items.length, segments: [toSegment(entry)] });
    }
  }
  return {
    kind: "activity",
    // The first tool group's key stays put while the stage grows, so the row
    // never remounts as later calls and reasoning join it.
    key: firstToolGroup.key,
    items,
    runningToolCallIds: Array.from(running),
    reasoning,
  };
}

/**
 * Merge the layout's work entries into presentation rows. A "stage" is a
 * maximal run of reasoning segments and tool batches; progress notes, hosted
 * searches, standalone tool cards and compaction seams end it. A stage with
 * at least one tool call becomes one activity group; a stage of reasoning
 * alone becomes one reasoning row.
 */
export function buildWorkTraceItems(entries: readonly AssistantTurnLayoutEntry[]): WorkTraceItem[] {
  const result: WorkTraceItem[] = [];
  let stage: AssistantTurnLayoutEntry[] = [];
  const flush = () => {
    if (stage.length > 0) result.push(buildStageItem(stage));
    stage = [];
  };
  for (const entry of entries) {
    if (isStageEntry(entry)) {
      stage.push(entry);
      continue;
    }
    flush();
    result.push({ kind: "entry", key: entry.key, entry });
  }
  flush();
  return result;
}

/** The work item the turn is visibly busy with right now (see resolveActiveWorkEntry). */
export function resolveActiveWorkItem(
  items: readonly WorkTraceItem[],
  entries: readonly AssistantTurnLayoutEntry[],
  activeThinkingKey: string | null,
): WorkTraceItem | null {
  const item = items.at(-1);
  if (!item) return null;
  if (item.kind === "entry") return resolveActiveWorkEntry(entries) ? item : null;
  if (item.kind === "reasoning") {
    return item.segments.some((segment) => segment.key === activeThinkingKey) ? item : null;
  }
  const running = new Set(item.runningToolCallIds);
  const hasRunningTool = item.items.some(
    (tool) => tool.toolCall.id && running.has(tool.toolCall.id),
  );
  const hasActiveReasoning = item.reasoning.some((slot) =>
    slot.segments.some((segment) => segment.key === activeThinkingKey),
  );
  return hasRunningTool || hasActiveReasoning ? item : null;
}

/** Number of tool calls the turn made, for the trace's summary header. */
export function countWorkTraceToolCalls(entries: readonly AssistantTurnLayoutEntry[]) {
  let count = 0;
  for (const entry of entries) {
    if (entry.block.kind === "toolGroup") count += entry.block.items.length;
    else if (entry.block.kind === "tool") count += 1;
  }
  return count;
}

/** Every reasoning segment of the trace, in order, for the summary's total. */
export function collectWorkTraceReasoning(
  entries: readonly AssistantTurnLayoutEntry[],
): WorkTraceReasoningSegment[] {
  return entries.flatMap((entry) => (entry.block.kind === "thinking" ? [toSegment(entry)] : []));
}

/** The latest tool call that is still running, for the status row's wording. */
export function findLatestRunningToolItem(
  entries: readonly AssistantTurnLayoutEntry[],
): ToolTraceItem | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.runningToolCallIds.length === 0) continue;
    const running = new Set(entry.runningToolCallIds);
    const items =
      entry.block.kind === "toolGroup"
        ? entry.block.items
        : entry.block.kind === "tool" && !isAgentToolName(entry.block.item.toolCall.name)
          ? [entry.block.item]
          : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.toolCall.id && running.has(item.toolCall.id)) return item;
    }
  }
  return null;
}
