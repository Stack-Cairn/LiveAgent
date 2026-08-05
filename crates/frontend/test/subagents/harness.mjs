import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const agentRunnerModulePath = path.join(rootDir, "src/lib/chat/runner/agentRunner.ts");
export const compactionControllerModulePath = path.join(
  rootDir,
  "src/lib/chat/compaction/controller.ts",
);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createAssistant(text, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: extra.api ?? "openai-responses",
    provider: extra.provider ?? "openai",
    model: extra.model ?? "gpt-5",
    usage: createUsage(),
    stopReason: extra.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

export function createToolResult(toolCallId, toolName, text) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details: {},
    isError: false,
    timestamp: Date.now(),
  };
}

export function createTool(name, description = name) {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
  };
}

export function createMetadata(groupId, kind, isReadOnly, displayCategory = "file") {
  return { groupId, kind, isReadOnly, displayCategory };
}

export function createAgentToolCall(argumentsValue, id = "call-agent") {
  return {
    type: "toolCall",
    id,
    name: "Agent",
    arguments: argumentsValue,
  };
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

export function createFakeWorktreeIpc(options = {}) {
  const creates = [];
  const statuses = [];
  const applies = [];
  const cleanups = [];
  return {
    creates,
    statuses,
    applies,
    cleanups,
    async create(input) {
      creates.push(structuredClone(input));
      if (options.createError) throw options.createError;
      const worktreeRoot = `/tmp/liveagent-worktrees/${input.label}`;
      return {
        repoRoot: input.workdir,
        worktreeRoot,
        workdir: worktreeRoot,
        branchName: `liveagent/subagent/${input.label}`,
      };
    },
    async status(input) {
      statuses.push(structuredClone(input));
      if (options.statusError) throw options.statusError;
      return (
        options.status ?? {
          changed: true,
          status: " M src/app.ts",
          diffStat: " src/app.ts | 2 +",
          diff: "diff --git a/src/app.ts b/src/app.ts",
          diffTruncated: false,
          untrackedFiles: ["src/new.ts"],
        }
      );
    },
    async apply(input) {
      applies.push(structuredClone(input));
      if (options.applyError) throw options.applyError;
      return (
        options.applyResult ?? {
          applied: true,
          changed: true,
          status: " M src/app.ts",
          patchBytes: 123,
          applyMethod: "git_apply",
          copiedFiles: [],
          deletedFiles: [],
          conflictFiles: [],
        }
      );
    },
    async cleanup(input) {
      cleanups.push(structuredClone(input));
      if (options.cleanupError) throw options.cleanupError;
      return (
        options.cleanupResult ?? {
          worktreeRoot: input.worktreeRoot,
          branchName: input.branchName,
          removed: true,
          branchDeleted: true,
        }
      );
    },
  };
}

export function createDefaultCompactionMock(compactionCalls) {
  class FakeCompactionController {
    #presend = undefined;

    bindTurn(binding) {
      this.#presend = binding?.presend;
    }

    unbindTurn() {
      this.#presend = undefined;
    }

    get stats() {
      return { compactionsApplied: 0 };
    }

    beginRequest() {}

    shouldProtectMidStream() {
      return false;
    }

    async maybeCompactPreSend() {
      compactionCalls.push({ phase: "pre", incomingUserText: this.#presend?.pendingUserText });
      return false;
    }

    async compactDuringRun() {
      compactionCalls.push({ phase: "mid" });
      return { context: null, shouldDisableProtection: false };
    }

    async handleTurnAbort() {
      return false;
    }
  }

  return {
    CompactionController: FakeCompactionController,
    createCompactionControllerRegistry() {
      const controllers = new Map();
      return {
        get(conversationId) {
          const existing = controllers.get(conversationId);
          if (existing) return existing;
          const created = new FakeCompactionController();
          controllers.set(conversationId, created);
          return created;
        },
        dispose(conversationId) {
          controllers.delete(conversationId);
        },
      };
    },
  };
}

/**
 * Full Agent-tool harness: real subagent modules loaded through the TS
 * loader with the agent runner + compaction mocked, fake ipc ports injected.
 */
export async function createSubagentHarness(options = {}) {
  const runnerCalls = [];
  const compactionCalls = [];
  const executedBaseToolCalls = [];
  const executedChildToolCalls = [];
  let activeRuns = 0;
  let maxActiveRuns = 0;
  let runnerInvocations = 0;

  const defaultRunner = async (params) => {
    params.onTurnStart?.(1);
    for (const toolCall of options.runnerToolCalls ?? []) {
      params.onToolExecutionStart?.(toolCall, 1);
      const toolResult = await params.executeToolCall(toolCall);
      params.onToolResult?.(toolCall, toolResult, 1);
    }
    const assistant = createAssistant(`report:${runnerInvocations}`);
    return { assistant, messages: [assistant], emittedMessages: [assistant] };
  };

  const mocks = {
    [agentRunnerModulePath]: {
      async runAssistantWithTools(params) {
        runnerCalls.push(params);
        runnerInvocations += 1;
        activeRuns += 1;
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
        try {
          if (options.runnerDelayMs) await sleep(options.runnerDelayMs);
          if (options.runnerError) throw options.runnerError;
          const runner = options.runner ?? defaultRunner;
          return await runner(params, runnerInvocations);
        } finally {
          activeRuns -= 1;
        }
      },
    },
    [compactionControllerModulePath]:
      options.compactionMock ?? createDefaultCompactionMock(compactionCalls),
  };

  const loader = createTsModuleLoader({ mocks });
  const storeModule = loader.loadModule("src/lib/subagents/store.ts");
  const schedulerModule = loader.loadModule("src/lib/subagents/scheduler.ts");
  const agentToolModule = loader.loadModule("src/lib/subagents/agentTool.ts");

  const storeIpc = options.storeIpc ?? createFakeStoreIpc(options.storeIpcOptions);
  const worktreeIpc = options.worktreeIpc ?? createFakeWorktreeIpc(options.worktreeOptions);
  const conversationId = options.conversationId ?? "conversation-1";
  const store =
    options.store ??
    storeModule.createSubagentConversationStore({
      conversationId,
      ipc: storeIpc,
      ...(options.storeParams ?? {}),
    });
  const scheduler = schedulerModule.createSubagentScheduler(options.schedulerLimits);

  const baseTools = [
    createTool("Read"),
    createTool("Grep"),
    createTool("Write"),
    createTool("Bash"),
    createTool("MemoryManager"),
    createTool("McpManager"),
    createTool("mcp_docs_search"),
    createTool("Agent"),
  ];
  const metadataByName = new Map([
    ["Read", createMetadata("fs", "read", true)],
    ["Grep", createMetadata("fs", "grep", true, "search")],
    ["Write", createMetadata("fs", "write", false)],
    ["Bash", createMetadata("shell", "bash", false, "terminal")],
    ["MemoryManager", createMetadata("memory", "memory_manager", false, "system")],
    ["McpManager", createMetadata("mcp", "manage_mcp", false, "mcp")],
    ["mcp_docs_search", createMetadata("mcp", "mcp", false, "mcp")],
    ["Agent", createMetadata("subagent", "subagent_batch", false, "system")],
  ]);

  // Production builds the bundle only after the store hydrated.
  await store.ready();

  const bundle = agentToolModule.createSubagentTools({
    providerId: "codex",
    model: "gpt-5",
    runtime: {
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      reasoning: "medium",
    },
    workdir: options.workdir ?? "/tmp/liveagent-subagent-test",
    sessionId: options.sessionId === null ? undefined : (options.sessionId ?? "parent-session"),
    templates: options.templates ?? [
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Review code paths",
        prompt: "Focus on concrete defects.",
      },
    ],
    store,
    scheduler,
    baseTools,
    executeToolCall: async (toolCall) => {
      executedBaseToolCalls.push(toolCall);
      return createToolResult(toolCall.id, toolCall.name, `base:${toolCall.name}`);
    },
    metadataByName,
    createSubagentToolRegistry: options.omitChildRegistry
      ? undefined
      : async (workdir) => {
          const childTools = [
            createTool("Read"),
            createTool("Grep"),
            createTool("Write"),
            createTool("Bash"),
            createTool("SkillsManager"),
            createTool("MemoryManager"),
            createTool("McpManager"),
            createTool("mcp_docs_search"),
            createTool("Agent"),
          ];
          const childMetadataByName = new Map([
            ["Read", createMetadata("fs", "read", true)],
            ["Grep", createMetadata("fs", "grep", true, "search")],
            ["Write", createMetadata("fs", "write", false)],
            ["Bash", createMetadata("shell", "bash", false, "terminal")],
            ["SkillsManager", createMetadata("skill", "skills_manager", false, "system")],
            ["MemoryManager", createMetadata("memory", "memory_manager", true, "system")],
            ["McpManager", createMetadata("mcp", "manage_mcp", false, "mcp")],
            ["mcp_docs_search", createMetadata("mcp", "mcp", false, "mcp")],
            ["Agent", createMetadata("subagent", "subagent_batch", false, "system")],
          ]);
          return {
            tools: childTools,
            metadataByName: childMetadataByName,
            async executeToolCall(toolCall) {
              executedChildToolCalls.push({ workdir, toolCall });
              return createToolResult(toolCall.id, toolCall.name, `child:${toolCall.name}`);
            },
          };
        },
    worktreeIpc,
  });

  return {
    loader,
    storeModule,
    schedulerModule,
    agentToolModule,
    bundle,
    store,
    scheduler,
    storeIpc,
    worktreeIpc,
    runnerCalls,
    compactionCalls,
    executedBaseToolCalls,
    executedChildToolCalls,
    getMaxActiveRuns: () => maxActiveRuns,
  };
}

export function createRecordingContext(parentToolCall) {
  const emittedToolCalls = [];
  const emittedExecutionStarts = [];
  const emittedToolResults = [];
  const emittedStatuses = [];
  return {
    context: {
      parentToolCall,
      emitToolCall: (toolCall) => emittedToolCalls.push(toolCall),
      emitToolExecutionStart: (toolCall) => emittedExecutionStarts.push(toolCall),
      emitToolResult: (toolCall, toolResult) => emittedToolResults.push({ toolCall, toolResult }),
      emitToolStatus: (status) => emittedStatuses.push(status),
    },
    emittedToolCalls,
    emittedExecutionStarts,
    emittedToolResults,
    emittedStatuses,
  };
}
