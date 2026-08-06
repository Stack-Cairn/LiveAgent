import {
  type AssistantMessageEventStream,
  parseJsonWithRepair,
  parseStreamingJson,
  type ToolCall,
} from "@earendil-works/pi-ai";

export type OnIncompleteToolCall = (toolCall: ToolCall, reason: string) => void;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function bufferIsCompleteJson(buffer: string): boolean {
  try {
    parseJsonWithRepair(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watches a provider event stream for tool calls whose argument JSON never
 * arrived complete — a half-streamed buffer that lenient repair would silently
 * turn into plausible-but-wrong arguments (e.g. a path cut at its first
 * segment). The wrapper never alters, reorders, or aborts events; it only
 * reports incomplete calls so the runner can refuse to execute them.
 */
export function wrapStreamWithToolCallArgumentGuard(
  source: AssistantMessageEventStream,
  onIncompleteToolCall: OnIncompleteToolCall,
): AssistantMessageEventStream {
  const rawArgumentsByContentIndex = new Map<number, string>();
  const lastDeltaByContentIndex = new Map<number, string>();
  const flagged = new Set<string>();

  const flag = (toolCall: ToolCall, reason: string) => {
    if (flagged.has(toolCall.id)) return;
    flagged.add(toolCall.id);
    onIncompleteToolCall(toolCall, reason);
  };

  const checkEndedToolCall = (contentIndex: number, toolCall: ToolCall) => {
    const buffer = rawArgumentsByContentIndex.get(contentIndex) ?? "";
    const lastDelta = lastDeltaByContentIndex.get(contentIndex) ?? "";
    rawArgumentsByContentIndex.delete(contentIndex);
    lastDeltaByContentIndex.delete(contentIndex);
    // No deltas observed (or whitespace only): the provider delivered the
    // arguments whole on the end event — nothing to distrust.
    if (!buffer.trim()) return;
    if (bufferIsCompleteJson(buffer)) return;
    const finalArguments = stableStringify(toolCall.arguments ?? {});
    // Cumulative-snapshot or duplicated-frame streams concatenate into invalid
    // JSON, but their final delta is a complete standalone copy of the
    // arguments — that stream is healthy.
    if (lastDelta.trim() && bufferIsCompleteJson(lastDelta)) {
      if (stableStringify(parseStreamingJson(lastDelta)) === finalArguments) return;
    }
    // The raw buffer never formed complete JSON. If the finalized arguments
    // equal the lenient repair of that same truncated buffer, the provider had
    // no independent complete source — the call is genuinely truncated. If
    // they differ, the end event carried its own complete arguments (e.g.
    // openai-responses `arguments.done`) and the buffer mismatch is benign.
    const repaired = parseStreamingJson(buffer);
    if (stableStringify(repaired) === finalArguments) {
      flag(toolCall, "the argument JSON stream ended before it was complete");
    }
  };

  const endedByToolCallId = new Set<string>();

  const checkDanglingToolCalls = (content: ReadonlyArray<{ type: string }>) => {
    for (const block of content) {
      if (block.type !== "toolCall") continue;
      const toolCall = block as unknown as ToolCall;
      if (!endedByToolCallId.has(toolCall.id)) {
        flag(toolCall, "the stream ended before this tool call finished streaming");
      }
    }
  };

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        switch (event.type) {
          case "toolcall_start": {
            rawArgumentsByContentIndex.set(event.contentIndex, "");
            lastDeltaByContentIndex.delete(event.contentIndex);
            break;
          }
          case "toolcall_delta": {
            const buffer = rawArgumentsByContentIndex.get(event.contentIndex) ?? "";
            rawArgumentsByContentIndex.set(event.contentIndex, buffer + event.delta);
            if (event.delta) {
              lastDeltaByContentIndex.set(event.contentIndex, event.delta);
            }
            break;
          }
          case "toolcall_end": {
            endedByToolCallId.add(event.toolCall.id);
            checkEndedToolCall(event.contentIndex, event.toolCall);
            break;
          }
          case "done": {
            checkDanglingToolCalls(event.message.content);
            break;
          }
          default:
            break;
        }
        yield event;
      }
    },
    result() {
      return source.result();
    },
  } as unknown as AssistantMessageEventStream;
}
