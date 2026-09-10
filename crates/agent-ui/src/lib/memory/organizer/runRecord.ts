// Typed organize-run report (v4). The service WRITES this shape; the panel
// READS it through readRunReport — one version check, no key-spelling probes.
// Runs written before v4 render as a legacy placeholder (summaries only).

import type { MemoryBatchResponse, MemoryOrganizeRun } from "../api";
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryScope,
  type MemoryType,
  REJECTION_BUCKET_KEYS,
  type RejectionBuckets,
  RISK_LEVELS,
  type RiskLevel,
} from "../schema";

export const ORGANIZE_RUN_REPORT_VERSION = 4;

export type OrganizerDecisionApplyStatus = "pending" | "applied" | "failed" | "skipped";

export type OrganizerSafeDecision = {
  op: "upsert" | "delete";
  slug: string;
  scope?: MemoryScope;
  workdirHash?: string;
  memoryType?: MemoryType;
  description?: string;
  body?: string;
  reason?: string;
  confidence?: number;
  riskLevel?: RiskLevel;
  requiresUserAck?: boolean;
  sourceSlugs?: string[];
  evidencePreserved?: string[];
  blockedReasons?: string[];
  groupId?: string;
  applyStatus?: OrganizerDecisionApplyStatus;
  applyError?: OrganizerReviewItem;
};

export type OrganizerReviewItem = {
  phase: "planning" | "apply" | "system";
  kind: "review" | "skipped" | "warning" | "error";
  severity: "info" | "warning" | "error";
  message: string;
  code?: string;
  slug?: string;
  op?: "upsert" | "delete";
  groupId?: string;
  decisionKey?: string;
};

export type OrganizerManualApplyStatus = "pending" | "applied" | "partial" | "failed" | "";

/** JSON-persisted manual apply state (plain arrays, not Sets). */
export type OrganizerManualApplyState = {
  status: OrganizerManualApplyStatus;
  appliedAt?: number;
  appliedDecisionKeys: string[];
  failedDecisionKeys: string[];
  selectedCount?: number;
  appliedCount?: number;
  warningCount?: number;
};

export type OrganizeRunReportV4 = {
  version: typeof ORGANIZE_RUN_REPORT_VERSION;
  clusterSummaries: string[];
  reviewItems: OrganizerReviewItem[];
  raw: Array<{ clusterId: string; text: string }>;
  safeDecisions?: OrganizerSafeDecision[];
  rejectionBuckets?: RejectionBuckets;
  compressionForecast?: { from: number; toMin: number; toMax: number };
  manualApplyState?: OrganizerManualApplyState;
};

export type OrganizeRunReport =
  | OrganizeRunReportV4
  | {
      version: "legacy";
      clusterSummaries: string[];
      reviewItems: OrganizerReviewItem[];
    };

type UnknownRecord = Record<string, unknown>;

