// Pure display helpers for the memory settings panel: entry titles/keys,
// filters, type labels, organizer status/risk labels, quota fallbacks and
// summary text derivation. No React, no platform imports.
//
// MIRROR NOTICE: every file in pages/settings/memory except platform.tsx
// exists byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; platform
// differences belong in ./platform, never here.

import type {
  MemoryListResponse,
  MemoryMeta,
  MemoryOrganizeRun,
  MemoryOrganizeRunStatus,
  MemoryReadResponse,
} from "../../../lib/memory/api";
import type {
  OrganizerManualApplyState,
  OrganizerReviewItem,
  OrganizerSafeDecision,
} from "../../../lib/memory/organizer/runRecord";
import { REJECTION_BUCKET_KEYS, type RejectionBucketKey } from "../../../lib/memory/schema";
import type {
  MemoryOrganizerFrequency,
  MemoryOrganizerMode,
  MemoryOrganizerScope,
  ProviderId,
} from "../../../lib/settings";

export type MemoryTab = "global" | "project" | "journal";

export type MemoryModelOption = {
  value: string;
  label: string;
  providerName: string;
  providerId?: string;
  providerType?: ProviderId;
};

export const MEMORY_ORGANIZER_FREQUENCIES: Array<{
  value: MemoryOrganizerFrequency;
  labelKey: string;
}> = [
  { value: "none", labelKey: "settings.memoryOrganizerNoSchedule" },
  { value: "daily", labelKey: "settings.memoryOrganizerEveryDay" },
  { value: "weekly", labelKey: "settings.memoryOrganizerEveryWeek" },
];
export const MEMORY_ORGANIZER_SCOPES: Array<{ value: MemoryOrganizerScope; labelKey: string }> = [
  { value: "all", labelKey: "settings.memoryOrganizerScopeAll" },
  { value: "global", labelKey: "settings.memoryOrganizerScopeGlobal" },
  { value: "projects", labelKey: "settings.memoryOrganizerScopeAllProjects" },
  { value: "current-project", labelKey: "settings.memoryOrganizerScopeCurrentProject" },
];
export const MEMORY_ORGANIZER_MODES: Array<{ value: MemoryOrganizerMode; labelKey: string }> = [
  { value: "conservative", labelKey: "settings.memoryOrganizerModeConservative" },
  { value: "standard", labelKey: "settings.memoryOrganizerModeStandard" },
  { value: "aggressive", labelKey: "settings.memoryOrganizerModeAggressive" },
];
export const MEMORY_ORGANIZER_WEEKDAYS = [
  "settings.memoryOrganizerWeekdaySunday",
  "settings.memoryOrganizerWeekdayMonday",
  "settings.memoryOrganizerWeekdayTuesday",
  "settings.memoryOrganizerWeekdayWednesday",
  "settings.memoryOrganizerWeekdayThursday",
  "settings.memoryOrganizerWeekdayFriday",
  "settings.memoryOrganizerWeekdaySaturday",
];

export function formatTime(value: number) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function dailyTitle(entry: { slug: string; dateLocal?: string | null }) {
  return entry.dateLocal || entry.slug.replace(/^daily-/, "") || entry.slug;
}

export function entryTitle(entry: MemoryMeta) {
  return entry.memoryType === "daily" ? dailyTitle(entry) : entry.description || entry.slug;
}

export function selectedTitle(entry: MemoryReadResponse) {
  return entry.memoryType === "daily" ? dailyTitle(entry) : entry.description || entry.slug;
}

export function entryKey(entry: MemoryMeta) {
  return `${entry.scope}:${entry.workdirHash || ""}:${entry.slug}`;
}

export function selectedEntryWorkdir(entry: MemoryMeta | null, fallbackWorkdir?: string) {
  if (!entry || entry.scope !== "project") return fallbackWorkdir;
  return entry.workdirPath?.trim() || fallbackWorkdir;
}

