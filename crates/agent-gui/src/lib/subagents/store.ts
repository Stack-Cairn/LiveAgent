import type { Tool } from "@earendil-works/pi-ai";

import {
  type ConversationViewState,
  normalizeConversationState,
  type StoredContextSegment,
} from "../chat/conversation/conversationState";
import {
  type SubagentMessageAppendInput,
  type SubagentPruneResult,
  type SubagentRunPruneInput,
  type SubagentRunSaveInput,
  type SubagentRunSegmentRecord,
  type SubagentStoreIpc,
  tauriSubagentStoreIpc,
} from "./ipc/store";
import {
  AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SUBAGENT_CONTEXT_SCHEMA_VERSION,
  type SubagentIdentity,
  type SubagentMessageRecord,
  type SubagentMode,
  type SubagentRunStatus,
  type SubagentRunSummary,
} from "./types";
import { normalizeErrorMessage, runWithConcurrency } from "./utils";

const DEFAULT_WARMUP_LIMIT = 16;
const DEFAULT_WARMUP_CONCURRENCY = 2;
const DEFAULT_MAX_HYDRATED_ENTRIES = 64;
const HYDRATE_LIST_LIMIT = 200;
const BUS_LIST_LIMIT = 80;

export type SubagentPersistRunInput = {
  id: string;
  parentToolCallId: string;
  agentId: string;
  agentIndex: number;
  agentTotal: number;
  prompt: string;
  mode: SubagentMode;
  status: SubagentRunStatus;
  providerId: string;
  model: string;
  sessionId?: string;
  workdir?: string;
  worktreeRoot?: string;
  branchName?: string;
  roundCount: number;
  toolCallCount: number;
  compactionCount: number;
  summary?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  state: ConversationViewState;
};

type HydratedEntry = {
  runId: string;
  segments: StoredContextSegment[];
  updatedAt: number;
};

/**
 * Conversation-scoped single source of truth for subagent roster, latest run
 * summaries, hydrated private contexts (LRU), and the message bus. Everything
 * reads and writes through this store; SQLite (behind the ipc port) is its
 * persistent tier.
 */
export type SubagentConversationStore = {
  readonly conversationId: string;
  ready: () => Promise<void>;
  listIdentities: () => SubagentIdentity[];
  getIdentity: (agentId: string) => SubagentIdentity | undefined;
  knownAgentIds: () => string[];
  latestRunsByAgent: () => Map<string, SubagentRunSummary>;
  getLatestRun: (agentId: string) => SubagentRunSummary | undefined;
  upsertIdentity: (identity: SubagentIdentity) => Promise<SubagentIdentity>;
  saveRunState: (input: SubagentPersistRunInput) => Promise<void>;
  loadRunState: (input: {
    runSummary: SubagentRunSummary;
    systemPrompt: string;
    tools: Tool[];
  }) => Promise<ConversationViewState | null>;
  listBusMessages: (forAgentId?: string) => Promise<SubagentMessageRecord[]>;
  appendBusMessage: (
    input: Omit<SubagentMessageAppendInput, "parentConversationId">,
  ) => Promise<SubagentMessageRecord>;
  warmup: () => void;
  invalidate: () => void;
  dispose: () => void;
};

function segmentToSaveInput(segment: StoredContextSegment) {
  return {
    segmentIndex: segment.segmentIndex,
    segmentId: segment.segmentId,
    summaryJson: segment.summary ? JSON.stringify(segment.summary) : undefined,
    messagesJson: JSON.stringify(segment.messages),
    messageCount: segment.messageCount,
    startMessageId: segment.startMessageId,
    endMessageId: segment.endMessageId,
  };
}

function parseStoredSegments(records: SubagentRunSegmentRecord[]): StoredContextSegment[] | null {
  try {
    const segments: StoredContextSegment[] = records.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      segmentId: segment.segmentId,
      summary: segment.summaryJson ? JSON.parse(segment.summaryJson) : undefined,
      messages: JSON.parse(segment.messagesJson || "[]"),
      messageCount: segment.messageCount,
      startMessageId: segment.startMessageId,
      endMessageId: segment.endMessageId,
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
    }));
    return segments.length > 0 ? segments : null;
  } catch (error) {
    console.warn("Failed to parse stored subagent run segments", error);
    return null;
  }
}

