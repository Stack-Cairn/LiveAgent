const MEDIUM_STREAM_CHARACTERS = 12_000;
const LARGE_STREAM_CHARACTERS = 48_000;
const VERY_LARGE_STREAM_CHARACTERS = 160_000;

/**
 * Keep short replies feeling immediate, then progressively trade visual
 * update frequency for main-thread headroom as the mutable Markdown tail
 * becomes more expensive to parse and lay out.
 */
export function resolveStreamingRenderDelay(characterCount: number): number {
  if (characterCount < MEDIUM_STREAM_CHARACTERS) return 0;
  if (characterCount < LARGE_STREAM_CHARACTERS) return 32;
  if (characterCount < VERY_LARGE_STREAM_CHARACTERS) return 64;
  return 96;
}