export function memoryTypeLabel(
  type: MemoryMeta["memoryType"] | MemoryReadResponse["memoryType"],
  t: (key: string) => string,
) {
  switch (type) {
    case "user":
      return t("settings.memoryTypeUser");
    case "feedback":
      return t("settings.memoryTypeFeedback");
    case "project":
      return t("settings.memoryTypeProject");
    case "reference":
      return t("settings.memoryTypeReference");
    case "daily":
      return t("settings.memoryTypeDaily");
    default:
      return type;
  }
}

export function memoryScopeLabel(scope: MemoryMeta["scope"], t: (key: string) => string) {
  return scope === "project" ? t("settings.memoryScopeProject") : t("settings.memoryScopeGlobal");
}

export function organizerStatusLabel(status: MemoryOrganizeRunStatus, t: (key: string) => string) {
  switch (status) {
    case "pending":
      return t("settings.memoryOrganizerStatusPending");
    case "running":
      return t("settings.memoryOrganizerStatusRunning");
    case "succeeded":
      return t("settings.memoryOrganizerStatusSucceeded");
    case "failed":
      return t("settings.memoryOrganizerStatusFailed");
    case "skipped":
      return t("settings.memoryOrganizerStatusSkipped");
    case "cancelled":
      return t("settings.memoryOrganizerStatusCancelled");
    default:
      return status;
  }
}

export function organizerStatusClass(status: MemoryOrganizeRunStatus) {
  if (status === "succeeded") {
    return "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "failed") {
    return "border-destructive/25 bg-destructive/[0.06] text-destructive";
  }
  if (status === "running" || status === "pending") {
    return "border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300";
  }
  return "border-border/60 bg-muted/40 text-muted-foreground";
}

export function organizerTriggerLabel(
  trigger: MemoryOrganizeRun["trigger"],
  t: (key: string) => string,
) {
  return trigger === "scheduled"
    ? t("settings.memoryOrganizerTriggerScheduled")
    : t("settings.memoryOrganizerTriggerManual");
}

export function modelNameFromRun(run: MemoryOrganizeRun) {
  const model =
    run.model && typeof run.model === "object"
      ? (run.model as { model?: unknown }).model
      : undefined;
  return typeof model === "string" && model.trim() ? model.trim() : "-";
}

export function isOrganizerRunActive(run: Pick<MemoryOrganizeRun, "status"> | null | undefined) {
  return run?.status === "pending" || run?.status === "running";
}

export function organizerRiskLabel(
  risk: OrganizerSafeDecision["riskLevel"],
  t: (key: string) => string,
) {
  if (risk === "high") return t("settings.memoryOrganizerRiskHigh");
  if (risk === "medium") return t("settings.memoryOrganizerRiskMedium");
  return t("settings.memoryOrganizerRiskLow");
}

export function organizerRiskClass(risk: OrganizerSafeDecision["riskLevel"]) {
  if (risk === "high") {
    return "border-destructive/35 bg-destructive/[0.06] text-destructive";
  }
  if (risk === "medium") {
    return "border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300";
  }
  return "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300";
}

export function organizerApplyStatusLabel(
  status: OrganizerSafeDecision["applyStatus"],
  t: (key: string) => string,
) {
  if (status === "applied") return t("settings.memoryOrganizerDecisionApplied");
  if (status === "failed") return t("settings.memoryOrganizerDecisionFailed");
  if (status === "skipped") return t("settings.memoryOrganizerDecisionSkipped");
  return "";
}

export function organizerApplyStatusClass(status: OrganizerSafeDecision["applyStatus"]) {
  if (status === "applied") {
    return "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300";
  }
  if (status === "failed") {
    return "border-destructive/35 bg-destructive/[0.06] text-destructive";
  }
  if (status === "skipped") {
    return "border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300";
  }
  return "border-border/60 text-muted-foreground";
}

export function organizerReviewItemLabel(item: OrganizerReviewItem, t: (key: string) => string) {
  if (item.phase === "apply") return t("settings.memoryOrganizerReviewItemApply");
  if (item.kind === "error") return t("settings.memoryOrganizerReviewItemError");
  if (item.kind === "skipped") return t("settings.memoryOrganizerReviewItemSkipped");
  return t("settings.memoryOrganizerReviewItemReview");
}