const DECISION_OPS = ["upsert", "delete"] as const;
const DECISION_APPLY_STATUSES = ["pending", "applied", "failed", "skipped"] as const;
const REVIEW_PHASES = ["planning", "apply", "system"] as const;
const REVIEW_KINDS = ["review", "skipped", "warning", "error"] as const;
const REVIEW_SEVERITIES = ["info", "warning", "error"] as const;
const MANUAL_APPLY_STATUSES = ["pending", "applied", "partial", "failed", ""] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<const TValues extends readonly unknown[]>(
  value: unknown,
  values: TValues,
): value is TValues[number] {
  return values.includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOptional<T>(
  record: UnknownRecord,
  key: string,
  guard: (value: unknown) => value is T,
): boolean {
  return record[key] === undefined || guard(record[key]);
}

function isOrganizerReviewItem(value: unknown): value is OrganizerReviewItem {
  if (!isRecord(value)) return false;
  return (
    isOneOf(value.phase, REVIEW_PHASES) &&
    isOneOf(value.kind, REVIEW_KINDS) &&
    isOneOf(value.severity, REVIEW_SEVERITIES) &&
    typeof value.message === "string" &&
    hasOptional(value, "code", (item): item is string => typeof item === "string") &&
    hasOptional(value, "slug", (item): item is string => typeof item === "string") &&
    hasOptional(value, "op", (item): item is OrganizerSafeDecision["op"] =>
      isOneOf(item, DECISION_OPS),
    ) &&
    hasOptional(value, "groupId", (item): item is string => typeof item === "string") &&
    hasOptional(value, "decisionKey", (item): item is string => typeof item === "string")
  );
}

function isOrganizerSafeDecision(value: unknown): value is OrganizerSafeDecision {
  if (!isRecord(value)) return false;
  const isString = (item: unknown): item is string => typeof item === "string";
  const isBoolean = (item: unknown): item is boolean => typeof item === "boolean";
  const isNumber = (item: unknown): item is number => typeof item === "number";
  return (
    isOneOf(value.op, DECISION_OPS) &&
    typeof value.slug === "string" &&
    hasOptional(value, "scope", (item): item is MemoryScope => isOneOf(item, MEMORY_SCOPES)) &&
    hasOptional(value, "workdirHash", isString) &&
    hasOptional(value, "memoryType", (item): item is MemoryType => isOneOf(item, MEMORY_TYPES)) &&
    hasOptional(value, "description", isString) &&
    hasOptional(value, "body", isString) &&
    hasOptional(value, "reason", isString) &&
    hasOptional(value, "confidence", isNumber) &&
    hasOptional(value, "riskLevel", (item): item is RiskLevel => isOneOf(item, RISK_LEVELS)) &&
    hasOptional(value, "requiresUserAck", isBoolean) &&
    hasOptional(value, "sourceSlugs", isStringArray) &&
    hasOptional(value, "evidencePreserved", isStringArray) &&
    hasOptional(value, "blockedReasons", isStringArray) &&
    hasOptional(value, "groupId", isString) &&
    hasOptional(value, "applyStatus", (item): item is OrganizerDecisionApplyStatus =>
      isOneOf(item, DECISION_APPLY_STATUSES),
    ) &&
    hasOptional(value, "applyError", isOrganizerReviewItem)
  );
}

function isRejectionBuckets(value: unknown): value is RejectionBuckets {
  return isRecord(value) && REJECTION_BUCKET_KEYS.every((key) => typeof value[key] === "number");
}

function isManualApplyState(value: unknown): value is OrganizerManualApplyState {
  if (!isRecord(value)) return false;
  const isNumber = (item: unknown): item is number => typeof item === "number";
  return (
    isOneOf(value.status, MANUAL_APPLY_STATUSES) &&
    isStringArray(value.appliedDecisionKeys) &&
    isStringArray(value.failedDecisionKeys) &&
    hasOptional(value, "appliedAt", isNumber) &&
    hasOptional(value, "selectedCount", isNumber) &&
    hasOptional(value, "appliedCount", isNumber) &&
    hasOptional(value, "warningCount", isNumber)
  );
}

/** Runtime counterpart of OrganizeRunReportV4 for the persisted JSON boundary. */
export function isOrganizeRunReportV4(value: unknown): value is OrganizeRunReportV4 {
  if (!isRecord(value)) return false;
  return (
    value.version === ORGANIZE_RUN_REPORT_VERSION &&
    isStringArray(value.clusterSummaries) &&
    Array.isArray(value.reviewItems) &&
    value.reviewItems.every(isOrganizerReviewItem) &&
    Array.isArray(value.raw) &&
    value.raw.every(
      (item) =>
        isRecord(item) && typeof item.clusterId === "string" && typeof item.text === "string",
    ) &&
    hasOptional(
      value,
      "safeDecisions",
      (item): item is OrganizerSafeDecision[] =>
        Array.isArray(item) && item.every(isOrganizerSafeDecision),
    ) &&
    hasOptional(value, "rejectionBuckets", isRejectionBuckets) &&
    hasOptional(
      value,
      "compressionForecast",
      (item): item is NonNullable<OrganizeRunReportV4["compressionForecast"]> =>
        isRecord(item) &&
        typeof item.from === "number" &&
        typeof item.toMin === "number" &&
        typeof item.toMax === "number",
    ) &&
    hasOptional(value, "manualApplyState", isManualApplyState)
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function createEmptyRunReport(): OrganizeRunReportV4 {
  return {
    version: ORGANIZE_RUN_REPORT_VERSION,
    clusterSummaries: [],
    reviewItems: [],
    raw: [],
  };
}

/** Parse a run's persisted report. v4 reports round-trip as-is; anything else
 *  degrades to a read-only legacy view of its summary strings. */
export function readRunReport(run: MemoryOrganizeRun | null): OrganizeRunReport {
  const raw = run?.report;
  if (!isRecord(raw)) {
    return { version: "legacy", clusterSummaries: [], reviewItems: [] };
  }
  if (isOrganizeRunReportV4(raw)) {
    return raw;
  }
  // Legacy (pre-v4) blob: surface the human-readable strings, nothing else.
  const notes = [...stringArray(raw.reviewNotes)];
  return {
    version: "legacy",
    clusterSummaries: stringArray(raw.clusterSummaries),
    reviewItems: notes.map((message) => ({
      phase: "planning",
      kind: "review",
      severity: "warning",
      message,
    })),
  };
}

export function organizerDecisionKey(decision: OrganizerSafeDecision, index: number) {
  return `${index}:${decision.op}:${decision.scope || ""}:${decision.workdirHash || ""}:${decision.slug}`;
}

export function isDefaultSelectedDecision(decision: OrganizerSafeDecision) {
  return !decision.requiresUserAck && (decision.riskLevel ?? "low") === "low";
}

export function appliedBatchCount(
  batch: Pick<MemoryBatchResponse, "created" | "updated" | "deleted">,
) {
  return batch.created.length + batch.updated.length + batch.deleted.length;
}

export function buildManualApplyState(input: {
  selectedCount: number;
  appliedCount: number;
  warningCount: number;
  appliedDecisionKeys: string[];
  failedDecisionKeys: string[];
}): OrganizerManualApplyState {
  const status: Exclude<OrganizerManualApplyStatus, "" | "pending"> =
    input.warningCount === 0 ? "applied" : input.appliedCount > 0 ? "partial" : "failed";
  return {
    status,
    appliedAt: Date.now(),
    selectedCount: input.selectedCount,
    appliedCount: input.appliedCount,
    warningCount: input.warningCount,
    appliedDecisionKeys: input.appliedDecisionKeys,
    failedDecisionKeys: input.failedDecisionKeys,
  };
}

/** Map a batch response to typed review items keyed back to decisions. Only
 *  structured warningDetails are consulted; plain warning strings become
 *  generic apply errors. */
export function buildReviewItemsForBatch(
  batch: MemoryBatchResponse,
  selectedWithKeys: Array<{ decision: OrganizerSafeDecision; key: string }>,
): OrganizerReviewItem[] {
  const details = Array.isArray(batch.warningDetails) ? batch.warningDetails : [];
  if (details.length > 0) {
    return details.map((detail, index) => {
      const decisionIndex =
        typeof detail.decisionIndex === "number" && Number.isInteger(detail.decisionIndex)
          ? detail.decisionIndex
          : index;
      const fallback = selectedWithKeys[decisionIndex];
      const slug = detail.slug ?? fallback?.decision.slug;
      return {
        phase: "apply" as const,
        kind: "error" as const,
        severity: "error" as const,
        code: detail.code,
        message: detail.message,
        slug: slug ?? undefined,
        op: detail.op === "delete" ? ("delete" as const) : ("upsert" as const),
        groupId: detail.groupId ?? fallback?.decision.groupId,
        decisionKey: fallback?.key,
      };
    });
  }
  return batch.warnings.map((warning, index) => {
    const fallback = selectedWithKeys[index];
    return {
      phase: "apply" as const,
      kind: "error" as const,
      severity: "error" as const,
      message: warning,
      slug: fallback?.decision.slug,
      op: fallback?.decision.op,
      groupId: fallback?.decision.groupId,
      decisionKey: fallback?.key,
    };
  });
}

export function successfulDecisionKeys(
  selectedWithKeys: Array<{ decision: OrganizerSafeDecision; key: string }>,
  batch: Pick<MemoryBatchResponse, "created" | "updated" | "deleted">,
) {
  const successfulSlugs = new Set([...batch.created, ...batch.updated, ...batch.deleted]);
  return selectedWithKeys
    .filter(({ decision }) => successfulSlugs.has(decision.slug))
    .map(({ key }) => key);
}

export function failedDecisionKeysFromReviewItems(
  selectedWithKeys: Array<{ decision: OrganizerSafeDecision; key: string }>,
  reviewItems: OrganizerReviewItem[],
) {
  const failedKeys = new Set(reviewItems.map((item) => item.decisionKey).filter(Boolean));
  const failedSlugs = new Set(reviewItems.map((item) => item.slug).filter(Boolean));
  return selectedWithKeys
    .filter(({ decision, key }) => failedKeys.has(key) || failedSlugs.has(decision.slug))
    .map(({ key }) => key);
}

/** Overlay stored manual-apply state onto decisions for display. */
export function decisionsWithApplyStatus(
  decisions: OrganizerSafeDecision[],
  manualApplyState: OrganizerManualApplyState,
  reviewItems: OrganizerReviewItem[],
): OrganizerSafeDecision[] {
  const failedByKey = new Map<string, OrganizerReviewItem>();
  const failedBySlug = new Map<string, OrganizerReviewItem>();
  for (const item of reviewItems) {
    if (item.phase !== "apply") continue;
    if (item.decisionKey) failedByKey.set(item.decisionKey, item);
    if (item.slug) failedBySlug.set(item.slug, item);
  }
  const appliedKeys = new Set(manualApplyState.appliedDecisionKeys);
  const failedKeys = new Set(manualApplyState.failedDecisionKeys);
  return decisions.map((decision, index) => {
    const key = organizerDecisionKey(decision, index);
    const failure =
      failedByKey.get(key) ?? (failedKeys.has(key) ? failedBySlug.get(decision.slug) : undefined);
    if (failure || failedKeys.has(key)) {
      return { ...decision, applyStatus: "failed" as const, applyError: failure };
    }
    if (appliedKeys.has(key)) {
      return { ...decision, applyStatus: "applied" as const };
    }
    return decision;
  });
}
