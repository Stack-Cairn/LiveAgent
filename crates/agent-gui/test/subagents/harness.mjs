export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-memory SubagentStoreIpc fake. Mirrors the production Tauri impl's
 * per-run write serialization so incremental saves cannot overtake finals.
 */
export function createFakeStoreIpc(options = {}) {
  const identities = new Map();
  const runs = new Map();
  const messages = [];
  const issuedSaves = [];
  const appliedSaves = [];
  const loadRunIds = [];
  const pruneCalls = [];
  const runWriteQueues = new Map();
  let clock = 1_000;
  const nextNow = () => (clock += 1);
  let upsertIdentityCount = 0;

  const api = {
    identities,
    runs,
    messages,
    issuedSaves,
    appliedSaves,
    loadRunIds,
    pruneCalls,
    get upsertIdentityCount() {
      return upsertIdentityCount;
    },

    seedIdentity(record) {
      identities.set(`${record.parentConversationId}:${record.agentId}`, { ...record });
    },
    seedRun(record) {
      runs.set(record.run.id, structuredClone(record));
    },

    async upsertIdentity(input) {
      upsertIdentityCount += 1;
      if (options.upsertIdentityError) throw options.upsertIdentityError;
      const key = `${input.parentConversationId}:${input.agentId}`;
      const existing = identities.get(key);
      const record = {
        parentConversationId: input.parentConversationId,
        agentId: input.agentId,
        name: input.name,
        role: input.role,
        identityPrompt: input.identityPrompt,
        templateId: input.templateId,
        lastMode: input.lastMode,
        createdToolCallId: existing?.createdToolCallId ?? input.createdToolCallId,
        createdAt: existing?.createdAt ?? nextNow(),
        updatedAt: nextNow(),
      };
      identities.set(key, record);
      return { ...record };
    },

    async listIdentities({ parentConversationId }) {
      return [...identities.values()]
        .filter((identity) => identity.parentConversationId === parentConversationId)
        .map((identity) => ({ ...identity }));
    },

    saveRun(input) {
      issuedSaves.push(structuredClone(input));
      const previous = runWriteQueues.get(input.run.id) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const delayMs =
            typeof options.saveRunDelayMs === "function"
              ? options.saveRunDelayMs(input)
              : (options.saveRunDelayMs ?? 0);
          if (delayMs > 0) await sleep(delayMs);
          const error =
            typeof options.saveRunError === "function"
              ? options.saveRunError(input)
              : options.saveRunError;
          if (error) throw error;
          const now = nextNow();
          const stored = {
            run: { ...input.run, updatedAt: now },
            segments: input.segments.map((segment) => ({
              ...segment,
              createdAt: now,
              updatedAt: now,
            })),
          };
          runs.set(input.run.id, structuredClone(stored));
          appliedSaves.push(structuredClone(stored));
        });
      runWriteQueues.set(input.run.id, next);
      return next;
    },

    async listRuns({ parentConversationId }) {
      return [...runs.values()]
        .filter((record) => record.run.parentConversationId === parentConversationId)
        .map((record) => structuredClone(record.run))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async loadRun(id) {
      loadRunIds.push(id);
      if (options.loadRunError) throw options.loadRunError;
      const record = runs.get(id);
      return record ? structuredClone(record) : null;
    },

    async pruneRuns(input) {
      pruneCalls.push(structuredClone(input));
      return (
        options.pruneResult ?? {
          removedRunIds: [],
          removedMessageCount: 0,
          removedIdentityCount: 0,
          worktreeCleanupErrors: [],
        }
      );
    },

    async appendMessage(input) {
      if (options.appendMessageError) throw options.appendMessageError;
      const record = {
        id: messages.length + 1,
        parentConversationId: input.parentConversationId,
        seq: messages.length + 1,
        senderId: input.senderId,
        senderName: input.senderName,
        recipientId: input.recipientId,
        recipientName: input.recipientName,
        channel: input.channel,
        subject: input.subject,
        bodyMarkdown: input.bodyMarkdown,
        sourceRunId: input.sourceRunId,
        sourceToolCallId: input.sourceToolCallId,
        createdAt: nextNow(),
      };
      messages.push(record);
      return { ...record };
    },

    async listMessages({ parentConversationId, forAgentId }) {
      return messages
        .filter((message) => {
          if (message.parentConversationId !== parentConversationId) return false;
          if (!forAgentId) return true;
          return (
            message.recipientId === forAgentId ||
            message.recipientId === "*" ||
            message.senderId === forAgentId
          );
        })
        .map((message) => ({ ...message }));
    },
  };
  return api;
}
