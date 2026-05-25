import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const normalize = loader.loadModule("src/lib/settings/normalize.ts");
const sync = loader.loadModule("src/lib/settings/sync.ts");

test("basic provider field normalizers trim values and remove duplicate models", () => {
  assert.equal(normalize.normalizeBaseUrl(" https://api.example.com/v1/// "), "https://api.example.com/v1//");
  assert.equal(normalize.normalizeBaseUrl(" https:/api.example.com/v1/ "), "https://api.example.com/v1");
  assert.equal(normalize.normalizeApiKey("  token  "), "token");
  assert.deepEqual(
    normalize.normalizeModels([" gpt-5 ", "", "gpt-5", "claude-sonnet"]),
    ["gpt-5", "claude-sonnet"],
  );
});

test("codex provider normalization strips route suffixes and keeps only configured active models", () => {
  const provider = settings.normalizeCustomProvider({
    id: "codex-1",
    name: " Codex ",
    type: "codex",
    baseUrl: " https://api.openai.com/v1/responses/ ",
    apiKey: " key ",
    models: [" gpt-5 ", "gpt-5", { id: "gpt-5-mini", contextWindow: "64000", maxTokens: "4096" }],
    activeModels: ["missing", "gpt-5", "gpt-5"],
    requestFormat: "not-valid",
    reasoning: "xhigh",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: false,
  });

  assert.equal(provider.name, "Codex");
  assert.equal(provider.baseUrl, "https://api.openai.com/v1");
  assert.equal(provider.apiKey, "key");
  assert.equal(provider.requestFormat, "openai-responses");
  assert.equal(provider.promptCachingEnabled, false);
  assert.equal(provider.nativeWebSearchEnabled, false);
  assert.deepEqual(provider.activeModels, ["gpt-5"]);
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["gpt-5", "gpt-5-mini"],
  );
  assert.equal(provider.models[0].contextWindow, 258_000);
  assert.equal(provider.models[0].maxOutputToken, 142_000);
  assert.equal(provider.models[1].contextWindow, 64_000);
  assert.equal(provider.models[1].maxOutputToken, 4_096);
});

test("claude provider normalization defaults routing, caching, and model limits", () => {
  const provider = settings.normalizeCustomProvider({
    id: "claude-1",
    type: "claude_code",
    baseUrl: " https://api.anthropic.com/v1/ ",
    models: [{ model: "claude-sonnet" }],
    activeModels: ["claude-sonnet"],
    promptCachingEnabled: undefined,
  });

  assert.equal(provider.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(provider.requestFormat, undefined);
  assert.equal(provider.promptCachingEnabled, true);
  assert.equal(provider.nativeWebSearchEnabled, true);
  assert.equal(provider.models[0].contextWindow, 200_000);
  assert.equal(provider.models[0].maxOutputToken, 32_000);
});

test("gemini provider normalization keeps native routing and model limits", () => {
  const provider = settings.normalizeCustomProvider({
    id: "gemini-1",
    name: " Gemini ",
    type: "gemini",
    baseUrl: " https://generativelanguage.googleapis.com/v1beta/ ",
    apiKey: " key ",
    models: [{ model: "gemini-3.5-flash" }],
    activeModels: ["gemini-3.5-flash"],
    requestFormat: "openai-responses",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: false,
  });

  assert.equal(provider.name, "Gemini");
  assert.equal(provider.type, "gemini");
  assert.equal(provider.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(provider.apiKey, "key");
  assert.equal(provider.requestFormat, undefined);
  assert.equal(provider.promptCachingEnabled, false);
  assert.equal(provider.nativeWebSearchEnabled, false);
  assert.deepEqual(provider.activeModels, ["gemini-3.5-flash"]);
  assert.equal(provider.models[0].contextWindow, 1_048_576);
  assert.equal(provider.models[0].maxOutputToken, 65_536);
});

test("settings normalization drops stale selected models and preserves valid selections", () => {
  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5"],
      activeModels: ["gpt-5"],
    },
  ];

  const stale = settings.normalizeSettings({
    customProviders,
    selectedModel: { customProviderId: "provider-1", model: "missing" },
  });
  assert.equal(stale.selectedModel, undefined);

  const valid = settings.normalizeSettings({
    customProviders,
    selectedModel: { customProviderId: "provider-1", model: "gpt-5" },
  });
  assert.deepEqual(valid.selectedModel, { customProviderId: "provider-1", model: "gpt-5" });
});

