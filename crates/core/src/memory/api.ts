// Thin, fully-typed invoke bindings over the Rust MemoryStore commands.
// On the gateway web build the same file works unchanged: the Tauri `invoke`
// shim intercepts every `memory_*` command and forwards it over the websocket
// to the connected desktop agent.

import { callBackend } from "../backendClient";
import type {
  ApplyDecision,
  MemoryConfidence,
  MemoryEvidenceFields,
  MemoryScope,
  MemoryScopeFilter,
  MemorySearchType,
  MemoryType,
  MemoryUpdateMode,
} from "./schema";

export type MemoryHistoryTimeMode = "message" | "updated" | "conversation";

export type MemoryMeta = {
  slug: string;
  scope: MemoryScope;
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

export type MemoryScopeQuota = {
  scope: MemoryScope;
  workdirHash: string;
  used: number;
  limit: number;
};

export type MemoryListResponse = {
  entries: MemoryMeta[];
  truncated: boolean;
  quota: {
    used: number;
    limit: number;
    scopeQuotas?: MemoryScopeQuota[];
  };
};

export type MemoryReadResponse = {
  slug: string;
  scope: MemoryScope;
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
  scope: MemoryScope;
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
  scope: MemoryScope;
  created: boolean;
  updated: boolean;
  deleted: boolean;
  indexUpdated: boolean;
  warning?: string | null;
  /** Confidence actually stored after the Rust-side contract ran. */
  appliedConfidence?: MemoryConfidence | null;
  autoDowngraded?: boolean | null;
};


export type MemoryOverviewEntry = {
  slug: string;
  scope: MemoryScope;
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
  op?: string | null;
  groupId?: string | null;
  decisionIndex?: number | null;
  details?: unknown;
};




export type MemoryErrorPayload = {
  error: string;
  message: string;
  suggested_next_call?: unknown;
  candidates?: unknown[];
};

function parseMemoryError(error: unknown): MemoryErrorPayload | null {
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
  scope?: MemoryScopeFilter;
  workdir?: string;
  includeAllProjects?: boolean;
  memoryType?: MemorySearchType;
  includeDaily?: boolean;
  limit?: number;
  offset?: number;
}) {
  return callBackend<MemoryListResponse>("memory_list", { args });
}

export async function memoryRead(args: {
  slug: string;
  scope?: MemoryScopeFilter;
  workdir?: string;
  workdirHash?: string;
  offset?: number;
  length?: number;
}) {
  return callBackend<MemoryReadResponse>("memory_read", { args });
}

export async function memorySearch(args: {
  query: string;
  scope?: MemoryScopeFilter;
  workdir?: string;
  memoryType?: MemorySearchType;
  limit?: number;
  includeHistory?: boolean;
  historySince?: number;
  historyUntil?: number;
  historyDateLocal?: string;
  historyTimeMode?: MemoryHistoryTimeMode;
}) {
  return callBackend<MemorySearchResponse>("memory_search", { args });
}

export async function memoryWrite(args: {
  slug: string;
  scope: MemoryScope;
  workdir?: string;
  memoryType: MemoryType;
  description: string;
  body: string;
  actor?: string;
  conversationId?: string;
  model?: string;
  evidence?: MemoryEvidenceFields;
}) {
  return callBackend<MemoryMutationResponse>("memory_write", { args });
}

export async function memoryUpdate(args: {
  slug: string;
  scope?: MemoryScopeFilter;
  workdir?: string;
  workdirHash?: string;
  memoryType?: MemoryType;
  description?: string;
  body?: string;
  mode?: MemoryUpdateMode;
  actor?: string;
  conversationId?: string;
  model?: string;
  evidence?: MemoryEvidenceFields;
}) {
  return callBackend<MemoryMutationResponse>("memory_update", { args });
}

export async function memoryDelete(args: {
  slug: string;
  scope: MemoryScope;
  workdir?: string;
  workdirHash?: string;
  actor?: string;
  reason?: string;
  conversationId?: string;
  model?: string;
}) {
  return callBackend<MemoryMutationResponse>("memory_delete", { args });
}


export async function memoryAccept(args: {
  slug: string;
  scope: MemoryScope;
  workdir?: string;
  workdirHash?: string;
}) {
  return callBackend<MemoryMutationResponse>("memory_accept", { args });
}

export async function memoryApplyBatch(args: {
  workdir?: string;
  conversationId?: string;
  trigger?: "memory-extraction" | "memory-organize" | "end" | "compaction";
  model?: string;
  localDate?: string;
  dailyAppend?: {
    bullet: string;
  };
  decisions?: ApplyDecision[];
}) {
  return callBackend<MemoryBatchResponse>("memory_apply_batch", { args });
}








export async function memoryIndexOverview(workdir?: string) {
  return callBackend<MemoryOverviewResponse>("memory_index_overview", { workdir });
}

export async function memoryRecentRejections(args?: {
  sinceDays?: number;
  limit?: number;
  workdir?: string;
}) {
  return callBackend<MemoryRecentRejectionsResponse>("memory_recent_rejections", {
    args: args ?? {},
  });
}



export async function memoryTodayLocalDate(rolloverHour?: number) {
  return callBackend<string>("memory_today_local_date", { rolloverHour });
}


