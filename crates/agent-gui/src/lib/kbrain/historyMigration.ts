import type { Message } from "@liveagent/app/lib/agentTypes";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { isTauriHost } from "../host";
import { createKBrainClient } from "./client";
import {
  classifyHistoryMigrationFailure,
  type HistoryMigrationFailureKind,
  type HistoryMigrationFailureRecord,
  knownDeterministicFailure,
  mergeHistoryMigrationFailures,
  readHistoryMigrationFailures,
  writeHistoryMigrationFailures,
} from "./historyMigrationFailures";
import { kBrainStorageScope, setKBrainSessionId } from "./mapping";
import { getConfiguredKBrainConnection } from "./runtimeConnection";
import { contextToKBrainMessages } from "./turn";
import type { KBrainMessage, KBrainModelRef } from "./types";

type LegacySegment = {
  segmentIndex: number;
  segmentId: string;
  messagesJson: string;
  summaryJson?: string | null;
  messageCount?: number;
  startMessageId?: string | null;
  endMessageId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  active?: boolean;
};
export type LegacyConversation = {
  id: string;
  title: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  selectedModelJson?: string;
  createdAt: number;
  updatedAt: number;
  isPinned: boolean;
  isShared: boolean;
  shareToken?: string;
  redactToolContent: boolean;
  contextMetaJson: string;
  segments: LegacySegment[];
  activeSegmentIndex?: number;
  totalSegmentCount?: number;
  totalMessageCount?: number;
  checkpoint?: LegacyCheckpoint;
};
type LegacyCheckpointRecord = {
  schema: number;
  turnSeq: number;
  turnId: string;
  root: string;
  relPath: string;
  kind: "turn" | "file" | "dir" | "error" | "rewind";
  existedBefore: boolean;
  blob?: string | null;
  blobBase64?: string | null;
  size: number;
  mtimeMs: number;
  capturedAt: number;
  note?: string | null;
  mode?: number | null;
};
type LegacyCheckpoint = {
  status: "available" | "partial" | "not_found" | "unresolved";
  nativePath?: string;
  indexPath?: string;
  indexJsonl?: string;
  records?: LegacyCheckpointRecord[];
  invalidLines?: string[];
  reason?: string;
};
export type LegacyPage = {
  conversations: LegacyConversation[];
  nextCursor?: string | null;
  complete: boolean;
  source?: string;
};
export type MigrationImportResult = {
  source_id: string;
  backend_id: string;
  status: "imported" | "already_imported";
  checkpoint: "available" | "partial" | "not_found" | "unresolved";
  checkpoint_reason?: string;
};
export type MigrationFailure = {
  sourceId: string;
  error: string;
  /** Present for per-conversation failures; absent for source-level paging errors. */
  kind?: HistoryMigrationFailureKind;
  title?: string;
  bytes?: number;
  /** True when startup skipped it because the same content already failed deterministically. */
  skipped?: boolean;
  /** True when the exported conversation itself could not be converted, before any request. */
  invalidSource?: boolean;
};

export type HistoryMigrationSource = "legacy" | "pi";
export type HistoryMigrationOutcome =
  | "imported"
  | "alreadyImported"
  | "skipped"
  | "failed"
  | "partial";
export type HistoryMigrationProgress = {
  source: HistoryMigrationSource;
  operation: "reading" | "processing" | "importing" | "settled" | "done" | "error";
  outcome?: HistoryMigrationOutcome;
};

function reportProgress(
  options: HistoryMigrationOptions,
  operation: HistoryMigrationProgress["operation"],
  outcome?: HistoryMigrationOutcome,
) {
  try {
    options.onProgress?.({ source: options.progressSource ?? "legacy", operation, outcome });
  } catch {
    // Progress observers must never change migration or its persistent result.
  }
}

export type HistoryMigrationOptions = {
  onProgress?: (progress: HistoryMigrationProgress) => void;
  progressSource?: HistoryMigrationSource;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /**
   * Re-send conversations that already failed deterministically with unchanged content.
   * Startup leaves this off; the manual "Import old conversations" action turns it on.
   */
  retryKnownFailures?: boolean;
  /** Shared across pages so one migration pass lists K-brain sessions at most once. */
  sessionExists?: (backendId: string) => Promise<boolean>;
};

