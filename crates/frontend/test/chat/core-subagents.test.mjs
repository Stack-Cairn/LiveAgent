import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";

// Battle 5: subagent capability now lives in crates/core. This suite drives
// the core implementation (Agent tool registration, card fan-out, scheduler
// gating, SendMessage continuation) with the backend and the LLM stubbed.
const frontendRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const rootDir = path.resolve(frontendRootDir, "../core");
const backendClientModulePath = path.join(rootDir, "src/backendClient.ts");
const runModulePath = path.join(rootDir, "src/subagents/run.ts");

// ---- backend stub: in-memory subagent_* command surface --------------------

function createBackendStub() {
  const identities = new Map();
  const runs = new Map();
  const segmentsByRun = new Map();
  const messages = [];
  const calls = [];

  async function callBackend(command, args) {
    calls.push({ command, args });
    const input = args?.input ?? {};
    switch (command) {
      case "subagent_identity_upsert": {
        const stored = {
          ...input,
          createdAt: identities.get(input.agentId)?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        identities.set(input.agentId, stored);
        return stored;
      }
      case "subagent_identity_list":
        return [...identities.values()].filter(
          (identity) => identity.parentConversationId === input.parentConversationId,
        );
      case "subagent_run_save": {
        runs.set(input.run.id, { ...input.run, updatedAt: Date.now() });
        segmentsByRun.set(
          input.run.id,
          input.segments.map((segment) => ({
            ...segment,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })),
        );
        return null;
      }
      case "subagent_run_list":
        return [...runs.values()].filter(
          (run) => run.parentConversationId === input.parentConversationId,
        );
      case "subagent_run_load": {
        const run = runs.get(input.id);
        if (!run) return null;
        return { run, segments: segmentsByRun.get(input.id) ?? [] };
      }
      case "subagent_message_append": {
        const record = { id: messages.length + 1, seq: messages.length + 1, ...input, createdAt: Date.now() };
        messages.push(record);
        return record;
      }
      case "subagent_message_list":
        return messages.filter(
          (message) => message.parentConversationId === input.parentConversationId,
        );
      default:
        throw new Error(`Unexpected backend command in test: ${command}`);
    }
  }

  return { callBackend, identities, runs, messages, calls };
}

// ---- loader ----------------------------------------------------------------

function createLoader(backend, runMock) {
  const mocks = { [backendClientModulePath]: { callBackend: backend.callBackend } };
  if (runMock) mocks[runModulePath] = runMock;
  return createTsModuleLoader({ rootDir, mocks });
}

function createStore(loader, conversationId = "conv-1") {
  const { createSubagentConversationStore } = loader.loadModule("src/subagents/store.ts");
  return createSubagentConversationStore({ conversationId });
}

function createToolCall(id, name, args = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

function createAgentToolParams(loader, store, overrides = {}) {
  const { createSubagentScheduler } = loader.loadModule("src/subagents/scheduler.ts");
  return {
    providerId: "openai",
    model: "gpt-5",
    runtime: { baseUrl: "https://example.test", apiKey: "k", requestFormat: "responses" },
    workdir: "/tmp/workspace",
    templates: [],
    store,
    scheduler: overrides.scheduler ?? createSubagentScheduler(),
    baseTools: overrides.baseTools ?? [
      { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      { name: "Write", description: "write", parameters: { type: "object", properties: {} } },
    ],
    executeToolCall: async () => ({
      role: "toolResult",
      toolCallId: "x",
      toolName: "Read",
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
      timestamp: Date.now(),
    }),
    metadataByName:
      overrides.metadataByName ??
      new Map([
        ["Read", { groupId: "fs", kind: "read", isReadOnly: true }],
        ["Write", { groupId: "fs", kind: "write", isReadOnly: false }],
      ]),
    ...overrides,
  };
}

/** Stub executeSubagentRun so tests exercise the batch/card layer, not the LLM. */
function createRunMock(onRun) {
  return {
    buildSubagentRunId: (parentToolCallId, agentId, index) =>
      `${parentToolCallId}:agent:${index + 1}:${agentId}`,
    executeSubagentRun: onRun,
  };
}

function baseReport(spec, index, extra = {}) {
  return {
    id: spec.id,
    runId: `run-${spec.id}`,
    name: spec.id,
    prompt: spec.prompt,
    mode: spec.mode,
    status: "completed",
    summary: `summary for ${spec.id}`,
    durationMs: 1,
    rounds: 1,
    toolCalls: 0,
    ...extra,
  };
}

// ---- 1. Agent tool registration -------------------------------------------

test("core builtin registry registers Agent and SendMessage when subagents are configured", () => {
  const backend = createBackendStub();
  const loader = createLoader(backend);
  const store = createStore(loader);
  const { createSubagentTools } = loader.loadModule("src/subagents/agentTool.ts");
  const { createSendMessageTools } = loader.loadModule("src/subagents/sendMessageTool.ts");

  const agentBundle = createSubagentTools(createAgentToolParams(loader, store));
  assert.equal(agentBundle.groupId, "subagent");
  assert.deepEqual(
    agentBundle.tools.map((tool) => tool.name),
    ["Agent"],
  );
  assert.equal(agentBundle.metadataByName.get("Agent").kind, "subagent_batch");
  assert.equal(agentBundle.metadataByName.get("Agent").isReadOnly, false);

  const sendBundle = createSendMessageTools({ store, senderId: "parent" });
  assert.deepEqual(
    sendBundle.tools.map((tool) => tool.name),
    ["SendMessage"],
  );
  assert.equal(sendBundle.metadataByName.get("SendMessage").kind, "subagent_message");

  // The Agent schema is what the model sees; these fields drive delegation.
  const properties = agentBundle.tools[0].parameters.properties;
  assert.ok(properties.agents, "Agent exposes an agents array");
  assert.ok(properties.concurrency, "Agent exposes concurrency");
});

test("subagents are omitted from the tool list when not configured", () => {
  const backend = createBackendStub();
  const loader = createLoader(backend);
  const { selectReadOnlyTools } = loader.loadModule("src/subagents/policy.ts");

  // Readonly children never receive Agent (no recursive delegation).
  const tools = selectReadOnlyTools({
    tools: [
      { name: "Agent", description: "", parameters: {} },
      { name: "Read", description: "", parameters: {} },
      { name: "Write", description: "", parameters: {} },
      { name: "SendMessage", description: "", parameters: {} },
    ],
    metadataByName: new Map([
      ["Agent", { groupId: "subagent", kind: "subagent_batch", isReadOnly: false }],
      ["Read", { groupId: "fs", kind: "read", isReadOnly: true }],
      ["Write", { groupId: "fs", kind: "write", isReadOnly: false }],
      ["SendMessage", { groupId: "subagent", kind: "subagent_message", isReadOnly: true }],
    ]),
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["Read", "SendMessage"],
  );
});

// ---- 2. single subagent run emits a card -----------------------------------

test("one Agent call fans out a synthetic card tool_call/tool_result pair", async () => {
  const backend = createBackendStub();
  const loader = createLoader(
    backend,
    createRunMock(async (_env, request) => baseReport(request.spec, request.index)),
  );
  const store = createStore(loader);
  const { createSubagentTools } = loader.loadModule("src/subagents/agentTool.ts");
  const bundle = createSubagentTools(createAgentToolParams(loader, store));

  const emittedCalls = [];
  const emittedStarts = [];
  const emittedResults = [];
  const parentToolCall = createToolCall("call-1", "Agent", {
    agents: [{ id: "researcher", prompt: "investigate the parser" }],
  });

  const result = await bundle.executeToolCall(parentToolCall, undefined, {
    parentToolCall,
    emitToolCall: (toolCall) => emittedCalls.push(toolCall),
    emitToolExecutionStart: (toolCall) => emittedStarts.push(toolCall),
    emitToolResult: (toolCall, toolResult) => emittedResults.push({ toolCall, toolResult }),
  });

  // The card travels on the existing tool_call/tool_result wire events.
  assert.equal(emittedCalls.length, 1);
  assert.equal(emittedStarts.length, 1);
  assert.equal(emittedResults.length, 1);

  const card = emittedCalls[0];
  assert.equal(card.name, "Agent");
  assert.equal(card.id, "call-1:agent:1");
  assert.equal(card.arguments.subagent_card, true);
  assert.equal(card.arguments.parent_tool_call_id, "call-1");
  assert.equal(card.arguments.index, 1);
  assert.equal(card.arguments.total, 1);
  assert.equal(card.arguments.id, "researcher");

  const cardDetails = emittedResults[0].toolResult.details;
  assert.equal(cardDetails.kind, "subagent_card");
  assert.equal(cardDetails.agent.id, "researcher");
  assert.equal(cardDetails.agent.status, "completed");

  // The aggregate result is what the model reads back.
  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "subagent_batch");
  assert.equal(result.details.status, "ok");
  assert.equal(result.details.agentCount, 1);
  assert.match(result.content[0].text, /summary for researcher/);
});

test("the card is recognized by the shared card predicate the UI renders from", async () => {
  const backend = createBackendStub();
  const loader = createLoader(
    backend,
    createRunMock(async (_env, request) => baseReport(request.spec, request.index)),
  );
  const store = createStore(loader);
  const { createSubagentTools } = loader.loadModule("src/subagents/agentTool.ts");
  const { isSubagentCardToolCall } = loader.loadModule("src/subagents/card.ts");
  const bundle = createSubagentTools(createAgentToolParams(loader, store));

  const emitted = [];
  const parentToolCall = createToolCall("call-2", "Agent", {
    agents: [{ id: "reviewer", prompt: "review the diff" }],
  });
  await bundle.executeToolCall(parentToolCall, undefined, {
    parentToolCall,
    emitToolCall: (toolCall) => emitted.push(toolCall),
  });

  assert.equal(isSubagentCardToolCall(emitted[0]), true);
  // The parent call must not be mistaken for a card (the turn layer hides it).
  assert.equal(isSubagentCardToolCall(parentToolCall), false);
});

test("an invalid Agent call rejects the whole batch and starts no agents", async () => {
  const backend = createBackendStub();
  let started = 0;
  const loader = createLoader(
    backend,
    createRunMock(async (_env, request) => {
      started += 1;
      return baseReport(request.spec, request.index);
    }),
  );
  const store = createStore(loader);
  const { createSubagentTools } = loader.loadModule("src/subagents/agentTool.ts");
  const bundle = createSubagentTools(createAgentToolParams(loader, store));

  const parentToolCall = createToolCall("call-3", "Agent", {
    agents: [
      { id: "dup", prompt: "first" },
      { id: "dup", prompt: "second" },
    ],
  });
  const result = await bundle.executeToolCall(parentToolCall, undefined, { parentToolCall });

  assert.equal(started, 0, "no subagent runs on a rejected batch");
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "rejected");
  assert.ok(result.details.issues.some((item) => item.code === "duplicate_agent_id"));
});

// ---- 3. parallel subagents go through the scheduler ------------------------

test("parallel subagents are gated by the core scheduler's concurrency limit", async () => {
  const backend = createBackendStub();
  let active = 0;
  let peak = 0;
  const release = [];

  const loader = createLoader(
    backend,
    createRunMock(async (_env, request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => release.push(resolve));
      active -= 1;
      return baseReport(request.spec, request.index);
    }),
  );
  const store = createStore(loader);
  const { createSubagentScheduler } = loader.loadModule("src/subagents/scheduler.ts");
  const { createSubagentTools } = loader.loadModule("src/subagents/agentTool.ts");

  const scheduler = createSubagentScheduler({ maxParallelSubagents: 2 });
  const bundle = createSubagentTools(createAgentToolParams(loader, store, { scheduler }));

  const parentToolCall = createToolCall("call-4", "Agent", {
    agents: [
      { id: "a1", prompt: "job 1" },
      { id: "a2", prompt: "job 2" },
      { id: "a3", prompt: "job 3" },
      { id: "a4", prompt: "job 4" },
    ],
  });

  let settled = false;
  const pending = bundle
    .executeToolCall(parentToolCall, undefined, { parentToolCall })
    .finally(() => {
      settled = true;
    });

  // Drain the semaphore in waves; the gate must never admit more than 2.
  // Poll until the batch settles — the tool call does async validation before
  // the first run is admitted, so an empty release queue is not "done".
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const resolve of release.splice(0)) resolve();
  }

  const result = await pending;
  assert.equal(peak, 2, `scheduler admitted ${peak} concurrent subagents, expected 2`);
  assert.equal(result.details.agentCount, 4);
  assert.equal(result.details.status, "ok");
});