export function createSubagentConversationStore(params: {
  conversationId: string;
  ipc?: SubagentStoreIpc;
  warmupLimit?: number;
  warmupConcurrency?: number;
  maxHydratedEntries?: number;
}): SubagentConversationStore {
  const conversationId = params.conversationId.trim();
  const ipc = params.ipc ?? tauriSubagentStoreIpc;
  const warmupLimit = Math.max(1, Math.floor(params.warmupLimit ?? DEFAULT_WARMUP_LIMIT));
  const warmupConcurrency = Math.max(
    1,
    Math.floor(params.warmupConcurrency ?? DEFAULT_WARMUP_CONCURRENCY),
  );
  const maxHydratedEntries = Math.max(
    1,
    Math.floor(params.maxHydratedEntries ?? DEFAULT_MAX_HYDRATED_ENTRIES),
  );

  const identities = new Map<string, SubagentIdentity>();
  const latestRuns = new Map<string, SubagentRunSummary>();
  const hydrated = new Map<string, HydratedEntry>();
  let readyPromise: Promise<void> | null = null;
  let generation = 0;

  function pruneHydrated() {
    while (hydrated.size > maxHydratedEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of hydrated) {
        if (entry.updatedAt < oldestAt) {
          oldestAt = entry.updatedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      hydrated.delete(oldestKey);
    }
  }

  function cacheHydrated(agentId: string, runId: string, segments: StoredContextSegment[]) {
    hydrated.set(agentId, { runId, segments, updatedAt: Date.now() });
    pruneHydrated();
  }

  function rememberRunSummary(summary: SubagentRunSummary) {
    const existing = latestRuns.get(summary.agentId);
    if (!existing || existing.updatedAt <= summary.updatedAt) {
      latestRuns.set(summary.agentId, summary);
    }
  }

  async function hydrate() {
    if (!conversationId) return;
    const [identityRecords, runRecords] = await Promise.all([
      ipc.listIdentities({ parentConversationId: conversationId, limit: HYDRATE_LIST_LIMIT }),
      ipc.listRuns({ parentConversationId: conversationId, limit: HYDRATE_LIST_LIMIT }),
    ]);
    identities.clear();
    for (const identity of identityRecords) {
      const agentId = identity.agentId.trim();
      if (!agentId || identities.has(agentId)) continue;
      identities.set(agentId, identity);
    }
    latestRuns.clear();
    for (const run of runRecords) {
      const agentId = run.agentId.trim();
      if (!agentId) continue;
      rememberRunSummary({ ...run, agentId });
    }
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = hydrate().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  async function loadSegments(runId: string): Promise<StoredContextSegment[] | null> {
    const record = await ipc.loadRun(runId);
    if (!record) return null;
    if (record.run.contextSchemaVersion !== SUBAGENT_CONTEXT_SCHEMA_VERSION) return null;
    return parseStoredSegments(record.segments);
  }

  return {
    conversationId,
    ready,
    listIdentities: () => [...identities.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    getIdentity: (agentId) => identities.get(agentId.trim()),
    knownAgentIds: () => [...identities.keys()],
    latestRunsByAgent: () => new Map(latestRuns),
    getLatestRun: (agentId) => latestRuns.get(agentId.trim()),

    async upsertIdentity(identity) {
      const stored = await ipc.upsertIdentity({
        parentConversationId: conversationId,
        agentId: identity.agentId,
        name: identity.name,
        role: identity.role,
        identityPrompt: identity.identityPrompt,
        templateId: identity.templateId,
        lastMode: identity.lastMode,
        createdToolCallId: identity.createdToolCallId,
      });
      identities.set(stored.agentId, stored);
      return stored;
    },

    async saveRunState(input) {
      const summary: SubagentRunSummary = {
        id: input.id,
        parentConversationId: conversationId,
        parentToolCallId: input.parentToolCallId,
        agentId: input.agentId,
        agentIndex: input.agentIndex,
        agentTotal: input.agentTotal,
        prompt: input.prompt,
        mode: input.mode,
        status: input.status,
        providerId: input.providerId,
        model: input.model,
        sessionId: input.sessionId,
        workdir: input.workdir,
        worktreeRoot: input.worktreeRoot,
        branchName: input.branchName,
        contextSchemaVersion: SUBAGENT_CONTEXT_SCHEMA_VERSION,
        activeSegmentIndex: input.state.meta.activeSegmentIndex,
        totalSegmentCount: input.state.meta.totalSegmentCount,
        totalMessageCount: input.state.meta.totalMessageCount,
        roundCount: input.roundCount,
        toolCallCount: input.toolCallCount,
        compactionCount: input.compactionCount,
        summary: input.summary,
        error: input.error,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        updatedAt: Date.now(),
      };
      const { updatedAt: _updatedAt, ...header } = summary;
      const saveInput: SubagentRunSaveInput = {
        run: header,
        segments: input.state.segments.map(segmentToSaveInput),
      };
      // The in-memory tiers update even if the durable write fails: the run
      // really happened and the caller surfaces the persistence warning.
      rememberRunSummary(summary);
      cacheHydrated(input.agentId, input.id, input.state.segments);
      await ipc.saveRun(saveInput);
    },

    async loadRunState({ runSummary, systemPrompt, tools }) {
      const agentId = runSummary.agentId.trim();
      const cached = hydrated.get(agentId);
      let segments = cached && cached.runId === runSummary.id ? cached.segments : null;
      if (!segments) {
        try {
          segments = await loadSegments(runSummary.id);
        } catch (error) {
          console.warn(normalizeErrorMessage(error, "Failed to load stored subagent run state"));
          return null;
        }
        if (!segments) return null;
        cacheHydrated(agentId, runSummary.id, segments);
      } else if (cached) {
        cached.updatedAt = Date.now();
      }
      return normalizeConversationState({
        meta: { systemPrompt, tools },
        segments,
      });
    },

    listBusMessages(forAgentId) {
      if (!conversationId) return Promise.resolve([]);
      return ipc.listMessages({
        parentConversationId: conversationId,
        forAgentId,
        limit: BUS_LIST_LIMIT,
      });
    },

    appendBusMessage(input) {
      return ipc.appendMessage({ ...input, parentConversationId: conversationId });
    },

    warmup() {
      if (!conversationId) return;
      generation += 1;
      const startedGeneration = generation;
      void (async () => {
        try {
          await ready();
        } catch (error) {
          console.warn("Failed to warm up subagent store", error);
          return;
        }
        if (generation !== startedGeneration) return;
        const candidates = [...latestRuns.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, warmupLimit)
          .filter((run) => hydrated.get(run.agentId)?.runId !== run.id);
        await runWithConcurrency(candidates, warmupConcurrency, async (run) => {
          if (generation !== startedGeneration) return;
          try {
            const segments = await loadSegments(run.id);
            if (!segments || generation !== startedGeneration) return;
            cacheHydrated(run.agentId, run.id, segments);
          } catch {
            // Warmup is best-effort; resume falls back to a direct load.
          }
        });
      })();
    },

    invalidate() {
      generation += 1;
      identities.clear();
      latestRuns.clear();
      hydrated.clear();
      readyPromise = null;
    },

    dispose() {
      generation += 1;
      identities.clear();
      latestRuns.clear();
      hydrated.clear();
      readyPromise = null;
    },
  };
}

export type SubagentStoreManager = {
  get: (conversationId: string) => SubagentConversationStore;
  warmup: (conversationId: string) => void;
  invalidate: (conversationId: string) => void;
  dispose: (conversationId: string) => void;
  disposeAll: () => void;
};

export function createSubagentStoreManager(options?: {
  ipc?: SubagentStoreIpc;
}): SubagentStoreManager {
  const stores = new Map<string, SubagentConversationStore>();

  function get(conversationId: string) {
    const id = conversationId.trim();
    let store = stores.get(id);
    if (!store) {
      store = createSubagentConversationStore({ conversationId: id, ipc: options?.ipc });
      stores.set(id, store);
    }
    return store;
  }

  return {
    get,
    warmup(conversationId) {
      const id = conversationId.trim();
      if (!id) return;
      get(id).warmup();
    },
    invalidate(conversationId) {
      stores.get(conversationId.trim())?.invalidate();
    },
    dispose(conversationId) {
      const id = conversationId.trim();
      stores.get(id)?.dispose();
      stores.delete(id);
    },
    disposeAll() {
      for (const store of stores.values()) store.dispose();
      stores.clear();
    },
  };
}

/**
 * Parent tool-call ids whose subagent artifacts must survive an edit/resend
 * prune: any Agent or SendMessage tool result still present in the surviving
 * parent transcript.
 */
export function collectRetainedSubagentParentToolCallIds(state: ConversationViewState) {
  const keep = new Set<string>();
  for (const segment of state.segments) {
    for (const message of segment.messages) {
      if (message.role !== "toolResult") continue;
      const details = message.details as { kind?: unknown } | undefined;
      const isSubagentParentTool =
        message.toolName === AGENT_TOOL_NAME ||
        message.toolName === SEND_MESSAGE_TOOL_NAME ||
        details?.kind === "subagent_message";
      if (!isSubagentParentTool) continue;
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId.trim() : "";
      if (toolCallId) keep.add(toolCallId);
    }
  }
  return [...keep];
}

export async function pruneSubagentRunsForConversation(
  input: SubagentRunPruneInput,
  ipc: SubagentStoreIpc = tauriSubagentStoreIpc,
): Promise<SubagentPruneResult> {
  const parentConversationId = input.parentConversationId.trim();
  if (!parentConversationId) {
    return {
      removedRunIds: [],
      removedMessageCount: 0,
      removedIdentityCount: 0,
      worktreeCleanupErrors: [],
    };
  }
  return ipc.pruneRuns({
    parentConversationId,
    keepParentToolCallIds: input.keepParentToolCallIds.map((id) => id.trim()).filter(Boolean),
  });
}
