import { invoke } from "@tauri-apps/api/core";

export type MemoryScope = "global" | "project" | "auto";
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemorySearchType = MemoryType | "daily";
export type MemoryHistoryTimeMode = "message" | "updated" | "conversation";
export type MemoryConfidence = "high" | "medium" | "low" | "unknown";

export type MemoryMeta = {
  slug: string;
  scope: "global" | "project";
  workdirHash: string;
  workdirPath?: string | null;
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  dateLocal?: string | null;
  createdAt: number;
  updatedAt: number;
  appendCount: number;
  archived: boolean;
  unreviewed: boolean;
  confidence: MemoryConfidence;
  fileSize: number;
};

export type MemoryListResponse = {
  entries: MemoryMeta[];
  truncated: boolean;
  quota: {
    used: number;
    limit: number;
    scopeQuotas?: Array<{
      scope: "global" | "project";
      workdirHash: string;
      used: number;
      limit: number;
    }>;
  };
};

export type MemoryReadResponse = {
  slug: string;
  scope: "global" | "project";
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  body: string;
  totalLines: number;
  window: {
    offset: number;
    length: number;
    truncated: boolean;
  };
  meta: {
    unreviewed: boolean;
    confidence: MemoryConfidence;
    source: unknown;
    createdAt: number;
    updatedAt: number;
    archived: boolean;
  };
};

export type MemorySearchMatch = {
  slug: string;
  scope: "global" | "project";
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  snippet: string;
  score: number;
  rawScore?: number | null;
  ageDays?: number | null;
  unreviewed: boolean;
  confidence: MemoryConfidence;
};

export type MemoryHistorySearchMatch = {
  source: "message" | "segment" | string;
  conversationId: string;
  title: string;
  cwd?: string | null;
  segmentIndex: number;
  segmentId: string;
  messageIndex?: number | null;
  messageId?: string | null;
  role?: string | null;
  snippet: string;
  score: number;
  rawScore?: number | null;
  updatedAt: number;
};

export type MemorySearchResponse = {
  matches: MemorySearchMatch[];
  historyMatches: MemoryHistorySearchMatch[];
  usedFallback: boolean;
};

export type MemoryMutationResponse = {
  slug: string;
  scope: "global" | "project";
  created: boolean;
  updated: boolean;
  deleted: boolean;
  indexUpdated: boolean;
  warning?: string | null;
};

export type MemoryDeleteProjectResponse = {
  workdirHash: string;
  deletedCount: number;
  quarantinePath?: string | null;
};

export type MemoryOverviewEntry = {
  slug: string;
  scope: "global" | "project";
  memoryType: MemorySearchType;
  description: string;
  headline: string;
  dateLocal?: string | null;
  updatedAt: number;
  unreviewed: boolean;
  confidence: MemoryConfidence;
};

export type MemoryOverviewResponse = {
  user: MemoryOverviewEntry[];
  project: MemoryOverviewEntry[];
  global: MemoryOverviewEntry[];
  recentDays: MemoryOverviewEntry[];
  root: string;
  workdirHash?: string | null;
};

export type MemoryPathsInfo = {
  root: string;
  isFresh: boolean;
  isInCloud: boolean;
  cloudProvider?: string | null;
};

export type MemoryRejectionEntry = {
  slug: string;
  scope: string;
  workdirHash: string;
  rejectedAt: number;
  actor: string;
  reason?: string | null;
};

export type MemoryRecentRejectionsResponse = {
  entries: MemoryRejectionEntry[];
};

export type MemoryBatchResponse = {
  created: string[];
  updated: string[];
  deleted: string[];
  warnings: string[];
  warningDetails?: MemoryBatchWarning[];
};

export type MemoryBatchWarning = {
  code: string;
  message: string;
  slug?: string | null;
  op?: "upsert" | "delete" | null;
  groupId?: string | null;
  decisionIndex?: number | null;
  details?: unknown;
};

export type MemoryOrganizeRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type MemoryOrganizeTrigger = "manual" | "scheduled";