type ExistenceClient = Pick<
  ReturnType<typeof createKBrainClient>,
  "listSessions" | "getSession" | "getCapabilities" | "sessionsExist"
>;

const MAX_EXISTS_IDS = 5000;

/** Backend ids of every cached migration result in the current K-brain scope. */
function cachedBackendIds(): string[] {
  return Object.values(readMigrationCache(kBrainStorageScope()))
    .map((entry) => entry?.result?.backend_id)
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");
}

/**
 * Existence check for cached migration results. K-brain answers both the session listing and a
 * lookup by id by reading whole transcripts (one ~10 MB conversation took ~1.2 s, and the listing
 * reads every transcript on each page). A backend with `session_exists` confirms every cached id
 * in one metadata-only request. Older backends fall back to one paged listing, and a session
 * missing from the listing (or a listing that fails) is still confirmed by id, so a listing gap
 * can never trigger a re-upload and only a real 404 does.
 */
export function createSessionExistenceCheck(
  client: ExistenceClient,
  signal?: AbortSignal,
  candidates: () => Iterable<string> = cachedBackendIds,
) {
  let batched: Promise<{ asked: Set<string>; existing: Set<string> } | null> | undefined;
  const batch = () => {
    batched ??= (async () => {
      try {
        if ((await client.getCapabilities(signal)).session_exists !== 1) return null;
        const asked = new Set(candidates());
        const ids = [...asked];
        const existing = new Set<string>();
        for (let start = 0; start < ids.length; start += MAX_EXISTS_IDS) {
          const found = await client.sessionsExist(
            ids.slice(start, start + MAX_EXISTS_IDS),
            signal,
          );
          for (const id of found) existing.add(id);
        }
        return { asked, existing };
      } catch {
        return null;
      }
    })();
    return batched;
  };
  let listed: Promise<Set<string> | null> | undefined;
  const list = () => {
    listed ??= (async () => {
      try {
        const ids = new Set<string>();
        for (let page = 1; page <= 1000; page += 1) {
          const result = await client.listSessions({ page, pageSize: 200 });
          for (const session of result.sessions) ids.add(session.id);
          if (result.sessions.length === 0 || ids.size >= result.total_count) break;
        }
        return ids;
      } catch {
        return null;
      }
    })();
    return listed;
  };
  return async (backendId: string) => {
    const known = await batch();
    if (known?.asked.has(backendId)) return known.existing.has(backendId);
    if (known) {
      try {
        return (await client.sessionsExist([backendId], signal)).has(backendId);
      } catch {
        // Fall through to the slower checks, which never mistake an error for absence.
      }
    }
    if ((await list())?.has(backendId)) return true;
    try {
      await client.getSession(backendId, signal);
      return true;
    } catch (error) {
      if (historyErrorStatus(error) !== 404) throw error;
      return false;
    }
  };
}

function modelFor(item: LegacyConversation): KBrainModelRef {
  try {
    const selected = JSON.parse(item.selectedModelJson ?? "") as {
      customProviderId?: unknown;
      model?: unknown;
    };
    if (typeof selected.customProviderId === "string" && typeof selected.model === "string") {
      return { provider: selected.customProviderId, model: selected.model };
    }
  } catch {
    // Fall back to the persisted summary model.
  }
  return { provider: item.providerId, model: item.model };
}

