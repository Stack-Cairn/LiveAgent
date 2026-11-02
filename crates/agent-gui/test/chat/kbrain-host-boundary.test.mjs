import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = (name) => path.join(root, "src", name);
const capabilities = createTsModuleLoader()
  .loadModule("src/lib/host.ts")
  .liveAgentRuntimeCapabilities();

test("K-brain capabilities disable the replaced desktop runtime", () => {
  assert.deepEqual(capabilities, {
    frontendContext: false,
    gatewayMirror: false,
    checkpoints: false,
    trajectory: false,
  });
});

// LA-4 (option A): the desktop mirrors its own K-brain runs to a paired Gateway so a WebUI
// can watch them and answer their approvals; the replaced runtime stays off.
test("the desktop host can mirror K-brain runs to the Gateway", () => {
  const previous = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: {} };
  try {
    assert.deepEqual(createTsModuleLoader().loadModule("src/lib/host.ts").liveAgentRuntimeCapabilities(), {
      frontendContext: false,
      gatewayMirror: true,
      checkpoints: false,
      trajectory: false,
    });
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

for (const executionMode of ["agent", "chat"]) {
  // local: no Gateway paired; remote: a WebUI request; paired: a desktop run with a
  // paired Gateway, mirrored so a WebUI can watch it.
  for (const mode of ["local", "remote", "paired"]) {
    const remote = mode === "remote";
    const mirrors = mode !== "local";
    for (const workdir of ["/workspace", "C:\\Users\\Tester\\workspace"]) {
      test(`shipped useSendChatTurn ${executionMode} ${mode} ${workdir} runs only K-brain`, async () => {
        const ipc = [];
        const forbidden = (name) => () => {
          ipc.push(name);
          throw new Error(`Forbidden: ${name}`);
        };
        let sent = false;
        const mirrored = [];
        const nativeMirror = [];
        const loader = createTsModuleLoader({
          mocks: {
            react: { useCallback: (callback) => callback },
            [source("lib/host.ts")]: {
              liveAgentRuntimeCapabilities: () => ({ ...capabilities, gatewayMirror: true }),
              isKBrainBackendEnabled: () => true,
              isKBrainBrowserHost: () => false,
              isTauriHost: () => true,
            },
            "@tauri-apps/api/core": {
              // A mirrored desktop run tells the Gateway it started (and if it was cancelled).
              invoke: async (command) => {
                if (mode === "paired" && command.startsWith("gateway_chat_mark_local_")) {
                  nativeMirror.push(command);
                  return null;
                }
                return forbidden(`native invoke ${command}`)();
              },
            },
            [source("lib/trajectory/recorderRegistry.ts")]: {
              acquireTrajectoryRecorder: forbidden("trajectory recorder"),
              resolveTrajectoryTurnNumber: forbidden("trajectory number"),
            },
            [source("pages/chat/runtime/conversationTitleJob.ts")]: {
              startConversationTitleJob: () => null,
            },
            [source("lib/providers/llm.ts")]: {
              createProviderRuntimeConfig: () => ({
                backend: "kbrain",
                baseUrl: "",
                modelConfig: {},
              }),
              createModelFromConfig: () => ({
                id: "model",
                provider: "openai",
                api: "openai-completions",
              }),
            },
          },
        });
        const { getDefaultSettings } = loader.loadModule("src/lib/settings/index.ts");
        const settings = getDefaultSettings();
        settings.system.executionMode = executionMode;
        settings.system.workdir = workdir;
        settings.remote = {
          ...settings.remote,
          enabled: mode === "paired",
          gatewayUrl: "https://old-gateway.invalid",
          token: "old-token",
        };
        settings.skills = {
          ...settings.skills,
          enabled: true,
          selected: ["missing-local-skill"],
        };
        settings.selectedModel = { customProviderId: "backend", model: "model" };
        settings.customProviders = [{ id: "backend", type: "codex", activeModels: ["model"] }];
        const { createConversationStateFromContext } = loader.loadModule(
          "src/lib/chat/conversation/conversationState.ts",
        );
        const entry = {
          state: createConversationStateFromContext({
            systemPrompt: "LOCAL PROMPT MUST NOT LEAK",
            messages: [],
          }),
          sessionId: "s",
          createdAt: 1,
          compactionStatus: { phase: "idle" },
          isSending: false,
        };
        const cache = new Map([["conversation", entry]]);
        const transcriptStore = {
          getSnapshot: () => ({ liveRounds: [], draftAssistantText: "" }),
        };
        const noop = () => {};
        const { useSendChatTurn } = loader.loadModule("src/pages/chat/runtime/useSendChatTurn.ts");
        const { send } = useSendChatTurn({
          settings,
          workspaceProjects: [{ id: "p", path: workdir }],
          setSettings: forbidden("settings mutation"),
          getMcpSettings: forbidden("MCP settings"),
          getToolPolicies: forbidden("tool policies"),
          t: (key) => key,
          sidebarStore: {
            peek: () => undefined,
            upsertLocal: noop,
            removeLocal: noop,
          },
          titleJobRef: { current: null },
          chatRuntimeHost: {
            runTurn: async ({ params }) => {
              sent = true;
              assert.equal(params.runtime.backend, "kbrain");
              assert.equal(params.conversationCwd, workdir);
              if (remote) assert.equal(params.clientRequestId, "browser-request");
              const context = params.buildPreparedContext(params.getNextConversationState());
              assert.equal(context.systemPrompt, undefined);
              assert.equal(context.tools, undefined);
              assert.equal(
                typeof context.messages.at(-1).content === "string"
                  ? context.messages.at(-1).content
                  : context.messages.at(-1).content[0].text,
                "hello",
              );
              assert.equal(params.trajectory, undefined);
              if (executionMode === "agent") assert.equal(params.effectiveSkillsEnabled, false);
            },
          },
          subagentStoresRef: { current: { get: () => ({}) } },
          scrollFollowRef: { current: null },
          composerRef: { current: null },
          composerDraftCacheRef: { current: new Map() },
          clearCachedComposerDraft: noop,
          resetVisibleTransientState: noop,
          isImportingPastedTextRef: { current: false },
          setIsImportingPastedText: noop,
          setErrorMessage: forbidden("error message"),
          hydration: { isHydrating: () => false, isFailed: () => false },
          currentConversationIdRef: { current: "conversation" },
          conversationRuntimeCacheRef: { current: cache },
          updateConversationRuntimeEntry: (id, update) => cache.set(id, update(cache.get(id))),
          setConversationAbortController: noop,
          getConversationStopRequestVersion: () => 0,
          isConversationStopRequested: () => false,
          consumeConversationStop: noop,
          setConversationStopHandler: noop,
          clearConversationStopHandler: noop,
          setConversationSendingState: noop,
          pendingUploadedFiles: [],
          getPendingUploadsForConversation: () => [],
          setPendingUploadsForConversation: noop,
          getConversationLiveTranscriptStore: () => transcriptStore,
          getCompactionController: forbidden("frontend compaction controller"),
          clearAbortSnapshot: noop,
          resetLiveTranscript: noop,
          settleLiveTranscript: noop,
          updateToolStatus: noop,
          queueGatewayBridgeEventForRequest: mirrors
            ? (_id, event) => mirrored.push(event)
            : forbidden("gateway events"),
          flushGatewayBridgeEventsForRequest: mirrors ? noop : forbidden("gateway flush"),
          registerGatewayRunMirror: mirrors ? noop : forbidden("gateway register"),
          finishGatewayRunMirror: mirrors ? noop : forbidden("gateway finish"),
          gatewayBridgeHistorySummaryRef: { current: new Map() },
          availableSkills: [],
          skillsRootDir: "/desktop/skills",
          refreshSkills: forbidden("skills discovery"),
          persistConversation: async () => ({}),
          pruneIdleConversationCaches: noop,
          requestQueuedChatTurnProcessing: noop,
        });
        let markedStarted = false;
        assert.equal(
          await send({
            textOverride: "hello",
            ...(remote
              ? {
                  conversationIdOverride: "conversation",
                  workdirOverride: workdir,
                  gatewayBridgeRequestOverride: {
                    requestId: "remote-request",
                    conversationId: "conversation",
                    clientRequestId: "browser-request",
                    workerId: "worker",
                    workdirOverride: workdir,
                  },
                  beforeRuntimeStart: async () => {
                    markedStarted = true;
                  },
                }
              : {}),
          }),
          true,
        );
        assert.equal(markedStarted, remote);
        if (mirrors) assert(mirrored.some((event) => event.type === "user_message"));
        if (mode === "paired") assert.deepEqual(nativeMirror, ["gateway_chat_mark_local_started"]);
        assert.equal(sent, true);
        assert.deepEqual(ipc, []);
      });
    }
  }
}

test("native K-brain host routes backend-owned memory over HTTP and rejects desktop runtime commands", async (t) => {
  const native = [];
  const memoryRequests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    memoryRequests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : undefined,
    });
    if (request.url !== "/v1/memory/manage") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected endpoint" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ overview: "fixture-memory-overview" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const host = createTsModuleLoader().loadModule("src/lib/host.ts");
  const loader = createTsModuleLoader({
    mocks: {
      [source("lib/host.ts")]: {
        ...host,
        isKBrainBackendEnabled: () => true,
        isKBrainBrowserHost: () => false,
      },
      "@tauri-apps/api/core": {
        invoke: async (command) => {
          native.push(command);
          return "native-result";
        },
      },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({
    baseUrl,
    token: "fixture-token",
    protocolVersion: "kbrain.agent.v1",
  });
  t.after(() => runtime.clearKBrainRuntimeConnection());

  const { invoke } = loader.loadModule("src/shims/tauriCore.ts");
  const memoryOverview = await invoke("memory_index_overview", { args: { cwd: "/workspace" } });
  assert.deepEqual(memoryOverview, { overview: "fixture-memory-overview" });
  assert.deepEqual(memoryRequests, [
    {
      method: "POST",
      path: "/v1/memory/manage",
      authorization: "Bearer fixture-token",
      body: { command: "memory_index_overview", args: { cwd: "/workspace" } },
    },
  ]);
  assert.deepEqual(native, [], "backend-owned memory must not invoke Tauri");

  for (const command of [
    "system_ensure_builtin_skills",
    "system_manage_skill",
    "checkpoint_begin_turn",
    "checkpoint_rewind_code",
    "hook_run_script",
    "chat_history_save",
    "subagent_upsert",
    "trajectory_append",
  ]) {
    await assert.rejects(invoke(command), /unavailable in K-brain mode/);
  }
  assert.deepEqual(native, [], "forbidden backend-owned commands must not invoke Tauri");
  assert.equal(await invoke("gateway_chat_mark_local_started"), "native-result");
  assert.equal(await invoke("system_pick_folder"), "native-result");
  assert.equal(await invoke("window_show"), "native-result");
  assert.deepEqual(native, [
    "gateway_chat_mark_local_started",
    "system_pick_folder",
    "window_show",
  ]);
});

test("checkpoint provider exposes unsupported reason and disables backend reads", () => {
  const loader = createTsModuleLoader({
    mocks: {
      react: { useCallback: (callback) => callback },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "zh-CN" }) },
      [source("lib/host.ts")]: {
        liveAgentRuntimeCapabilities: () => capabilities,
      },
      "@liveagent/ui/lib/chat/checkpointRewind": {
        CheckpointRewindProvider: "checkpoint-provider",
      },
    },
  });
  const { DesktopCheckpointRewindProvider } = loader.loadModule(
    "src/pages/chat/components/DesktopCheckpointRewindProvider.tsx",
  );
  const element = DesktopCheckpointRewindProvider({
    conversationId: "c",
    children: "transcript",
    disabled: false,
  });
  assert.equal(element.props.disabled, true);
  assert.match(element.props.disabledReason, /K-brain.*不支持.*检查点/);
});