export type MemoryOrganizeRun = {
  runId: string;
  trigger: MemoryOrganizeTrigger;
  status: MemoryOrganizeRunStatus;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  dueAt?: number | null;
  claimedAt?: number | null;
  model: unknown;
  scope: string;
  mode: string;
  inputCount: number;
  clusterCount: number;
  safeApplied: number;
  reviewSkipped: number;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  mergedCount: number;
  parseFailures: number;
  error?: string | null;
  finalSummary?: string | null;
  trimmedProtocol: unknown;
};

export type MemoryOrganizeRunCreateResponse = {
  run?: MemoryOrganizeRun | null;
  accepted: boolean;
  alreadyRunning: boolean;
  activeRun?: MemoryOrganizeRun | null;
};

export type MemoryOrganizeDueClaimResponse = {
  run?: MemoryOrganizeRun | null;
  skippedReason?: string | null;
};

export type MemoryOrganizeRunListResponse = {
  runs: MemoryOrganizeRun[];
};

export type MemoryOrganizeRunClearHistoryResponse = {
  deletedCount: number;
  retainedActiveCount: number;
};

export type MemoryErrorPayload = {
  error: string;
  message: string;
  suggested_next_call?: unknown;
  candidates?: unknown[];
};

export function parseMemoryError(error: unknown): MemoryErrorPayload | null {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed as MemoryErrorPayload;
    }
  } catch {
    // Tauri may wrap the string; fall through to null.
  }
  return null;
}