export function organizerReviewItemClass(item: OrganizerReviewItem) {
  if (item.severity === "error" || item.kind === "error") {
    return "border-destructive/30 bg-destructive/[0.06] text-destructive";
  }
  if (item.kind === "skipped" || item.severity === "warning") {
    return "border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300";
  }
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

export function manualApplySummaryText(input: {
  selectedCount: number;
  appliedCount: number;
  warningCount: number;
}) {
  if (input.warningCount === 0) {
    return `手动应用结果：已选择 ${input.selectedCount} 条建议，${input.appliedCount} 条写入成功。`;
  }
  if (input.appliedCount > 0) {
    return `手动应用结果：已选择 ${input.selectedCount} 条建议，${input.appliedCount} 条写入成功，${input.warningCount} 条失败或跳过。`;
  }
  return `手动应用结果：已选择 ${input.selectedCount} 条建议，全部未写入，${input.warningCount} 条失败或跳过。`;
}

export type ManualApplyDisplay = {
  status: OrganizerManualApplyState["status"];
  selectedCount: number;
  appliedCount: number;
  warningCount: number;
  appliedDecisionKeys: Set<string>;
  failedDecisionKeys: Set<string>;
};

/** Overlay the persisted manual-apply state (plain arrays) with live run
 *  counters for display. Runs without stored state derive counts from the
 *  run's own counters and apply-phase review items. */
export function deriveManualApplyDisplay(input: {
  run: MemoryOrganizeRun | null;
  safeDecisions: OrganizerSafeDecision[];
  reviewItems: OrganizerReviewItem[];
  manualApplyState: OrganizerManualApplyState;
}): ManualApplyDisplay {
  const { run, safeDecisions, reviewItems, manualApplyState } = input;
  const applyItems = reviewItems.filter((item) => item.phase === "apply");
  const selectedCount = manualApplyState.selectedCount ?? safeDecisions.length;
  const appliedCount = manualApplyState.appliedCount ?? run?.safeApplied ?? 0;
  const warningCount = manualApplyState.warningCount ?? applyItems.length;
  let status = manualApplyState.status;
  if (status === "applied" && warningCount > 0) {
    status = appliedCount > 0 ? "partial" : "failed";
  }
  return {
    status,
    selectedCount,
    appliedCount,
    warningCount,
    appliedDecisionKeys: new Set(manualApplyState.appliedDecisionKeys),
    failedDecisionKeys: new Set(manualApplyState.failedDecisionKeys),
  };
}

export const EMPTY_MANUAL_APPLY_STATE: OrganizerManualApplyState = {
  status: "",
  appliedDecisionKeys: [],
  failedDecisionKeys: [],
};

export function displayedFinalSummary(run: MemoryOrganizeRun, manualDisplay: ManualApplyDisplay) {
  if (manualDisplay.status === "partial" || manualDisplay.status === "failed") {
    const summary = manualApplySummaryText(manualDisplay);
    const final = run.finalSummary?.trim();
    if (!final) return summary;
    if (final.includes("手动应用结果")) return final;
    return `${summary}\n\n模型原始总结：${final}`;
  }
  return run.finalSummary || run.error || "";
}

const REJECTION_BUCKET_LABEL_KEYS: Record<RejectionBucketKey, string> = {
  reviewedProtected: "settings.memoryOrganizerBucketReviewed",
  lowConfidence: "settings.memoryOrganizerBucketLowConfidence",
  crossType: "settings.memoryOrganizerBucketCrossType",
  crossScope: "settings.memoryOrganizerBucketCrossScope",
  reviewRequiredByLlm: "settings.memoryOrganizerBucketReviewRequired",
  missingPayload: "settings.memoryOrganizerBucketMissingPayload",
  unsupported: "settings.memoryOrganizerBucketUnsupported",
};

/** Non-zero rejection buckets as [i18n label key, count] pairs. */
export function rejectionBucketEntries(
  buckets: Partial<Record<RejectionBucketKey, number>> | undefined,
): Array<[string, number]> {
  if (!buckets) return [];
  return REJECTION_BUCKET_KEYS.map((key): [string, number] => [
    REJECTION_BUCKET_LABEL_KEYS[key],
    Number(buckets[key] ?? 0),
  ]).filter(([, count]) => Number.isFinite(count) && count > 0);
}

export function projectLabel(entry: MemoryMeta, t: (key: string) => string) {
  const path = entry.workdirPath?.trim();
  if (path) return path;
  return `${t("settings.memoryUnknownProject")} · ${
    entry.workdirHash || t("settings.memoryUnknownProjectId")
  }`;
}

export function matchesFilter(entry: MemoryMeta, filter: string) {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return [
    entry.slug,
    entry.memoryType,
    entry.scope,
    entry.description,
    entryTitle(entry),
    entry.workdirHash,
    entry.workdirPath,
  ]
    .join("\n")
    .toLowerCase()
    .includes(q);
}

export type MemoryQuota = MemoryListResponse["quota"];
export type MemoryScopeQuota = NonNullable<MemoryQuota["scopeQuotas"]>[number];
export type QuotaLevel = "healthy" | "warning" | "danger" | "full";

export function fallbackScopeQuotas(
  entries: MemoryMeta[],
  quota: MemoryQuota | null,
  hasWorkdir: boolean,
): MemoryScopeQuota[] {
  const projectUsed = entries.filter(
    (entry) => entry.memoryType !== "daily" && entry.scope === "project",
  ).length;
  if (quota?.scopeQuotas?.length) {
    const items = [...quota.scopeQuotas];
    if (projectUsed > 0 && !items.some((item) => item.scope === "project")) {
      items.push({
        scope: "project",
        workdirHash: "all",
        used: projectUsed,
        limit: quota.limit,
      });
    }
    return items;
  }
  const limit = quota?.limit ?? 500;
  const globalUsed = entries.filter(
    (entry) => entry.memoryType !== "daily" && entry.scope === "global",
  ).length;
  return [
    { scope: "global", workdirHash: "", used: globalUsed, limit },
    ...(hasWorkdir || projectUsed > 0
      ? [{ scope: "project" as const, workdirHash: "", used: projectUsed, limit }]
      : []),
  ];
}

export function quotaLevel(quota: MemoryScopeQuota): QuotaLevel {
  if (quota.limit <= 0) return "healthy";
  const ratio = quota.used / quota.limit;
  if (quota.used >= quota.limit) return "full";
  if (ratio >= 0.95) return "danger";
  if (ratio >= 0.8) return "warning";
  return "healthy";
}

export function strongestQuotaLevel(items: MemoryScopeQuota[]): QuotaLevel {
  if (items.some((item) => quotaLevel(item) === "full")) return "full";
  if (items.some((item) => quotaLevel(item) === "danger")) return "danger";
  if (items.some((item) => quotaLevel(item) === "warning")) return "warning";
  return "healthy";
}

export function quotaPillClass(level: QuotaLevel) {
  if (level === "full" || level === "danger") {
    return "border-red-500/25 bg-red-500/[0.06] text-red-700 dark:text-red-300";
  }
  if (level === "warning") {
    return "border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300";
  }
  return "border-border/60 text-muted-foreground";
}

export function quotaStatusClass(level: QuotaLevel) {
  if (level === "full" || level === "danger") {
    return "border-red-500/25 bg-red-500/[0.06] text-red-700 dark:text-red-300";
  }
  if (level === "warning") {
    return "border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300";
  }
  return "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
}

export function quotaStatusLabelKey(level: QuotaLevel) {
  if (level === "full") return "settings.memoryQuotaFull";
  if (level === "danger") return "settings.memoryQuotaNearLimit";
  if (level === "warning") return "settings.memoryQuotaWarning";
  return "settings.memoryHealthy";
}
