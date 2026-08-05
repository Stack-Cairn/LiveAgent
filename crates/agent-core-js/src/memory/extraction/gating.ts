// Language-neutral pre-flight heuristics: decide whether a post-turn
// extraction run is worth an LLM round at all. Pure functions over injected
// state — the controller owns throttling state and passes it in, which is
// what makes the claim atomic (no awaits between check and claim).

import {
  EXTRACTION_MIN_INTERVAL_MS,
  GATING_ACK_PREFIXES,
  GATING_CONFIRMATION_WORDS,
  GATING_GREETING_PREFIXES,
  GATING_MIN_USER_TEXT_GRAPHEMES,
  GATING_SHORT_ACK_GRAPHEME_LIMIT,
  GATING_THANKS_PREFIXES,
} from "../config";

export type ExtractionSkipReason =
  | "empty-user-message"
  | "user-message-too-short"
  | "punctuation-only-user-message"
  | "greeting"
  | "acknowledgement-thanks"
  | "acknowledgement-ok"
  | "throttled-min-interval"
  | "no-new-user-message";

let segmenter: Intl.Segmenter | undefined;

export function graphemeLength(text: string): number {
  try {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0;
    for (const _ of segmenter.segment(text)) count += 1;
    return count;
  } catch {
    return Array.from(text).length;
  }
}

function normalizeForMatch(text: string): string {
  return text.trim().toLocaleLowerCase();
}

function hasPrefix(text: string, prefixes: readonly string[]): boolean {
  const normalized = normalizeForMatch(text);
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

/** Short yes/no style replies ("是的", "yes") that may answer a pending
 *  memory-confirmation question and therefore bypass the length gates. */
export function isShortMemoryConfirmationText(text: string): boolean {
  const normalized = text
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s"'“”‘’`.,!?;:，。！？；：、]/gu, "");
  return GATING_CONFIRMATION_WORDS.includes(normalized);
}

export type ExtractionGateInput = {
  latestUserText: string;
  /** Timestamp of the last completed/claimed run for this conversation. */
  lastRunAt?: number;
  /** Identity key of the last user message an extraction already covered. */
  lastExtractedUserKey?: string;
  /** Identity key of the current latest user message. */
  currentUserKey?: string;
  /** Whether an unreviewed non-daily candidate exists (confirmation carve-out).
   *  Pass undefined when unknown — short confirmations are then deferred, not
   *  rejected (the engine re-checks after loading candidates). */
  hasConfirmableHypothesis?: boolean;
  now?: number;
};

export function extractionSkipReason(input: ExtractionGateInput): ExtractionSkipReason | null {
  const text = input.latestUserText.trim();
  if (text.length === 0) return "empty-user-message";

  if (
    input.currentUserKey !== undefined &&
    input.lastExtractedUserKey !== undefined &&
    input.currentUserKey === input.lastExtractedUserKey
  ) {
    return "no-new-user-message";
  }

  const mayAnswerMemoryConfirmation =
    input.hasConfirmableHypothesis !== false && isShortMemoryConfirmationText(text);

  const graphemes = graphemeLength(text);
  if (graphemes < GATING_MIN_USER_TEXT_GRAPHEMES && !mayAnswerMemoryConfirmation) {
    return "user-message-too-short";
  }

  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (stripped.length === 0) return "punctuation-only-user-message";

  // CJK has no ASCII word boundary; rely on prefix match plus a grapheme cap
  // so that "谢谢你，请以后默认用中文" still reaches the LLM.
  const shortEnough = graphemes < GATING_SHORT_ACK_GRAPHEME_LIMIT;
  if (shortEnough && hasPrefix(text, GATING_GREETING_PREFIXES)) return "greeting";
  if (shortEnough && hasPrefix(text, GATING_THANKS_PREFIXES)) return "acknowledgement-thanks";
  if (shortEnough && hasPrefix(text, GATING_ACK_PREFIXES) && !mayAnswerMemoryConfirmation) {
    return "acknowledgement-ok";
  }

  const now = input.now ?? Date.now();
  if (input.lastRunAt !== undefined && now - input.lastRunAt < EXTRACTION_MIN_INTERVAL_MS) {
    return "throttled-min-interval";
  }

  return null;
}

/** True when the only thing standing between this text and a run is whether a
 *  confirmable unreviewed hypothesis exists — the engine defers the decision
 *  until candidates are loaded instead of rejecting outright. */
export function isConfirmationDeferral(
  reason: ExtractionSkipReason | null,
  latestUserText: string,
): boolean {
  return (
    (reason === "user-message-too-short" || reason === "acknowledgement-ok") &&
    isShortMemoryConfirmationText(latestUserText)
  );
}
