// Single source of truth for the memory domain: enums, decision shapes, and
// the confidence contract. Every layer (extraction, organizer, MemoryManager
// tool, settings panels, gateway web mirror) derives from this module —
// nothing else may re-declare these unions.
//
// NOTE: contract ENFORCEMENT lives in Rust (mutations/evidence.rs). The
// constants here exist so prompts, tool descriptions, and tests state the same
// numbers the store applies.

export const MEMORY_SCOPES = ["global", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
/** Scope filter accepted by read paths: auto searches project then global. */
export type MemoryScopeFilter = MemoryScope | "auto";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
/** Daily journals are a read/list/search facet, never a writable type. */
export type MemorySearchType = MemoryType | "daily";

export const MEMORY_CONFIDENCES = ["high", "medium", "low", "unknown"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export const MEMORY_UPDATE_MODES = ["replace", "merge", "append"] as const;
export type MemoryUpdateMode = (typeof MEMORY_UPDATE_MODES)[number];

export const MEMORY_MANAGER_ACTIONS = [
  "list",
  "read",
  "search",
  "write",
  "update",
  "delete",
  "accept",
] as const;
export type MemoryManagerAction = (typeof MEMORY_MANAGER_ACTIONS)[number];
export const MEMORY_MANAGER_RO_ACTIONS = ["list", "read", "search"] as const;

/** high requires a >=5-char verbatim quote, medium a non-empty one; the store
 *  downgrades one step per violated rule and records auto_downgraded. */
export const CONFIDENCE_CONTRACT = {
  highMinQuoteChars: 5,
  mediumMinQuoteChars: 1,
} as const;

/** Structured evidence attached to write/update mutations. Rust renders the
 *  canonical frontmatter from these fields; no TS serializer exists. */
export type MemoryEvidenceFields = {
  confidence?: string;
  sourceQuote?: string;
  reasoning?: string;
  aliases?: string[];
  conflictsWith?: string[];
  supersedes?: string;
  overrideReject?: string;
};

export function normalizeMemoryConfidence(raw: unknown): MemoryConfidence {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "unknown";
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "global" || value === "project";
}

export function isMemoryType(value: unknown): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value as string);
}

// ---------------------------------------------------------------------------
// Extraction plan protocol (SubmitMemoryPlan tool)
// ---------------------------------------------------------------------------

export const EXTRACTION_PLAN_ACTIONS = [
  "write",
  "update",
  "accept",
  "delete",
  "append_daily",
] as const;
export type ExtractionPlanAction = (typeof EXTRACTION_PLAN_ACTIONS)[number];

/** Raw plan item as submitted by the extraction model (snake_case fields
 *  mirror the tool schema; everything is optional until validated). */
export type ExtractionPlanItem = {
  action?: string;
  slug?: string;
  scope?: string;
  type?: string;
  description?: string;
  body?: string;
  mode?: string;
  confidence?: string;
  source_quote?: string;
  reasoning?: string;
  aliases?: string[];
  supersedes?: string;
  conflicts_with?: string[];
  override_reject?: string;
};

export type ExtractionPlanSubmission = {
  status?: string;
  note?: string;
  items?: ExtractionPlanItem[];
};

export type ValidatedPlanItem = {
  action: ExtractionPlanAction;
  slug: string;
  scope?: MemoryScope;
  type?: MemoryType;
  description?: string;
  body?: string;
  mode?: MemoryUpdateMode;
  evidence?: MemoryEvidenceFields;
};

export const PLAN_ITEM_REJECTION_CODES = [
  "invalid-action",
  "missing-slug",
  "missing-type-for-write",
  "missing-description-for-write",
  "missing-body-for-write",
  "invalid-scope",
  "project-scope-gate",
  "rejected-slug-no-override",
  "duplicate-slug-in-plan",
  "already-written-this-turn",
  "empty-daily-body",
  "body-too-large",
] as const;
export type PlanItemRejectionCode = (typeof PLAN_ITEM_REJECTION_CODES)[number];

export type PlanItemRejection = {
  index: number;
  code: PlanItemRejectionCode;
  message: string;
};

// ---------------------------------------------------------------------------
// Batch persistence (memory_apply_batch) — the single mutation pathway shared
// by extraction, organizer, and manual apply.
// ---------------------------------------------------------------------------

export const APPLY_DECISION_OPS = ["upsert", "update", "delete", "accept"] as const;
export type ApplyDecisionOp = (typeof APPLY_DECISION_OPS)[number];

export type ApplyDecision = {
  op: ApplyDecisionOp;
  slug: string;
  scope?: MemoryScope;
  workdirHash?: string;
  memoryType?: MemoryType;
  description?: string;
  body?: string;
  mode?: MemoryUpdateMode;
  reason?: string;
  groupId?: string;
  evidence?: MemoryEvidenceFields;
};

// ---------------------------------------------------------------------------
// Organizer domain
// ---------------------------------------------------------------------------

export const ORGANIZER_ACTIONS = [
  "keep",
  "merge_into",
  "delete",
  "mark_review",
  "rewrite_hint",
] as const;
export type OrganizerAction = (typeof ORGANIZER_ACTIONS)[number];

export const ORGANIZER_MODES = ["conservative", "standard", "aggressive"] as const;
export type OrganizerMode = (typeof ORGANIZER_MODES)[number];

export const ORGANIZER_SCOPES = ["all", "global", "projects", "current-project"] as const;
export type OrganizerScope = (typeof ORGANIZER_SCOPES)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ORGANIZE_PHASES = ["scan", "cluster", "plan", "gate", "apply"] as const;
export type OrganizePhase = (typeof ORGANIZE_PHASES)[number];

export const REJECTION_BUCKET_KEYS = [
  "reviewedProtected",
  "lowConfidence",
  "crossType",
  "crossScope",
  "reviewRequiredByLlm",
  "missingPayload",
  "unsupported",
] as const;
export type RejectionBucketKey = (typeof REJECTION_BUCKET_KEYS)[number];
export type RejectionBuckets = Record<RejectionBucketKey, number>;

// ---------------------------------------------------------------------------
// Reviewer mode (extraction strictness)
// ---------------------------------------------------------------------------

export const MEMORY_REVIEWER_MODES = ["strict", "standard", "lenient"] as const;
export type MemoryReviewerMode = (typeof MEMORY_REVIEWER_MODES)[number];
export const DEFAULT_MEMORY_REVIEWER_MODE: MemoryReviewerMode = "standard";