test("the scheduler reports the Agent tool's own parallel-call limit", () => {
  const backend = createBackendStub();
  const loader = createLoader(backend);
  const { createSubagentScheduler } = loader.loadModule("src/subagents/scheduler.ts");

  const scheduler = createSubagentScheduler({
    maxParallelAgentToolCalls: 3,
    maxParallelBash: 5,
  });
  assert.equal(scheduler.getParallelToolLimit("Agent"), 3);
  assert.equal(scheduler.getParallelToolLimit("Bash"), 5);
  assert.equal(scheduler.getParallelToolLimit("Read"), 2);
});

// ---- 4. SendMessage continuation -------------------------------------------

test("SendMessage persists a bus message and returns subagent_message details", async () => {
  const backend = createBackendStub();
  const loader = createLoader(backend);
  const store = createStore(loader);
  const { createSendMessageTools } = loader.loadModule("src/subagents/sendMessageTool.ts");

  // Register an agent so the recipient roster is non-empty.
  await store.upsertIdentity({
    parentConversationId: "conv-1",
    agentId: "researcher",
    name: "Researcher",
    role: "research",
    identityPrompt: "",
    lastMode: "readonly",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const bundle = createSendMessageTools({
    store,
    senderId: "reviewer",
    senderName: "Reviewer",
    currentRunId: "run-7",
  });

  const toolCall = createToolCall("msg-1", "SendMessage", {
    to: "researcher",
    message: "Please double-check the parser edge cases.",
    channel: "question",
  });
  const result = await bundle.executeToolCall(toolCall);

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "subagent_message");
  assert.equal(result.details.recipientId, "researcher");
  assert.equal(result.details.senderId, "reviewer");
  assert.equal(result.details.channel, "question");
  assert.equal(result.details.sourceRunId, "run-7");
  assert.equal(backend.messages.length, 1);
  assert.equal(backend.messages[0].bodyMarkdown, "Please double-check the parser edge cases.");
});

test("SendMessage rejects an unknown recipient instead of writing an unreadable message", async () => {
  const backend = createBackendStub();
  const loader = createLoader(backend);
  const store = createStore(loader);
  const { createSendMessageTools } = loader.loadModule("src/subagents/sendMessageTool.ts");

  const bundle = createSendMessageTools({ store, senderId: "reviewer" });
  const result = await bundle.executeToolCall(
    createToolCall("msg-2", "SendMessage", { to: "ghost", message: "hello" }),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown recipient "ghost"/);
  assert.equal(backend.messages.length, 0, "no message is persisted for a bad recipient");
});

test("a resumed agent receives the bus snapshot in its continuation prompt", async () => {
  const backend = createBackendStub();
  const loader = createLoader(backend);
  const store = createStore(loader);
  const { renderMessageBusSnapshot } = loader.loadModule("src/subagents/bus.ts");
  const { buildSubagentContinuationMessage } = loader.loadModule("src/subagents/prompts.ts");
  const { createSendMessageTools } = loader.loadModule("src/subagents/sendMessageTool.ts");

  await store.upsertIdentity({
    parentConversationId: "conv-1",
    agentId: "researcher",
    name: "Researcher",
    role: "research",
    identityPrompt: "",
    lastMode: "readonly",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const parentSend = createSendMessageTools({ store, senderId: "parent", senderName: "Parent" });
  await parentSend.executeToolCall(
    createToolCall("msg-3", "SendMessage", {
      to: "researcher",
      message: "Focus on the tokenizer first.",
    }),
  );

  const snapshot = renderMessageBusSnapshot({
    messages: await store.listBusMessages("researcher"),
    currentAgentId: "researcher",
    currentAgentName: "Researcher",
  });
  assert.match(snapshot, /Focus on the tokenizer first\./);
  assert.match(snapshot, /Direct Inbox for Researcher/);

  const continuation = buildSubagentContinuationMessage({
    spec: {
      id: "researcher",
      prompt: "Continue the review.",
      mode: "readonly",
      applyPolicy: "none",
      allowedOutputPaths: [],
      resume: true,
      retainWorktree: false,
    },
    identity: store.getIdentity("researcher"),
    resumedFrom: { id: "run-1", mode: "readonly" },
    messageBusSnapshot: snapshot,
    messageBusEnabled: true,
  });

  const text = continuation.content[0].text;
  assert.match(text, /Continue your existing delegated agent session\./);
  assert.match(text, /Stable id: researcher/);
  assert.match(text, /Current continuation task: Continue the review\./);
  assert.match(text, /Focus on the tokenizer first\./);
});

test("a resumed agent id reuses its stored identity and last mode", async () => {
  const backend = createBackendStub();
  const loader = createLoader(backend);
  const store = createStore(loader);
  const { parseSubagentBatch } = loader.loadModule("src/subagents/validate.ts");

  const identity = await store.upsertIdentity({
    parentConversationId: "conv-1",
    agentId: "builder",
    name: "Builder",
    role: "implementation",
    identityPrompt: "",
    lastMode: "worktree",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const parsed = parseSubagentBatch(
    { agents: [{ id: "builder", prompt: "continue the refactor" }] },
    { identities: new Map([["builder", identity]]), templates: [] },
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.batch.agents[0].spec.mode, "worktree", "resumed agent keeps its last mode");
  assert.equal(parsed.batch.agents[0].spec.resume, true);
  assert.equal(parsed.batch.agents[0].existingIdentity.name, "Builder");

  // Re-sending a creation field with a conflicting value is an error.
  const conflict = parseSubagentBatch(
    { agents: [{ id: "builder", prompt: "x", name: "Someone Else" }] },
    { identities: new Map([["builder", identity]]), templates: [] },
  );
  assert.equal(conflict.ok, false);
  assert.ok(conflict.issues.some((item) => item.code === "identity_conflict"));
});
