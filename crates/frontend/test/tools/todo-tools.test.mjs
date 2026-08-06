import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);
// core 走 HTTP callBackend，前端副本走 tauri invoke —— 迁移后 mock 换成前者。
const backendClientPath = coreSrc("backendClient.ts");
import { createFakeStoreIpc } from "../subagents/harness.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const agentRunnerModulePath = coreSrc("chat/runner/agentRunner.ts");

function createAssistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createAgentToolCall(argumentsValue, id = "call-agent") {
  return { type: "toolCall", id, name: "Agent", arguments: argumentsValue };
}

function createTodoToolCall(argumentsValue, id = "call-todo") {
  return { type: "toolCall", id, name: "TodoWrite", arguments: argumentsValue };
}

function loadTodoTools() {
  const loader = createTsModuleLoader();
  return loader.loadModule(coreSrc("tools/todoTools.ts"));
}

test("TodoWrite schema accepts a well-formed todos array", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule(coreSrc("tools/todoTools.ts"));
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");
  assert.ok(tool);

  const args = validateToolArguments(
    tool,
    createTodoToolCall({
      todos: [{ content: "Run tests", status: "pending", activeForm: "Running tests" }],
    }),
  );
  assert.deepEqual(args, {
    todos: [{ content: "Run tests", status: "pending", activeForm: "Running tests" }],
  });
});

test("TodoWrite schema rejects a todo item missing content", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule(coreSrc("tools/todoTools.ts"));
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ status: "pending", activeForm: "Running tests" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects a todo item missing status", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule(coreSrc("tools/todoTools.ts"));
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ content: "Run tests", activeForm: "Running tests" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects a todo item missing activeForm", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule(coreSrc("tools/todoTools.ts"));
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ content: "Run tests", status: "pending" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects an invalid status literal", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule(coreSrc("tools/todoTools.ts"));
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ content: "Run tests", status: "done", activeForm: "Running tests" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects a non-array todos value", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule(coreSrc("tools/todoTools.ts"));
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(tool, createTodoToolCall({ todos: "not-an-array" })),
  );
});

test("executor stores a valid full todo list and reports isError: false", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });
  const todos = [
    { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
    { content: "Ship release", status: "pending", activeForm: "Shipping release" },
  ];

  const result = await bundle.executeToolCall(createTodoToolCall({ todos }));

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "todo_write");
  assert.deepEqual(result.details.todos, todos);
  assert.deepEqual(state.getTodos(), todos);
});

test("executor replaces rather than merges on a second full-replacement call", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });

  await bundle.executeToolCall(
    createTodoToolCall({
      todos: [
        { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
        { content: "Ship release", status: "pending", activeForm: "Shipping release" },
      ],
    }),
  );

  const secondTodos = [
    { content: "Ship release", status: "in_progress", activeForm: "Shipping release" },
  ];
  const result = await bundle.executeToolCall(createTodoToolCall({ todos: secondTodos }));

  assert.equal(result.isError, false);
  assert.deepEqual(state.getTodos(), secondTodos);
});

test("executor rejects a call with more than one in_progress item", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });

  const result = await bundle.executeToolCall(
    createTodoToolCall({
      todos: [
        { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
        { content: "Ship release", status: "in_progress", activeForm: "Shipping release" },
      ],
    }),
  );

  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /in_progress/);
  assert.match(text, /one at a time|only one/i);
  // A rejected call must not clobber whatever was previously stored.
  assert.deepEqual(state.getTodos(), []);
});

test("executor rejects a malformed todos structure", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });

  const result = await bundle.executeToolCall(
    createTodoToolCall({
      todos: [{ content: "Run tests", status: "pending" }],
    }),
  );

  assert.equal(result.isError, true);
  assert.deepEqual(state.getTodos(), []);
});

test("getOrCreateTodoToolState returns the same state for a conversation and a fresh one after dispose", () => {
  const { getOrCreateTodoToolState, disposeTodoToolState } = loadTodoTools();

  const first = getOrCreateTodoToolState("conversation-todo-1");
  first.setTodos([{ content: "Run tests", status: "pending", activeForm: "Running tests" }]);

  const second = getOrCreateTodoToolState("conversation-todo-1");
  assert.equal(second, first);
  assert.deepEqual(second.getTodos(), [
    { content: "Run tests", status: "pending", activeForm: "Running tests" },
  ]);

  disposeTodoToolState("conversation-todo-1");
  const third = getOrCreateTodoToolState("conversation-todo-1");
  assert.notEqual(third, first);
  assert.deepEqual(third.getTodos(), []);
});

const DOCS_SERVER = {
  id: "docs",
  enabled: true,
  transport: "stdio",
  command: "mock-mcp-server",
  args: [],
  env: {},
};