test("K-brain hooks never execute the desktop runner", async () => {
  const warnings = [];
  const loader = createTsModuleLoader({
    mocks: {
      [source("lib/host.ts")]: { isKBrainBackendEnabled: () => true },
      "@liveagent/app/shims/tauriCore": {
        invoke: () => assert.fail("desktop hook executed"),
      },
    },
  });
  const { createHookRunScope } = loader.loadModule("src/lib/automation/hookRunner.ts");
  const scope = createHookRunScope({
    conversationId: "c",
    hooks: [
      {
        name: "local hook",
        enabled: true,
        event: "agent_start",
        type: "command",
        script: "false",
      },
    ],
    onWarning: (warning) => warnings.push(warning),
  });
  scope.dispatch("agent_start");
  scope.cancel();
  await Promise.resolve();
  assert.equal(warnings.length, 0);
});

test("checkpoint action carries an explicit disabled reason to the rendered user action", () => {
  const contexts = [];
  const effects = [];
  const react = {
    createContext: (value) => {
      const context = { current: value, Provider: "provider" };
      contexts.push(context);
      return context;
    },
    useContext: (context) => context.current,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useEffect: (fn) => effects.push(fn),
  };
  const loader = createTsModuleLoader({
    mocks: {
      react,
      "@liveagent/ui/components/ui/confirm-dialog": {
        useConfirmDialog: () => ({ confirm: assert.fail, dialog: null }),
      },
      "@liveagent/ui/i18n/index": {
        useLocale: () => ({ locale: "en", t: (key) => key }),
      },
    },
  });
  const { CheckpointRewindProvider, useCheckpointRewindAction } = loader.loadModule(
    "@liveagent/ui/lib/chat/checkpointRewind",
  );
  const reason = "Checkpoint rewind is not supported in K-brain mode.";
  const element = CheckpointRewindProvider({
    conversationId: "c",
    disabledReason: reason,
    children: null,
    client: { list: () => assert.fail("unsupported checkpoint read") },
    resolveAuthorizedRoots: assert.fail,
  });
  effects.forEach((effect) => effect());
  contexts[0].current = element.props.value;
  const action = useCheckpointRewindAction("turn");
  assert.equal(action.disabled, true);
  assert.equal(action.disabledReason, reason);
  assert.equal(action.onRewind, undefined);
});

test("frontend builtin tool registry fails closed in K-brain mode", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      [source("lib/host.ts")]: { isKBrainBackendEnabled: () => true },
    },
  });
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  await assert.rejects(buildBuiltinToolRegistry({}), /tools are owned by the backend/);
});
