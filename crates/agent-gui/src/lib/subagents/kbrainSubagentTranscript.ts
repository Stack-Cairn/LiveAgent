import type { Message as UiInputMessage } from "@liveagent/ui/lib/chat/agentTypes";
import { buildUiMessages, type UiMessage } from "@liveagent/ui/lib/chat/uiMessages";
import { convertMessages } from "../kbrain/history";
import type { KBrainMessage } from "../kbrain/types";

export type SubagentTranscriptItem = UiMessage & {
  rounds?: (NonNullable<UiMessage["rounds"]>[number] & { runningToolCallIds?: string[] })[];
};

export function lastAssistantIndex(rows: readonly { role: string }[]) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === "assistant") return index;
  }
  return -1;
}

const items = new WeakMap<readonly KBrainMessage[], Map<boolean, SubagentTranscriptItem[]>>();

/**
 * A subagent transcript as transcript rows, through the same conversion the
 * conversation history uses. While it runs, the last reply's tool calls without
 * a result are the running ones.
 */
export function subagentTranscriptItems(
  messages: readonly KBrainMessage[],
  live: boolean,
): SubagentTranscriptItem[] {
  const cached = items.get(messages)?.get(live);
  if (cached) return cached;
  const converted = convertMessages([...messages]) as unknown as UiInputMessage[];
  const rows: SubagentTranscriptItem[] = buildUiMessages(converted);
  const last = lastAssistantIndex(rows);
  const result =
    live && last >= 0
      ? rows.map((row, index) =>
          index === last && row.rounds
            ? {
                ...row,
                rounds: row.rounds.map((round) => ({
                  ...round,
                  runningToolCallIds: round.blocks.flatMap((block) =>
                    block.kind === "tool" && !block.item.toolResult && block.item.toolCall.id
                      ? [block.item.toolCall.id]
                      : [],
                  ),
                })),
              }
            : row,
        )
      : rows;
  let byLive = items.get(messages);
  if (!byLive) {
    byLive = new Map();
    items.set(messages, byLive);
  }
  byLive.set(live, result);
  return result;
}
