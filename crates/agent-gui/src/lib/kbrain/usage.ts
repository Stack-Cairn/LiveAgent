import type { AssistantMessage } from "@liveagent/app/lib/agentTypes";
import type { KBrainUsage } from "./types";

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Maps a K-brain usage report to LiveAgent's usage shape.
 *
 * K-brain's input_tokens already include cache reads and cache writes, while
 * LiveAgent keeps `input` exclusive of both (the context ring and token stats
 * add the cache fields back). Subtracting here keeps a cached prompt from
 * being counted twice, the same split K-brain's trajectory projection uses.
 */
export function kbrainUsage(value?: KBrainUsage | null): AssistantMessage["usage"] {
  const promptTokens = count(value?.input_tokens);
  const output = count(value?.output_tokens);
  const cacheRead = count(value?.cached_tokens);
  const cacheWrite = count(value?.cache_write_tokens);
  return {
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    totalTokens: promptTokens + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** True when a usage.updated payload carries at least one token count. */
export function hasKBrainUsage(value?: KBrainUsage | null): value is KBrainUsage {
  return (
    count(value?.input_tokens) +
      count(value?.output_tokens) +
      count(value?.cached_tokens) +
      count(value?.cache_write_tokens) >
    0
  );
}