test("chat runtime controls default and follow provider reasoning support", () => {
  const defaults = settings.getDefaultSettings();
  assert.deepEqual(defaults.chatRuntimeControls, {
    thinkingEnabled: true,
    nativeWebSearchEnabled: true,
    reasoning: "high",
    reasoningByProvider: {
      claude_code: "high",
      codex_openai_responses: "high",
      codex_openai_completions: "high",
      gemini: "high",
    },
  });

  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({}), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({ providerId: "claude_code" }), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-responses",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-completions",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({ providerId: "gemini" }), [
    "minimal",
    "low",
    "medium",
    "high",
  ]);

  assert.deepEqual(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        thinkingEnabled: false,
        nativeWebSearchEnabled: false,
        reasoning: "xhigh",
        reasoningByProvider: {
          gemini: "xhigh",
        },
      },
      { providerId: "gemini" },
    ),
    {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "high",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "xhigh",
        gemini: "high",
      },
    },
  );
  assert.deepEqual(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        thinkingEnabled: true,
        nativeWebSearchEnabled: true,
        reasoning: "xhigh",
        reasoningByProvider: {
          codex_openai_completions: "xhigh",
        },
      },
      { providerId: "codex", requestFormat: "openai-completions" },
    ),
    {
      thinkingEnabled: true,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "xhigh",
        gemini: "high",
      },
    },
  );

  assert.deepEqual(
    settings.updateChatRuntimeControlsForProvider(
      defaults.chatRuntimeControls,
      { reasoning: "xhigh" },
      { providerId: "codex", requestFormat: "openai-responses" },
    ),
    {
      thinkingEnabled: true,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "high",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "high",
        gemini: "high",
      },
    },
  );
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        ...defaults.chatRuntimeControls,
        reasoningByProvider: {
          ...defaults.chatRuntimeControls.reasoningByProvider,
          claude_code: "xhigh",
          gemini: "low",
        },
      },
      { providerId: "claude_code" },
    ).reasoning,
    "xhigh",
  );
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(
      {
        ...defaults.chatRuntimeControls,
        reasoningByProvider: {
          ...defaults.chatRuntimeControls.reasoningByProvider,
          claude_code: "xhigh",
          gemini: "low",
        },
      },
      { providerId: "gemini" },
    ).reasoning,
    "low",
  );

  const normalized = settings.normalizeSettings({
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "invalid",
    },
  });
  assert.deepEqual(normalized.chatRuntimeControls, {
    thinkingEnabled: false,
    nativeWebSearchEnabled: false,
    reasoning: "high",
    reasoningByProvider: {
      claude_code: "high",
      codex_openai_responses: "high",
      codex_openai_completions: "high",
      gemini: "high",
    },
  });
});

test("memory model settings only keep enabled provider models", () => {
  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5", "gpt-5.4"],
      activeModels: ["gpt-5"],
    },
  ];

  const normalized = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "gpt-5" },
      summaryModel: { customProviderId: "provider-1", model: "gpt-5.4" },
    },
  });

  assert.deepEqual(normalized.memory.organizerModel, {
    customProviderId: "provider-1",
    model: "gpt-5",
  });
  assert.equal(normalized.memory.summaryModel, undefined);

  const updated = settings.updateMemorySettings(normalized, {
    organizerModel: undefined,
    summaryModel: { customProviderId: "provider-1", model: "gpt-5" },
  });
  assert.equal(updated.memory.organizerModel, undefined);
  assert.deepEqual(updated.memory.summaryModel, {
    customProviderId: "provider-1",
    model: "gpt-5",
  });
});

test("memory organizer settings normalize schedule and disable stale enabled state", () => {
  const defaults = settings.getDefaultSettings();
  assert.equal(defaults.memory.organizerSchedule.frequency, "none");
  assert.equal(defaults.memory.organizerEnabled, false);
  assert.equal(
    settings.computeNextMemoryOrganizerRunAt(defaults.memory.organizerSchedule),
    undefined,
  );

  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5"],
      activeModels: ["gpt-5"],
    },
  ];

  const normalized = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "gpt-5" },
      organizerEnabled: true,
      organizerSchedule: {
        frequency: "weekly",
        timeLocal: "25:99",
        weekday: 9,
        timezone: "",
      },
      organizerScope: "projects",
      organizerMode: "aggressive",
    },
  });

  assert.equal(normalized.memory.organizerEnabled, true);
  assert.equal(normalized.memory.organizerSchedule.frequency, "weekly");
  assert.equal(normalized.memory.organizerSchedule.timeLocal, "03:00");
  assert.equal(normalized.memory.organizerSchedule.weekday, 1);
  assert.equal(typeof normalized.memory.organizerSchedule.timezone, "string");
  assert.equal(normalized.memory.organizerScope, "projects");
  assert.equal(normalized.memory.organizerMode, "aggressive");
  assert.equal(typeof normalized.memory.organizerNextRunAt, "number");

  const stale = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "missing" },
      organizerEnabled: true,
      organizerNextRunAt: 123,
    },
  });

  assert.equal(stale.memory.organizerModel, undefined);
  assert.equal(stale.memory.organizerEnabled, false);
  assert.equal(stale.memory.organizerNextRunAt, undefined);

  const disabledSchedule = settings.normalizeSettings({
    customProviders,
    memory: {
      organizerModel: { customProviderId: "provider-1", model: "gpt-5" },
      organizerEnabled: true,
      organizerSchedule: {
        frequency: "none",
      },
      organizerNextRunAt: 123,
    },
  });

  assert.equal(disabledSchedule.memory.organizerSchedule.frequency, "none");
  assert.equal(disabledSchedule.memory.organizerEnabled, false);
  assert.equal(disabledSchedule.memory.organizerNextRunAt, undefined);
});

