// Row height estimates for the transcript virtualizer, derived from cheap
// per-row metadata computed once at row build time. Estimates only ever apply
// to rows that have never been measured — the virtualizer's measurement cache
// is keyed by row key and survives folding — but under-estimation is what
// causes blank regions and post-measure jumps while scrolling unmeasured
// history, so the model is content-shaped: prose by character count, code
// fences by line count (one fence line ≈ one rendered line plus block
// chrome), tools and thinking blocks as collapsed headers (their bodies stay
// unmounted until first expand).

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// Bubble padding plus one line per ~60 chars of prompt text, plus a card per
// attachment.
export function estimateUserRowHeight(textChars: number, attachmentCount = 0): number {
  return clamp(72 + 22 * Math.ceil(textChars / 60) + 64 * attachmentCount, 80, 600);
}

export type AssistantRowEstimateStats = {
  proseChars: number;
  codeLines: number;
  codeFences: number;
  toolCount: number;
  thinkingCount: number;
};

// Avatar row base, prose at ~3.2 chars/px, code at ~20px per line plus block
// chrome per fence, a collapsed header per tool and thinking block. The cap
// is generous on purpose: over-estimates cost one cheap correction, while
// under-estimates are the flash-causing direction.
export function estimateAssistantRowHeight(stats: AssistantRowEstimateStats): number {
  const proseHeight = Math.min(900, 28 + stats.proseChars / 3.2);
  const codeHeight = stats.codeFences * 58 + stats.codeLines * 20;
  return clamp(
    64 + proseHeight + codeHeight + 36 * stats.toolCount + 32 * stats.thinkingCount,
    80,
    6000,
  );
}

export type EstimateTextMeasurement = {
  proseChars: number;
  codeLines: number;
  codeFences: number;
};

// Single cheap pass over a markdown text block: lines between ``` fences
// count as code lines, everything else as prose characters. Runs once per
// row build (only for rows the row cache missed), so a line split is fine.
export function measureEstimateText(text: string): EstimateTextMeasurement {
  if (!text.includes("```")) {
    return { proseChars: text.length, codeLines: 0, codeFences: 0 };
  }

  let proseChars = 0;
  let codeLines = 0;
  let codeFences = 0;
  let inCode = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (!inCode) codeFences += 1;
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines += 1;
    } else {
      proseChars += line.length + 1;
    }
  }
  return { proseChars, codeLines, codeFences };
}

// Collapsed checkpoint/summary card.
export const CHECKPOINT_ROW_ESTIMATE_PX = 88;