function createRegistryHarness() {
  const runnerCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerModulePath]: {
        async runAssistantWithTools(params) {
          runnerCalls.push(params);
          params.onTurnStart?.(1);
          const assistant = createAssistant("subagent done");
          return { assistant, messages: [assistant], emittedMessages: [assistant] };
        },
      },
      "@tauri-apps/api/path": {
        async homeDir() {
          return "/Users/test";
        },
      },
      [backendClientPath]: {
        async callBackend(command, args) {
          if (command === "mcp_list_tools") {
            return [];
          }
          if (command === "subagent_worktree_create") {
            return {
              repoRoot: "/repo",
              worktreeRoot: "/tmp/liveagent-subagents/agent-a",
              workdir: "/tmp/liveagent-subagents/agent-a",
              branchName: "liveagent/subagent/agent-a",
            };
          }
          if (command === "subagent_worktree_status") {
            return {
              changed: false,
              status: "",
              diffStat: "",
              diff: "",
              diffTruncated: false,
              untrackedFiles: [],
            };
          }
          if (command === "subagent_worktree_cleanup") {
            return {
              worktreeRoot: args.input.worktreeRoot,
              branchName: args.input.branchName,
              removed: true,
              branchDeleted: true,
            };
          }
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });
  return { loader, runnerCalls };
}

async function buildRegistry(
  harness,
  { withSubagentRuntime, runtimeScope = "chat", withTodoState = true, storeIpc } = {},
) {
  const { loader } = harness;
  const { buildBuiltinToolRegistry } = loader.loadModule(coreSrc("tools/builtinRegistry.ts"));
  const { createFileToolState } = loader.loadModule(coreSrc("tools/fileToolState.ts"));
  const { createTodoToolState } = loader.loadModule(coreSrc("tools/todoTools.ts"));
  const mcpSettingsHolder = { value: { selected: [], servers: [DOCS_SERVER] } };
  const baseParams = {
    workdir: "/tmp/liveagent-todo-registry-test",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope,
    getMcpSettings: () => mcpSettingsHolder.value,
    ...(withTodoState ? { todoState: createTodoToolState() } : {}),
  };
  if (!withSubagentRuntime) {
    return { registry: await buildBuiltinToolRegistry(baseParams), mcpSettingsHolder };
  }

  const storeModule = loader.loadModule(coreSrc("subagents/store.ts"));
  const schedulerModule = loader.loadModule(coreSrc("subagents/scheduler.ts"));
  const ipc = storeIpc ?? createFakeStoreIpc();
  const store = storeModule.createSubagentConversationStore({
    conversationId: "conversation-1",
    ipc,
  });
  const registry = await buildBuiltinToolRegistry({
    ...baseParams,
    // crates/core renamed this from `subagentRuntime` and reads providerId from
    // the top-level params instead of repeating it here.
    subagents: {
      model: "gpt-5",
      runtime: { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      sessionId: "parent-session",
      templates: [],
      store,
      scheduler: schedulerModule.createSubagentScheduler(),
    },
  });
  return { registry, store, ipc, mcpSettingsHolder };
}

test("chat-scope registry with todoState includes TodoWrite, with or without a subagent runtime", async () => {
  const harnessNoSubagent = createRegistryHarness();
  const { registry: registryNoSubagent } = await buildRegistry(harnessNoSubagent, {
    withSubagentRuntime: false,
  });
  assert.ok(registryNoSubagent.tools.map((tool) => tool.name).includes("TodoWrite"));

  const harnessWithSubagent = createRegistryHarness();
  const { registry: registryWithSubagent } = await buildRegistry(harnessWithSubagent, {
    withSubagentRuntime: true,
  });
  assert.ok(registryWithSubagent.tools.map((tool) => tool.name).includes("TodoWrite"));
});

test("chat-scope registry without a todoState does not include TodoWrite", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, {
    withSubagentRuntime: false,
    withTodoState: false,
  });
  assert.ok(!registry.tools.map((tool) => tool.name).includes("TodoWrite"));
});

test("cron_auto_prompt scope registry never includes TodoWrite, even with a todoState", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, {
    withSubagentRuntime: false,
    runtimeScope: "cron_auto_prompt",
    withTodoState: true,
  });
  assert.ok(!registry.tools.map((tool) => tool.name).includes("TodoWrite"));
});

test("worktree subagent children never receive TodoWrite", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-a", prompt: "Plan the work.", mode: "worktree" }],
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(harness.runnerCalls.length, 1);
  const names = harness.runnerCalls[0].tools.map((tool) => tool.name);
  assert.ok(!names.includes("TodoWrite"));
});

test("readonly subagent children never receive TodoWrite", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-b", prompt: "Investigate the code.", mode: "readonly" }],
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(harness.runnerCalls.length, 1);
  const names = harness.runnerCalls[0].tools.map((tool) => tool.name);
  assert.ok(!names.includes("TodoWrite"));
});