export function formatMemoryError(error: unknown) {
  const parsed = parseMemoryError(error);
  if (parsed) {
    const extras = [
      parsed.suggested_next_call
        ? `suggested_next_call=${JSON.stringify(parsed.suggested_next_call)}`
        : "",
      parsed.candidates ? `candidates=${JSON.stringify(parsed.candidates)}` : "",
    ].filter(Boolean);
    return [parsed.message, ...extras].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function memoryList(args: {
  scope?: MemoryScope;
  workdir?: string;
  includeAllProjects?: boolean;
  memoryType?: MemorySearchType;
  includeDaily?: boolean;
  limit?: number;
  offset?: number;
}) {
  return invoke<MemoryListResponse>("memory_list", { args });
}

export async function memoryRead(args: {
  slug: string;
  scope?: MemoryScope;
  workdir?: string;
  workdirHash?: string;
  offset?: number;
  length?: number;
}) {
  return invoke<MemoryReadResponse>("memory_read", { args });
}

export async function memorySearch(args: {
  query: string;
  scope?: MemoryScope;
  workdir?: string;
  memoryType?: MemorySearchType;
  limit?: number;
  includeHistory?: boolean;
  historySince?: number;
  historyUntil?: number;
  historyDateLocal?: string;
  historyTimeMode?: MemoryHistoryTimeMode;
}) {
  return invoke<MemorySearchResponse>("memory_search", { args });
}

export async function memoryWrite(args: {
  slug: string;
  scope: "global" | "project";
  workdir?: string;
  memoryType: MemoryType;
  description: string;
  body: string;
  actor?: string;
  conversationId?: string;
  model?: string;
}) {
  return invoke<MemoryMutationResponse>("memory_write", { args });
}

export async function memoryUpdate(args: {
  slug: string;
  scope?: MemoryScope;
  workdir?: string;
  workdirHash?: string;
  memoryType?: MemoryType;
  description?: string;
  body?: string;
  mode?: "replace" | "append" | "merge";
  actor?: string;
  conversationId?: string;
  model?: string;
}) {
  return invoke<MemoryMutationResponse>("memory_update", { args });
}

export async function memoryDelete(args: {
  slug: string;
  scope: "global" | "project";
  workdir?: string;
  workdirHash?: string;
  actor?: string;
  reason?: string;
  conversationId?: string;
  model?: string;
}) {
  return invoke<MemoryMutationResponse>("memory_delete", { args });
}

export async function memoryDeleteProject(args: {
  workdir: string;
  actor?: "user" | "tool" | "extractor" | "reconcile";
  reason?: string;
}) {
  return invoke<MemoryDeleteProjectResponse>("memory_delete_project", { args });
}

export async function memoryAccept(args: {
  slug: string;
  scope: "global" | "project";
  workdir?: string;
  workdirHash?: string;
}) {
  return invoke<MemoryMutationResponse>("memory_accept", { args });
}

export async function memoryApplyBatch(args: {
  workdir?: string;
  conversationId?: string;
  trigger?: "end" | "compaction" | "memory-organize";
  model?: string;
  localDate?: string;
  dailyAppend?: {
    bullet: string;
  };
  decisions?: Array<{
    op: "upsert" | "delete";
    slug: string;
    scope?: "global" | "project";
    workdirHash?: string;
    memoryType?: MemoryType;
    description?: string;
    body?: string;
    reason?: string;
    confidence?: number;
    riskLevel?: "low" | "medium" | "high";
    requiresUserAck?: boolean;
    sourceSlugs?: string[];
    evidencePreserved?: string[];
    blockedReasons?: string[];
    groupId?: string;
  }>;
}) {
  return invoke<MemoryBatchResponse>("memory_apply_batch", { args });
}

export async function memoryOrganizeRunCreate(args: {
  trigger: MemoryOrganizeTrigger;
  dueAt?: number;
  model?: unknown;
  scope?: string;
  mode?: string;
}) {
  return invoke<MemoryOrganizeRunCreateResponse>("memory_organize_run_create", { args });
}

export async function memoryOrganizeRunUpdate(args: {
  runId: string;
  status?: MemoryOrganizeRunStatus;
  startedAt?: number;
  finishedAt?: number;
  inputCount?: number;
  clusterCount?: number;
  safeApplied?: number;
  reviewSkipped?: number;
  createdCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  mergedCount?: number;
  parseFailures?: number;
  error?: string;
  finalSummary?: string;
  trimmedProtocol?: unknown;
}) {
  return invoke<MemoryOrganizeRun | null>("memory_organize_run_update", { args });
}

export async function memoryOrganizeRunList(args?: {
  status?: MemoryOrganizeRunStatus;
  limit?: number;
}) {
  return invoke<MemoryOrganizeRunListResponse>("memory_organize_run_list", {
    args: args ?? {},
  });
}

export async function memoryOrganizeRunRead(args: { runId: string }) {
  return invoke<MemoryOrganizeRun | null>("memory_organize_run_read", { args });
}

export async function memoryOrganizeRunClearHistory() {
  return invoke<MemoryOrganizeRunClearHistoryResponse>(
    "memory_organize_run_clear_history",
  );
}

export async function memoryOrganizeDueClaim(args: {
  enabled?: boolean;
  dueAt?: number;
  now?: number;
  model?: unknown;
  scope?: string;
  mode?: string;
}) {
  return invoke<MemoryOrganizeDueClaimResponse>("memory_organize_due_claim", { args });
}

export async function memoryOrganizeDueComplete(args: Parameters<typeof memoryOrganizeRunUpdate>[0]) {
  return invoke<MemoryOrganizeRun | null>("memory_organize_due_complete", { args });
}

export async function memoryIndexOverview(workdir?: string) {
  return invoke<MemoryOverviewResponse>("memory_index_overview", { workdir });
}

export async function memoryRecentRejections(args?: {
  sinceDays?: number;
  limit?: number;
  workdir?: string;
}) {
  return invoke<MemoryRecentRejectionsResponse>("memory_recent_rejections", {
    args: args ?? {},
  });
}

export async function memoryPathsInfo() {
  return invoke<MemoryPathsInfo>("memory_paths_info");
}

export async function memoryTodayLocalDate(rolloverHour?: number) {
  return invoke<string>("memory_today_local_date", { rolloverHour });
}

export async function memoryTodayDaily(rolloverHour?: number) {
  return invoke<MemoryReadResponse | null>("memory_today_daily", { rolloverHour });
}

export async function memoryWipeAll() {
  return invoke<MemoryPathsInfo>("memory_wipe_all");
}
