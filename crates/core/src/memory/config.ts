// Every tunable number and locale-sensitive word list in the memory system
// lives here. No other memory module may declare a magic number.

// --- Extraction ------------------------------------------------------------

/** Hard wall-clock budget for one hidden extraction round. */
export const EXTRACTION_TIMEOUT_MS = 45_000;
/** Minimum spacing between completed extraction runs per conversation. */
export const EXTRACTION_MIN_INTERVAL_MS = 30_000;
/** How many trailing user-turns the compact extraction window keeps: one
 *  target turn plus resolution context for corrections and pronouns. */
export const EXTRACTION_TURN_WINDOW = 4;
/** Per-message and whole-window character caps for the extraction window. */
export const EXTRACTION_MESSAGE_CHAR_CAP = 2_000;
export const EXTRACTION_WINDOW_CHAR_CAP = 12_000;
/** Cap for an optional conversation-compaction summary block. */
export const EXTRACTION_SUMMARY_CHAR_CAP = 1_000;
/** How many existing entries / recent rejections the hidden prompt shows. */
export const EXTRACTION_CANDIDATE_LIMIT = 30;
export const EXTRACTION_REJECTION_DAYS = 7;
/** Max plan items accepted from a single SubmitMemoryPlan call. */
export const EXTRACTION_PLAN_ITEM_LIMIT = 8;
/** Ring cap of slugs written this turn (feeds already-written dedup). */
export const EXTRACTION_WRITTEN_SLUG_LIMIT = 16;
/** LRU cap on tracked conversations before oldest state is pruned. */
export const EXTRACTION_CONVERSATION_STATE_LIMIT = 128;

// --- Extraction gating heuristics -------------------------------------------

/** Messages shorter than this (in graphemes) are skipped unless they answer a
 *  pending memory confirmation. */
export const GATING_MIN_USER_TEXT_GRAPHEMES = 6;
/** Greetings/acks longer than this still reach the LLM (e.g. "谢谢，以后默认用中文"). */
export const GATING_SHORT_ACK_GRAPHEME_LIMIT = 24;

/** Locale-keyed prefix lists; gating builds anchored patterns from these so
 *  adding a language never means touching code. */
export const GATING_GREETING_PREFIXES: readonly string[] = [
  "你好",
  "您好",
  "哈喽",
  "早安",
  "晚安",
  "早上好",
  "晚上好",
  "hi",
  "hello",
  "hey",
];
export const GATING_THANKS_PREFIXES: readonly string[] = [
  "谢谢",
  "多谢",
  "感谢",
  "辛苦了",
  "thanks",
  "thank you",
  "ty",
  "thx",
];
export const GATING_ACK_PREFIXES: readonly string[] = [
  "好的",
  "好",
  "收到",
  "明白了",
  "明白",
  "ok",
  "okay",
  "got it",
  "sounds good",
  "sure",
];
/** Short yes/no style replies that may answer a memory confirmation question. */
export const GATING_CONFIRMATION_WORDS: readonly string[] = [
  "是",
  "是的",
  "对",
  "对的",
  "没错",
  "正确",
  "确认",
  "是这样",
  "不是",
  "不是的",
  "不对",
  "否",
  "没有",
  "yes",
  "y",
  "yep",
  "yeah",
  "correct",
  "right",
  "no",
  "n",
  "nope",
  "wrong",
  "notreally",
];

// --- Memory Index injection --------------------------------------------------

export const INDEX_MAX_PROMPT_CHARS = 16_000;
export const INDEX_MAX_ENTRIES_PER_BUCKET = 30;

// --- Store limits (mirrors Rust constants; Rust enforces) --------------------

export const MEMORY_BODY_LIMIT_BYTES = 8 * 1024;
export const MEMORY_SCOPE_ENTRY_LIMIT = 500;
export const MEMORY_DESCRIPTION_CHAR_LIMIT = 120;

// --- Organizer ---------------------------------------------------------------

/** Structural cluster size when the library is small enough to skip the
 *  LLM topic pass. */
export const ORGANIZER_STRUCTURAL_CLUSTER_SIZE = 8;
/** Max entries per LLM topic cluster. */
export const ORGANIZER_TOPIC_CLUSTER_SIZE = 12;
/** Per-entry body excerpt shown inside a cluster planning prompt. */
export const ORGANIZER_BODY_EXCERPT_CHARS = 3_000;
/** Per-entry excerpt in the global inventory / meta-cluster prompt. */
export const ORGANIZER_META_BODY_EXCERPT_CHARS = 600;
export const ORGANIZER_GLOBAL_INVENTORY_CHARS = 8_000;
/** Cap of raw model output preserved per cluster in the run report. */
export const ORGANIZER_RAW_PROTOCOL_CHARS = 4_000;
/** Never sleep longer than this between scheduler wake checks. */
export const ORGANIZER_MAX_WAKE_DELAY_MS = 60 * 60_000;

/** Quota ladder thresholds on remaining headroom (entries left in scope). */
export const QUOTA_LADDER_THRESHOLDS = {
  /** headroom > notice ⇒ normal */
  notice: 100,
  degraded: 50,
  critical: 20,
  exhausted: 5,
} as const;

// --- Settings panel ------------------------------------------------------------

/** Poll cadence for organize-run status — applied ONLY while a run is
 *  pending/running; idle panels never poll. */
export const PANEL_RUN_POLL_INTERVAL_MS = 2_000;
