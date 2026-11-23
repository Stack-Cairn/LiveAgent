import type { ToolTraceItem } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import {
  type AssistantTurnLayoutEntry,
  isAgentToolName,
  resolveActiveWorkEntry,
} from "./assistantBubbleUtils";

export type WorkTraceReasoningSegment = { key: string; text: string };

/**
 * One row of the processing trace as the transcript presents it.
 *
 * - `reasoning`: every reasoning segment of the turn, merged into one row that
 *   leads the trace ("Thought for 12s"). A model that reasons before each tool
 *   call no longer interleaves a reasoning row with every batch.
 * - `activity`: a stage of consecutive tool calls. Reasoning between calls is
 *   pulled into the turn's reasoning row, so it no longer splits the stage.
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
    };

function toSegment(entry: AssistantTurnLayoutEntry): WorkTraceReasoningSegment {
  return { key: entry.key, text: entry.block.kind === "thinking" ? entry.block.text : "" };
}

function buildStageItem(stage: AssistantTurnLayoutEntry[]): WorkTraceItem {
  const items: ToolTraceItem[] = [];
  const running = new Set<string>();
  for (const entry of stage) {
    if (entry.block.kind !== "toolGroup") continue;
    items.push(...entry.block.items);
    for (const id of entry.runningToolCallIds) running.add(id);
  }
  return {
    kind: "activity",
    // The first tool group's key stays put while the stage grows, so the row
    // never remounts as later calls join it.
    key: stage[0]?.key ?? "",
    items,
    runningToolCallIds: Array.from(running),
  };
}

/**
 * Merge the layout's work entries into presentation rows. All reasoning of the
 * turn becomes one leading reasoning row (keyed by its first segment, so it
 * never remounts as later segments join). A "stage" is a maximal run of tool
 * batches, with reasoning in between treated as transparent; progress notes,
 * hosted searches, standalone tool cards and compaction seams end it.
 */
export function buildWorkTraceItems(entries: readonly AssistantTurnLayoutEntry[]): WorkTraceItem[] {
  const result: WorkTraceItem[] = [];
  const segments: WorkTraceReasoningSegment[] = [];
  let stage: AssistantTurnLayoutEntry[] = [];
  const flush = () => {
    if (stage.length > 0) result.push(buildStageItem(stage));
    stage = [];
  };
  for (const entry of entries) {
    if (entry.block.kind === "thinking") {
      segments.push(toSegment(entry));
      continue;
    }
    if (entry.block.kind === "toolGroup") {
      stage.push(entry);
      continue;
    }
    flush();
    result.push({ kind: "entry", key: entry.key, entry });
  }
  flush();
  const first = segments[0];
  if (first) result.unshift({ kind: "reasoning", key: first.key, segments });
  return result;
}

/** The work item the turn is visibly busy with right now (see resolveActiveWorkEntry). */
export function resolveActiveWorkItem(
  items: readonly WorkTraceItem[],
  entries: readonly AssistantTurnLayoutEntry[],
  activeThinkingKey: string | null,
): WorkTraceItem | null {
  const reasoning = items[0]?.kind === "reasoning" ? items[0] : null;
  if (reasoning?.segments.some((segment) => segment.key === activeThinkingKey)) return reasoning;
  const item = items.at(-1);
  if (!item || item === reasoning) return null;
  if (item.kind === "entry") return resolveActiveWorkEntry(entries) ? item : null;
  if (item.kind !== "activity") return null;
  const running = new Set(item.runningToolCallIds);
  return item.items.some((tool) => tool.toolCall.id && running.has(tool.toolCall.id)) ? item : null;
}

/**
 * Length of the reply prose at the live edge of the turn: the trailing work
 * entry when it is text. Zero when the turn is busy with anything else. The
 * status row steps aside while this keeps growing (the text itself shows the
 * turn is alive).
 */
export function trailingReplyTextLength(entries: readonly AssistantTurnLayoutEntry[]): number {
  const block = entries.at(-1)?.block;
  return block?.kind === "text" ? block.text.trim().length : 0;
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