test("gateway settings sync payload redacts provider api keys", () => {
  const appSettings = settings.normalizeSettings({
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "secret-key",
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "low",
      reasoningByProvider: {
        claude_code: "low",
        codex_openai_responses: "minimal",
        codex_openai_completions: "high",
        gemini: "minimal",
      },
    },
  });

  const payload = sync.buildGatewaySettingsSyncPayload(appSettings);
  assert.equal(payload.customProviders[0].apiKey, undefined);
  assert.equal(payload.customProviders[0].apiKeyConfigured, true);
  assert.equal(payload.customProviders[0].nativeWebSearchEnabled, true);
  assert.deepEqual(payload.chatRuntimeControls, appSettings.chatRuntimeControls);
  assert.equal(payload.providerApiKeyUpdates, undefined);

  const updatePayload = sync.buildGatewaySettingsSyncPayload(appSettings, {
    includeProviderApiKeyUpdates: true,
  });
  assert.equal(updatePayload.customProviders[0].apiKey, undefined);
  assert.deepEqual(updatePayload.providerApiKeyUpdates, {
    "provider-1": "secret-key",
  });
});

test("gateway settings sync applies redacted providers without clearing local api keys", () => {
  const current = settings.normalizeSettings({
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "old-key",
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
  });

  const redacted = sync.applyGatewaySettingsSyncPayload(current, {
    customProviders: [
      {
        id: "provider-1",
        name: "Renamed",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKeyConfigured: true,
        nativeWebSearchEnabled: false,
        models: ["gpt-5.4"],
        activeModels: ["gpt-5.4"],
      },
    ],
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "minimal",
        codex_openai_completions: "high",
        gemini: "xhigh",
      },
    },
  });
  assert.equal(redacted.customProviders[0].name, "Renamed");
  assert.equal(redacted.customProviders[0].apiKey, "old-key");
  assert.equal(redacted.customProviders[0].nativeWebSearchEnabled, false);
  assert.equal(redacted.chatRuntimeControls.thinkingEnabled, false);
  assert.equal(redacted.chatRuntimeControls.nativeWebSearchEnabled, false);
  assert.equal(redacted.chatRuntimeControls.reasoning, "xhigh");
  assert.equal(redacted.chatRuntimeControls.reasoningByProvider.claude_code, "xhigh");
  assert.equal(redacted.chatRuntimeControls.reasoningByProvider.codex_openai_responses, "minimal");
  assert.equal(redacted.chatRuntimeControls.reasoningByProvider.gemini, "high");

  const updated = sync.applyGatewaySettingsSyncPayload(current, {
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKeyConfigured: true,
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
    providerApiKeyUpdates: {
      "provider-1": "new-key",
    },
  });
  assert.equal(updated.customProviders[0].apiKey, "new-key");
});

test("web storage redaction clears api keys but keeps configured state", () => {
  const appSettings = settings.normalizeSettings({
    customProviders: [
      {
        id: "provider-1",
        name: "Provider",
        type: "codex",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "secret-key",
        models: ["gpt-5"],
        activeModels: ["gpt-5"],
      },
    ],
  });

  const redacted = sync.redactSettingsForWebStorage(appSettings);
  assert.equal(redacted.customProviders[0].apiKey, "");
  assert.equal(redacted.customProviders[0].apiKeyConfigured, true);
});

test("only one agent prompt template remains enabled after normalization", () => {
  const agents = settings.normalizeAgentPromptTemplates([
    { id: "a", name: "A", prompt: "Prompt A", enabled: true },
    { id: "b", name: "B", prompt: "Prompt B", enabled: true },
    { id: "c", name: "C", prompt: "Prompt C", enabled: false },
  ]);

  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.enabled]),
    [
      ["a", true],
      ["b", false],
      ["c", false],
    ],
  );
});

