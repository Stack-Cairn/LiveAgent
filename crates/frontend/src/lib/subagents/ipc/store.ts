import { invoke } from "@tauri-apps/api/core";

import type {
  SubagentIdentity,
  SubagentMessageChannel,
  SubagentMessageRecord,
  SubagentMode,
  SubagentRunSummary,
} from "../types";

export type SubagentIdentityUpsertInput = {
  parentConversationId: string;
  agentId: string;
  name: string;
  role: string;
  identityPrompt: string;
  templateId?: string;
  lastMode: SubagentMode;
  createdToolCallId?: string;
};

export type SubagentIdentityListInput = {
  parentConversationId: string;
  limit?: number;
};

/** Run header persisted on every save; the server stamps updatedAt. */
export type SubagentRunSaveHeader = Omit<SubagentRunSummary, "updatedAt">;

export type SubagentRunSegmentSaveInput = {
  segmentIndex: number;
  segmentId: string;
  summaryJson?: string;
  messagesJson: string;
  messageCount: number;
  startMessageId?: string;
  endMessageId?: string;
};

export type SubagentRunSaveInput = {
  run: SubagentRunSaveHeader;
  segments: SubagentRunSegmentSaveInput[];
};

export type SubagentRunSegmentRecord = SubagentRunSegmentSaveInput & {
  createdAt: number;
  updatedAt: number;
};

export type SubagentRunStateRecord = {
  run: SubagentRunSummary;
  segments: SubagentRunSegmentRecord[];
};

export type SubagentRunListInput = {
  parentConversationId: string;
  limit?: number;
};

export type SubagentMessageAppendInput = {
  parentConversationId: string;
  senderId: string;
  senderName?: string;
  recipientId: string;
  recipientName?: string;
  channel: SubagentMessageChannel;
  subject?: string;
  bodyMarkdown: string;
  sourceRunId?: string;
  sourceToolCallId?: string;
};

export type SubagentMessageListInput = {
  parentConversationId: string;
  forAgentId?: string;
  limit?: number;
};

export type SubagentRunPruneInput = {
  parentConversationId: string;
  keepParentToolCallIds: string[];
};

export type SubagentPruneResult = {
  removedRunIds: string[];
  removedMessageCount: number;
  removedIdentityCount: number;
  worktreeCleanupErrors: string[];
};

/**
 * Rust serializes Option::None as null; TS models optionality as absent.
 * Normalize at the wire boundary so the rest of the code never sees null.
 */
function stripNulls<T extends object>(record: T): T {
  const output = { ...record } as Record<string, unknown>;
  for (const key of Object.keys(output)) {
    if (output[key] === null) delete output[key];
  }
  return output as T;
}

/**
 * Persistence port for the subagent store. The Tauri implementation is the
 * only production implementation; tests inject recorders.
 */
export type SubagentStoreIpc = {
  upsertIdentity: (input: SubagentIdentityUpsertInput) => Promise<SubagentIdentity>;
  listIdentities: (input: SubagentIdentityListInput) => Promise<SubagentIdentity[]>;
  saveRun: (input: SubagentRunSaveInput) => Promise<void>;
  listRuns: (input: SubagentRunListInput) => Promise<SubagentRunSummary[]>;
  loadRun: (id: string) => Promise<SubagentRunStateRecord | null>;
  pruneRuns: (input: SubagentRunPruneInput) => Promise<SubagentPruneResult>;
  appendMessage: (input: SubagentMessageAppendInput) => Promise<SubagentMessageRecord>;
  listMessages: (input: SubagentMessageListInput) => Promise<SubagentMessageRecord[]>;
};

export function createTauriSubagentStoreIpc(): SubagentStoreIpc {
  // Writes for one run are serialized so an incremental turn-boundary save can
  // never overtake the final completed/failed save.
  const runWriteQueues = new Map<string, Promise<void>>();
  const enqueueRunWrite = (runId: string, task: () => Promise<void>) => {
    const previous = runWriteQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    runWriteQueues.set(runId, next);
    const settle = () => {
      if (runWriteQueues.get(runId) === next) runWriteQueues.delete(runId);
    };
    next.then(settle, settle);
    return next;
  };

  return {
    upsertIdentity: async (input) =>
      stripNulls(await invoke<SubagentIdentity>("subagent_identity_upsert", { input })),
    listIdentities: async (input) =>
      (await invoke<SubagentIdentity[]>("subagent_identity_list", { input })).map(stripNulls),
    saveRun: (input) =>
      enqueueRunWrite(input.run.id, async () => {
        await invoke("subagent_run_save", { input });
      }),
    listRuns: async (input) =>
      (await invoke<SubagentRunSummary[]>("subagent_run_list", { input })).map(stripNulls),
    loadRun: async (id) => {
      const record = await invoke<SubagentRunStateRecord | null>("subagent_run_load", {
        input: { id },
      });
      if (!record) return null;
      return {
        run: stripNulls(record.run),
        segments: record.segments.map(stripNulls),
      };
    },
    pruneRuns: (input) => invoke<SubagentPruneResult>("subagent_run_prune", { input }),
    appendMessage: async (input) =>
      stripNulls(await invoke<SubagentMessageRecord>("subagent_message_append", { input })),
    listMessages: async (input) =>
      (await invoke<SubagentMessageRecord[]>("subagent_message_list", { input })).map(stripNulls),
  };
}

export const tauriSubagentStoreIpc = createTauriSubagentStoreIpc();