function messageId(message: Message): string | undefined {
  const raw = (message as Message & { id?: unknown }).id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function canonicalMessage(value: unknown): KBrainMessage {
  if (!value || typeof value !== "object") {
    throw new Error("legacy history message is not an object");
  }
  const message = value as Message & {
    responseId?: unknown;
    provider?: unknown;
    model?: unknown;
    stopReason?: unknown;
    toolCalls?: unknown;
    timestamp?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  const conversionInput =
    message.role === "toolResult" && message.toolCallId.startsWith("kbrain-subagent:")
      ? { ...message, toolCallId: "legacy-migration-tool" }
      : message;
  const converted = contextToKBrainMessages({ messages: [conversionInput] })[0];
  if (converted?.role === "tool" && message.role === "toolResult")
    converted.tool_call_id = message.toolCallId;
  if (converted?.role === "assistant" && message.role === "assistant") {
    const toolCalls = Array.isArray(message.toolCalls)
      ? message.toolCalls
      : message.content.filter((part) => part.type === "toolCall");
    converted.tool_calls = toolCalls
      .filter((call): call is { id: string; name: string; arguments: unknown } =>
        Boolean(
          call &&
            typeof call === "object" &&
            typeof call.id === "string" &&
            typeof call.name === "string",
        ),
      )
      .map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  }
  if (!converted) throw new Error("legacy history contains an unsupported message");
  const id = messageId(message);
  const createdAt =
    typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? new Date(message.timestamp).toISOString()
      : undefined;
  if (converted.role === "user") {
    return { ...converted, ...(id ? { id } : {}), ...(createdAt ? { created_at: createdAt } : {}) };
  }
  if (converted.role === "tool") {
    return { ...converted, ...(id ? { id } : {}), ...(createdAt ? { created_at: createdAt } : {}) };
  }
  // An explicit row ID wins; responseId is only a fallback for rows without one.
  const assistantId =
    id ?? (typeof message.responseId === "string" ? message.responseId.trim() : "");
  return {
    ...converted,
    ...(assistantId ? { id: assistantId } : {}),
    ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    ...(typeof message.model === "string" ? { model: message.model } : {}),
    ...(typeof message.stopReason === "string" ? { stop_reason: message.stopReason } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(message.usage
      ? {
          usage: {
            input_tokens: message.usage.input,
            output_tokens: message.usage.output,
            cached_tokens: message.usage.cacheRead,
            cache_write_tokens: message.usage.cacheWrite,
          },
        }
      : {}),
  };
}

// summaryJson is retained in source_metadata, not replayed as an assistant answer.
export function canonicalMessagesForMigration(item: LegacyConversation): KBrainMessage[] {
  const out: KBrainMessage[] = [];
  try {
    const meta = JSON.parse(item.contextMetaJson) as { systemPrompt?: unknown };
    if (typeof meta.systemPrompt === "string" && meta.systemPrompt.trim()) {
      out.push({ role: "system", content: [{ type: "text", text: meta.systemPrompt }] });
    }
  } catch {
    // Context metadata is retained in source_metadata even if its optional prompt is malformed.
  }
  const seen = new Set<string>();
  const orderedSegments = [...item.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  for (const segment of orderedSegments) {
    const parsed: unknown = JSON.parse(segment.messagesJson);
    if (!Array.isArray(parsed))
      throw new Error(`legacy segment ${segment.segmentId} is not an array`);
    for (const value of parsed) {
      const converted = canonicalMessage(value);
      const id = converted.id?.trim();
      if (id && seen.has(id)) {
        const explicitId = messageId(value as Message);
        if (explicitId || converted.role !== "assistant") {
          throw new Error(`duplicate legacy message id ${id}`);
        }
        delete converted.id;
      } else if (id) {
        seen.add(id);
      }
      out.push(converted);
    }
  }
  return out;
}

function activeContextForMigration(item: LegacyConversation, messages: KBrainMessage[]) {
  const segments = [...item.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const activeIndex = item.activeSegmentIndex ?? segments.at(-1)?.segmentIndex;
  if (segments.length === 0) return undefined;
  const active = segments.find((segment) => segment.segmentIndex === activeIndex);
  if (!active || active !== segments.at(-1))
    throw new Error("invalid legacy active segment boundary");
  let cutoff = messages[0]?.role === "system" ? 1 : 0;
  for (const segment of segments) {
    if (segment === active) break;
    cutoff += JSON.parse(segment.messagesJson).length;
  }
  let summary = "";
  if (active.summaryJson) {
    const parsed = JSON.parse(active.summaryJson);
    if (parsed?.role !== "summary" || typeof parsed.content !== "string") {
      throw new Error("invalid legacy active summary");
    }
    summary = parsed.content;
  }
  return { cutoff, summary };
}

function validateCheckpointExport(checkpoint: LegacyCheckpoint | undefined) {
  if (checkpoint === undefined) return;
  if (
    !checkpoint ||
    !["available", "partial", "not_found", "unresolved"].includes(checkpoint.status) ||
    (checkpoint.records !== undefined && !Array.isArray(checkpoint.records)) ||
    (checkpoint.invalidLines !== undefined &&
      (!Array.isArray(checkpoint.invalidLines) ||
        checkpoint.invalidLines.some((line) => typeof line !== "string")))
  ) {
    throw new Error("invalid legacy checkpoint export");
  }
  for (const record of checkpoint.records ?? []) {
    if (
      !record ||
      record.schema !== 2 ||
      !["turn", "file", "dir", "error", "rewind"].includes(record.kind) ||
      [record.turnSeq, record.size, record.mtimeMs, record.capturedAt].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      [record.turnId, record.root, record.relPath].some((value) => typeof value !== "string") ||
      typeof record.existedBefore !== "boolean" ||
      (record.blobBase64 != null && typeof record.blobBase64 !== "string") ||
      (record.mode != null &&
        (!Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0xffffffff))
    ) {
      throw new Error("invalid legacy checkpoint record");
    }
  }
}

async function fingerprint(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type CachedMigration = {
  fingerprint: string;
  result: MigrationImportResult;
};

function migrationCacheKey(baseUrl: string) {
  return `liveagent.kbrain-history-migration.v1:${baseUrl}`;
}

function readMigrationCache(baseUrl: string): Record<string, CachedMigration> {
  try {
    const raw = globalThis.localStorage?.getItem(migrationCacheKey(baseUrl));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, CachedMigration>;
  } catch {
    return {};
  }
}

/**
 * Applies this page's changes onto the cache as stored now, so the legacy and Pi passes that run
 * side by side never overwrite each other's entries. `null` removes an entry.
 */
function writeMigrationCache(baseUrl: string, updates: Map<string, CachedMigration | null>) {
  if (updates.size === 0) return;
  const cache = readMigrationCache(baseUrl);
  for (const [id, entry] of updates) {
    if (entry) cache[id] = entry;
    else delete cache[id];
  }
  try {
    globalThis.localStorage?.setItem(migrationCacheKey(baseUrl), JSON.stringify(cache));
  } catch {
    // Storage is optional; K-brain fingerprint idempotency remains authoritative, and the
    // startup marker is only written once every result is confirmed in the stored cache.
  }
}

// A result that re-sending the same payload cannot change, so it can be cached by fingerprint.
// "partial" is computed by K-brain purely from the payload (missing blobs, invalid ledger lines,
// directory markers, turns without a message), so an unchanged conversation stays partial; the
// fingerprint covers the checkpoint export, so new artifacts produce a new fingerprint and a
// fresh import. "unresolved" stays retryable: the export may not have been readable yet.
function isStableMigrationResult(result: MigrationImportResult) {
  return (
    result.checkpoint === "available" ||
    result.checkpoint === "not_found" ||
    result.checkpoint === "partial"
  );
}

export function historyErrorStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error ? Number(error.status) : undefined;
}

export async function migrateLegacyHistoryPage(
  page: LegacyPage,
  options: HistoryMigrationOptions = {},
): Promise<{
  results: MigrationImportResult[];
  failures: MigrationFailure[];
  nextCursor?: string | null;
  complete: boolean;
}> {
  const connection = getConfiguredKBrainConnection();
  if (!connection) throw new Error("K-brain backend connection is not ready");
  const client = createKBrainClient({
    fetch: options.fetch,
  });
  const results: MigrationImportResult[] = [];
  const failures: MigrationFailure[] = [];
  const sessionExists =
    options.sessionExists ?? createSessionExistenceCheck(client, options.signal);
  const scope = kBrainStorageScope();
  const cache = readMigrationCache(scope);
  const cacheUpdates = new Map<string, CachedMigration | null>();
  const knownFailures = readHistoryMigrationFailures(scope);
  const failedRecords: HistoryMigrationFailureRecord[] = [];
  const succeededIds: string[] = [];
  for (const item of page.conversations) {
    reportProgress(options, "processing");
    let outcome: HistoryMigrationOutcome = "failed";
    let sourceFingerprint = "";
    let bodyBytes: number | undefined;
    // Only the import POST speaks for the payload; earlier existence checks (GET) failing
    // with 401/403/500 say nothing about whether this conversation can ever be imported.
    let importAttempted = false;
    // Converting the exported row is local and depends only on its content.
    let converted = false;
    try {
      validateCheckpointExport(item.checkpoint);
      const messages = canonicalMessagesForMigration(item);
      const activeContext = activeContextForMigration(item, messages);
      sourceFingerprint = await fingerprint({ item, messages });
      converted = true;
      const known = options.retryKnownFailures
        ? undefined
        : knownDeterministicFailure(knownFailures, item.id, sourceFingerprint);
      if (known) {
        outcome = "skipped";
        // Same content failed the same way before; re-sending would only fail again.
        failures.push({
          sourceId: item.id,
          error: known.message,
          kind: known.kind,
          title: known.title,
          bytes: known.bytes,
          skipped: true,
        });
        continue;
      }
      const cached = cache[item.id];
      // The manual "Import old conversations" action re-sends partial results on purpose.
      const reusable =
        cached?.fingerprint === sourceFingerprint &&
        isStableMigrationResult(cached.result) &&
        !(options.retryKnownFailures && cached.result.checkpoint === "partial");
      if (cached && reusable) {
        if (await sessionExists(cached.result.backend_id)) {
          const cachedResult: MigrationImportResult = {
            ...cached.result,
            status: "already_imported",
          };
          setKBrainSessionId(item.id, cachedResult.backend_id);
          results.push(cachedResult);
          outcome = cachedResult.checkpoint === "partial" ? "partial" : "alreadyImported";
          continue;
        }
      }
      const payload = {
        source_id: item.id,
        source_fingerprint: sourceFingerprint,
        conversation_id: item.id,
        title: item.title,
        cwd: item.cwd,
        model: modelFor(item),
        created_at: new Date(item.createdAt).toISOString(),
        updated_at: new Date(item.updatedAt).toISOString(),
        pinned: item.isPinned,
        shared: item.isShared,
        share_token: item.shareToken,
        share_redact_tool: item.redactToolContent,
        messages,
        active_context: activeContext,
        checkpoint: item.checkpoint ?? {
          status: "unresolved",
          nativePath: `~/.liveagent/checkpoints/${item.id}`,
        },
        source_metadata: {
          original: item,
          session_id: item.sessionId,
          selected_model_json: item.selectedModelJson,
          context_meta_json: item.contextMetaJson,
          active_segment_index: item.activeSegmentIndex,
          total_segment_count: item.totalSegmentCount,
          total_message_count: item.totalMessageCount,
          segments: [...item.segments]
            .sort((left, right) => left.segmentIndex - right.segmentIndex)
            .map((segment) => ({
              index: segment.segmentIndex,
              id: segment.segmentId,
              summary_json: segment.summaryJson,
              message_count: segment.messageCount,
              start_message_id: segment.startMessageId,
              end_message_id: segment.endMessageId,
              created_at: segment.createdAt,
              updated_at: segment.updatedAt,
              messages_json: segment.messagesJson,
              active: segment.active === true || segment.segmentIndex === item.activeSegmentIndex,
            })),
          checkpoint: item.checkpoint ?? {
            status: "unresolved",
            nativePath: `~/.liveagent/checkpoints/${item.id}`,
            reason: "checkpoint export was not supplied",
          },
        },
      };
      bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
      reportProgress(options, "importing");
      importAttempted = true;
      const result = await client.importLegacyHistory(payload, options.signal);
      if (
        result.source_id !== item.id ||
        result.backend_id !== item.id ||
        !["imported", "already_imported"].includes(result.status)
      ) {
        throw new Error("legacy history import response identity mismatch");
      }
      setKBrainSessionId(item.id, result.backend_id);
      if (isStableMigrationResult(result)) {
        cache[item.id] = { fingerprint: sourceFingerprint, result };
        cacheUpdates.set(item.id, cache[item.id]);
      }
      succeededIds.push(item.id);
      results.push(result);
      outcome = ["partial", "unresolved"].includes(result.checkpoint)
        ? "partial"
        : result.status === "already_imported"
          ? "alreadyImported"
          : "imported";
    } catch (error) {
      const status = historyErrorStatus(error);
      // The backend persists deletion intent across restarts and clients.
      if (status === 410) {
        outcome = "skipped";
        succeededIds.push(item.id);
        // A deleted conversation is not a cached import any more; keeping it would make every
        // startup existence check report a missing session.
        if (cache[item.id]) {
          delete cache[item.id];
          cacheUpdates.set(item.id, null);
        }
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      const kind = importAttempted
        ? classifyHistoryMigrationFailure({
            status: Number.isFinite(status) ? status : undefined,
            message,
            bytes: bodyBytes,
          })
        : "transient";
      failures.push({
        sourceId: item.id,
        error: message,
        kind,
        title: item.title,
        bytes: bodyBytes,
        ...(converted ? {} : { invalidSource: true }),
      });
      if (sourceFingerprint) {
        failedRecords.push({
          sourceId: item.id,
          title: item.title,
          fingerprint: sourceFingerprint,
          kind,
          bytes: bodyBytes,
          message,
          failedAt: Date.now(),
        });
      }
    } finally {
      reportProgress(options, "settled", outcome);
    }
  }
  writeMigrationCache(scope, cacheUpdates);
  if (failedRecords.length > 0 || succeededIds.length > 0) {
    writeHistoryMigrationFailures(
      scope,
      mergeHistoryMigrationFailures(readHistoryMigrationFailures(scope), {
        succeeded: succeededIds,
        failed: failedRecords,
      }),
    );
  }
  return {
    results,
    failures,
    nextCursor: page.nextCursor,
    complete:
      page.complete &&
      failures.length === 0 &&
      results.every(
        (result) => result.checkpoint === "available" || result.checkpoint === "not_found",
      ),
  };
}

const recoveries = new Map<string, Promise<boolean>>();

export async function recoverLegacyHistory(id: string): Promise<boolean> {
  if (!isTauriHost() || !getConfiguredKBrainConnection()) return false;
  const key = `${kBrainStorageScope()}:${id}`;
  const pending = recoveries.get(key);
  if (pending) return pending;
  const recovery = (async () => {
    for (const command of ["legacy_history_migration_page", "pi_history_migration_page"] as const) {
      let cursor: string | undefined;
      do {
        const page = await invoke<LegacyPage>(command, { cursor });
        const item = page.conversations.find((item) => item.id === id);
        if (item) {
          const migrated = await migrateLegacyHistoryPage({
            conversations: [item],
            complete: true,
          });
          if (migrated.failures.length) throw new Error(migrated.failures[0].error);
          return migrated.results.length === 1;
        }
        if (page.complete) break;
        if (!page.nextCursor || page.nextCursor === cursor) {
          throw new Error(`${command} did not advance its cursor`);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }
    return false;
  })();
  recoveries.set(key, recovery);
  try {
    return await recovery;
  } finally {
    recoveries.delete(key);
  }
}

/** Bump when the legacy export or its conversion changes, so every user runs one full pass. */
const MIGRATION_MARKER_FORMAT = 1;

function migrationMarker(signature: string) {
  // Read at call time: an upgrade of the app may change what an unchanged database exports.
  const appVersion = typeof __LIVEAGENT_APP_VERSION__ === "string" ? __LIVEAGENT_APP_VERSION__ : "";
  return `${MIGRATION_MARKER_FORMAT}|${appVersion}|${signature}`;
}

function migrationCompletionKey(scope: string) {
  return `liveagent.kbrain-history-migration-complete.v1:${scope}`;
}

/** A complete legacy pass: the source it covered and the K-brain sessions it confirmed. */
type MigrationCompletion = { marker: string; backendIds: string[] };

function readMigrationCompletion(scope: string): MigrationCompletion | null {
  try {
    const raw = globalThis.localStorage?.getItem(migrationCompletionKey(scope));
    const parsed = raw ? (JSON.parse(raw) as Partial<MigrationCompletion>) : null;
    if (
      typeof parsed?.marker !== "string" ||
      !Array.isArray(parsed.backendIds) ||
      parsed.backendIds.some((id) => typeof id !== "string")
    ) {
      return null;
    }
    return { marker: parsed.marker, backendIds: parsed.backendIds };
  } catch {
    return null;
  }
}

function writeMigrationCompletion(scope: string, completion: MigrationCompletion) {
  try {
    globalThis.localStorage?.setItem(migrationCompletionKey(scope), JSON.stringify(completion));
  } catch {
    // Without the marker the next launch simply runs the full pass again.
  }
}

/**
 * Whether the sessions a complete legacy pass confirmed are all still in K-brain, answered only
 * by a backend with the metadata-only `session_exists` check. Older backends always get the full
 * pass, so a wiped K-brain store is still repaired by re-importing. Only that pass's own sessions
 * count: entries no pass can clear (Pi sources that are gone, conversations skipped as known
 * failures) must not keep the marker from ever applying.
 */
async function migratedSessionsStillExist(
  backendIds: readonly string[],
  options: HistoryMigrationOptions,
): Promise<boolean> {
  try {
    const client = createKBrainClient({ fetch: options.fetch });
    if ((await client.getCapabilities(options.signal)).session_exists !== 1) return false;
    const ids = [...new Set(backendIds)];
    for (let start = 0; start < ids.length; start += MAX_EXISTS_IDS) {
      const chunk = ids.slice(start, start + MAX_EXISTS_IDS);
      const found = await client.sessionsExist(chunk, options.signal);
      if (chunk.some((id) => !found.has(id))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function readLegacySignature(): Promise<string | null> {
  try {
    const signature = await invoke<string | null>("legacy_history_migration_signature");
    return typeof signature === "string" && signature ? signature : null;
  } catch {
    return null;
  }
}

async function migrateHistorySourceOnce(
  command: "legacy_history_migration_page" | "pi_history_migration_page",
  options: HistoryMigrationOptions = {},
) {
  options = {
    ...options,
    progressSource: command === "legacy_history_migration_page" ? "legacy" : "pi",
  };
  if (!isTauriHost() || !getConfiguredKBrainConnection()) {
    reportProgress(options, "done");
    return { results: [], failures: [], complete: true };
  }
  // Read before the pass, so a change made while it runs is never covered by its marker.
  const scope = kBrainStorageScope();
  const signature =
    command === "legacy_history_migration_page" ? await readLegacySignature() : null;
  const completion =
    signature && !options.retryKnownFailures ? readMigrationCompletion(scope) : null;
  if (
    signature &&
    completion?.marker === migrationMarker(signature) &&
    (await migratedSessionsStillExist(completion.backendIds, options))
  ) {
    reportProgress(options, "done");
    return { results: [], failures: [], complete: true };
  }
  let cursor: string | undefined;
  const all: MigrationImportResult[] = [];
  const failures: MigrationFailure[] = [];
  try {
    do {
      reportProgress(options, "reading");
      const page = await invoke<LegacyPage>(command, { cursor });
      const migrated = await migrateLegacyHistoryPage(page, options);
      all.push(...migrated.results);
      failures.push(...migrated.failures);
      if (page.complete) break;
      if (!migrated.nextCursor || migrated.nextCursor === cursor) {
        throw new Error(`${command} did not advance its cursor`);
      }
      cursor = migrated.nextCursor;
    } while (cursor !== undefined);
    // Deterministic failures are listed for the user and skipped at startup anyway; a transient
    // failure or an unresolved checkpoint export still needs the next launch to retry.
    // The marker vouches for these results through the cache, so every one of them must have
    // reached storage (a quota failure or a lost write leaves the next launch the full pass).
    const stored = readMigrationCache(scope);
    if (
      signature &&
      all.every(
        (result) =>
          isStableMigrationResult(result) &&
          stored[result.source_id]?.result?.backend_id === result.backend_id,
      ) &&
      failures.every(
        (failure) =>
          failure.kind !== undefined && (failure.kind !== "transient" || failure.invalidSource),
      )
    ) {
      writeMigrationCompletion(scope, {
        marker: migrationMarker(signature),
        backendIds: all.map((result) => result.backend_id),
      });
    }
    reportProgress(options, "done");
  } catch (error) {
    reportProgress(options, "error");
    failures.push({
      sourceId: command,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    results: all,
    failures,
    complete:
      failures.length === 0 &&
      all.every((result) => result.checkpoint === "available" || result.checkpoint === "not_found"),
  };
}

export async function migrateLegacyHistoryOnce(options: HistoryMigrationOptions = {}) {
  return migrateHistorySourceOnce("legacy_history_migration_page", options);
}

export async function migratePiHistoryOnce(options: HistoryMigrationOptions = {}) {
  return migrateHistorySourceOnce("pi_history_migration_page", options);
}

export async function migrateAllHistoryOnce(options: HistoryMigrationOptions = {}) {
  const shared: HistoryMigrationOptions = {
    ...options,
    sessionExists:
      options.sessionExists ??
      createSessionExistenceCheck(createKBrainClient({ fetch: options.fetch }), options.signal),
  };
  const [legacy, pi] = await Promise.all([
    migrateLegacyHistoryOnce(shared),
    migratePiHistoryOnce(shared),
  ]);
  return {
    results: [...legacy.results, ...pi.results],
    failures: [...legacy.failures, ...pi.failures],
    complete: legacy.complete && pi.complete,
  };
}