test("hook and cron normalization keep request bodies only for methods that support them", () => {
  const hook = settings.normalizeConversationHook({
    id: "hook-1",
    type: "http",
    event: "tool_execution_end",
    name: "Webhook",
    requests: [
      {
        id: "request-1",
        method: "get",
        url: " https://example.com ",
        headers: { " X-Test ": " yes ", empty: "" },
        body: { ignored: true },
      },
      {
        id: "request-2",
        method: "patch",
        url: "https://example.com/update",
        body: { kept: true },
      },
    ],
  });

  assert.equal(hook.event, "tool_execution_end");
  assert.equal(hook.requests[0].method, "GET");
  assert.equal(hook.requests[0].body, undefined);
  assert.deepEqual(hook.requests[0].headers, { "X-Test": "yes" });
  assert.deepEqual(hook.requests[1].body, { kept: true });

  const cronTask = settings.normalizeCronTask({
    id: "cron-1",
    type: "prompt",
    prompt: " Run daily ",
    selectedModel: { customProviderId: "p", model: "m" },
    script: "ignored",
  });
  assert.equal(cronTask.type, "prompt");
  assert.equal(cronTask.prompt, "Run daily");
  assert.deepEqual(cronTask.selectedModel, { customProviderId: "p", model: "m" });
  assert.equal(cronTask.script, undefined);

  const finiteCronTask = settings.normalizeCronTask({
    id: "cron-finite",
    type: "bash",
    script: "echo finite",
    remainingExecutions: "3",
  });
  assert.equal(finiteCronTask.remainingExecutions, 3);

  const exhaustedCronTask = settings.normalizeCronTask({
    id: "cron-exhausted",
    type: "bash",
    script: "echo exhausted",
    enabled: true,
    remainingExecutions: 0,
  });
  assert.equal(exhaustedCronTask.remainingExecutions, 0);
  assert.equal(exhaustedCronTask.enabled, false);

  const invalidCronTask = settings.normalizeCronTask({
    id: "cron-invalid",
    type: "bash",
    script: "echo invalid",
    remainingExecutions: -1,
  });
  assert.equal(invalidCronTask.remainingExecutions, undefined);
});

test("command hook normalization uses script only and drops legacy commands", () => {
  const legacy = settings.normalizeConversationHook({
    id: "hook-legacy",
    type: "command",
    event: "agent_start",
    name: "Legacy",
    commands: [["echo", "legacy"]],
  });
  assert.equal(legacy.script, "");
  assert.equal(legacy.commands, undefined);

  const scriptHook = settings.normalizeConversationHook({
    id: "hook-script",
    type: "command",
    event: "agent_end",
    name: "Script",
    script: " printf hook-ready ",
  });
  assert.equal(scriptHook.script, "printf hook-ready");
  assert.equal(scriptHook.commands, undefined);
});

test("mcp and remote settings normalize transport, selection, ports, and tokens", () => {
  const mcp = settings.normalizeMcpSettings({
    servers: [
      { id: "server-a", enabled: true, transport: "http", url: " https://mcp.example.com ", timeoutMs: "-1" },
      { id: "server-b", enabled: false, transport: "bad", command: " node ", args: [" server.js ", ""] },
    ],
    selected: ["server-b", "missing", "server-b", "server-a"],
  });

  assert.deepEqual(mcp.selected, ["server-b", "server-a"]);
  assert.equal(mcp.servers[0].transport, "http");
  assert.equal(mcp.servers[0].timeoutMs, 60_000);
  assert.equal(mcp.servers[1].transport, "stdio");
  assert.deepEqual(mcp.servers[1].args, ["server.js"]);

  const remote = settings.normalizeRemoteSettings({
    enabled: true,
    gatewayUrl: " http:/127.0.0.1:8787/ ",
    grpcPort: "0",
    grpcEndpoint: " tcp.proxy.rlwy.net:12345/ ",
    token: " secret ",
    autoReconnect: false,
    heartbeatInterval: "15.8",
  });

  assert.equal(remote.gatewayUrl, "http://127.0.0.1:8787");
  assert.equal(remote.grpcPort, 50051);
  assert.equal(remote.grpcEndpoint, "tcp.proxy.rlwy.net:12345");
  assert.equal(remote.token, "secret");
  assert.equal(remote.autoReconnect, false);
  assert.equal(remote.heartbeatInterval, 15);
});
