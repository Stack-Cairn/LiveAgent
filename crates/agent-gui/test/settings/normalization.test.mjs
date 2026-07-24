import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const normalize = loader.loadModule("src/lib/settings/normalize.ts");
const sync = loader.loadModule("src/lib/settings/sync.ts");
const RIGHT_DOCK_TAB_IDS = settings.RIGHT_DOCK_SINGLETON_TAB_IDS;

test("basic provider field normalizers trim values and remove duplicate models", () => {
  assert.equal(normalize.normalizeBaseUrl(" https://api.example.com/v1/// "), "https://api.example.com/v1//");
  assert.equal(normalize.normalizeBaseUrl(" https:/api.example.com/v1/ "), "https://api.example.com/v1");
  assert.equal(normalize.normalizeApiKey("  token  "), "token");
  assert.deepEqual(
    normalize.normalizeModels([" gpt-5 ", "", "gpt-5", "claude-sonnet"]),
    ["gpt-5", "claude-sonnet"],
  );
});

test("custom provider normalization defaults and filters ordered custom headers", () => {
  assert.deepEqual(settings.normalizeCustomProvider({}).customHeaders, []);

  const provider = settings.normalizeCustomProvider({
    customHeaders: [
      { key: " X-Request-ID ", value: " request-123 " },
      { key: "", value: "ignored" },
      { key: "   ", value: "ignored" },
      { key: "anthropic-beta", value: "feature-flag" },
      null,
    ],
  });

  assert.deepEqual(provider.customHeaders, [
    { key: "X-Request-ID", value: " request-123 " },
    { key: "anthropic-beta", value: "feature-flag" },
  ]);
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
  // OpenAI 缓存（稳定 prompt_cache_key）默认开启，可显式关闭。
  assert.equal(provider.promptCachingEnabled, true);
  assert.equal(provider.nativeWebSearchEnabled, false);
  assert.deepEqual(provider.activeModels, ["gpt-5"]);
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["gpt-5", "gpt-5-mini"],
  );
  assert.equal(provider.models[0].contextWindow, 400_000);
  assert.equal(provider.models[0].maxOutputToken, 128_000);
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

test("codex provider normalization can disable prompt caching explicitly", () => {
  const provider = settings.normalizeCustomProvider({
    id: "codex-2",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    promptCachingEnabled: false,
  });
  assert.equal(provider.promptCachingEnabled, false);
  assert.equal(provider.promptCacheRetention, undefined);
});

test("claude provider normalization keeps the long cache retention preference", () => {
  const provider = settings.normalizeCustomProvider({
    id: "claude-long",
    type: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    promptCacheRetention: "long",
  });
  assert.equal(provider.promptCacheRetention, "long");

  const invalid = settings.normalizeCustomProvider({
    id: "claude-invalid",
    type: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    promptCacheRetention: "forever",
  });
  assert.equal(invalid.promptCacheRetention, undefined);

  const codex = settings.normalizeCustomProvider({
    id: "codex-long",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
    promptCacheRetention: "long",
  });
  assert.equal(codex.promptCacheRetention, undefined, "retention is Anthropic-only");
});

test("model config normalization drops legacy persisted pricing", () => {
  // 计费功能已移除：旧设置里持久化的 cost 键在读侧归一时被丢弃。
  const provider = settings.normalizeCustomProvider({
    id: "relay-1",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    models: [
      {
        id: "relay-model",
        contextWindow: 128_000,
        maxOutputToken: 8_192,
        cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 3 },
      },
      { id: "no-cost-model", contextWindow: 128_000, maxOutputToken: 8_192 },
    ],
  });

  assert.equal("cost" in provider.models[0], false);
  assert.equal("cost" in provider.models[1], false);
  assert.equal(provider.models[0].contextWindow, 128_000);
  assert.equal(provider.models[0].maxOutputToken, 8_192);
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

test("custom settings migrate the legacy font family and normalize each typography role", () => {
  const defaults = settings.normalizeSettings({}).customSettings;
  assert.equal(defaults.interfaceFontFamily, "");
  assert.equal(defaults.chatFontFamily, "");
  assert.equal(defaults.codeFontFamily, "");

  const migrated = settings.normalizeSettings({ customSettings: { fontFamily: "Inter" } });
  assert.equal(migrated.customSettings.interfaceFontFamily, "Inter");
  assert.equal(Object.hasOwn(migrated.customSettings, "fontFamily"), false);

  const normalized = settings.normalizeSettings({
    customSettings: {
      interfaceFontFamily: 'Inter, "PingFang SC", sans-serif',
      chatFontFamily: "serif",
      codeFontFamily: "Menlo",
    },
  });
  assert.equal(normalized.customSettings.interfaceFontFamily, 'Inter, "PingFang SC", sans-serif');
  assert.equal(normalized.customSettings.chatFontFamily, "serif");
  assert.equal(normalized.customSettings.codeFontFamily, "Menlo");
  assert.equal(
    settings.normalizeSettings({
      customSettings: { codeFontFamily: "url(https://evil.example/font.woff2)" },
    }).customSettings.codeFontFamily,
    "",
  );
});

test("settings normalization canonicalizes project keyed maps with Windows path compatibility", () => {
  const normalized = settings.normalizeSettings({
    ssh: {
      hosts: [
        { id: "host-a", host: "example.com", username: "me" },
        { id: "host-b", host: "example.org", username: "me" },
      ],
      projectHostAssociations: {
        "c:/repo": ["host-b"],
        "C:\\Repo\\": ["host-a"],
      },
    },
    customSettings: {
      rightDock: {
        projects: {
          "C:\\Repo\\": {
            activeTabId: RIGHT_DOCK_TAB_IDS.fileTree,
            tabOrder: [
              RIGHT_DOCK_TAB_IDS.gitReview,
              "",
              RIGHT_DOCK_TAB_IDS.fileTree,
              RIGHT_DOCK_TAB_IDS.fileTree,
              "x".repeat(200),
            ],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.fileTree]: {
                id: RIGHT_DOCK_TAB_IDS.fileTree,
                kind: "fileTree",
                projectPathKey: "C:\\Repo\\",
                createdAt: 1,
                uiState: {
                  query: "legacy",
                  selectedPath: "src\\main.ts",
                  expandedPaths: ["", "src", "src\\components", "src"],
                  showHidden: true,
                  revision: 2,
                },
              },
              [RIGHT_DOCK_TAB_IDS.gitReview]: {
                id: RIGHT_DOCK_TAB_IDS.gitReview,
                kind: "gitReview",
                projectPathKey: "C:\\Repo\\",
                createdAt: 2,
              },
              invalid: {
                id: "invalid",
                kind: "unknown",
                projectPathKey: "C:\\Repo\\",
                createdAt: 3,
              },
            },
          },
        },
      },
    },
  });

  assert.deepEqual(normalized.ssh.projectHostAssociations, {
    "c:/repo": ["host-b"],
  });
  assert.deepEqual(Object.keys(normalized.customSettings.rightDock.projects), ["c:/repo"]);
  assert.deepEqual(normalized.customSettings.rightDock.projects["c:/repo"], {
    activeTabId: RIGHT_DOCK_TAB_IDS.fileTree,
    tabOrder: [RIGHT_DOCK_TAB_IDS.gitReview, RIGHT_DOCK_TAB_IDS.fileTree],
    tools: {
      fileTree: {
        openedAt: 1,
        uiState: {
          query: "legacy",
          selectedPath: "src/main.ts",
          expandedPaths: ["", "src", "src/components"],
          showHidden: true,
          revision: 2,
        },
      },
      gitReview: {
        openedAt: 2,
      },
    },
    openVersion: 0,
    stateVersion: 0,
    writerId: "",
    lastUsedAt: 0,
  });
});

test("custom settings conversation title model only keeps enabled provider models", () => {
  const customProviders = [
    {
      id: "provider-1",
      name: "Provider",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      models: ["gpt-5", "gpt-5-mini"],
      activeModels: ["gpt-5-mini"],
    },
  ];

  const normalized = settings.normalizeSettings({
    customProviders,
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5-mini" },
    },
  });
  assert.deepEqual(normalized.customSettings.conversationTitleModel, {
    customProviderId: "provider-1",
    model: "gpt-5-mini",
  });

  const stale = settings.normalizeSettings({
    customProviders,
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5" },
    },
  });
  assert.equal(stale.customSettings.conversationTitleModel, undefined);

  const cleared = settings.updateCustomSettings(normalized, {
    conversationTitleModel: undefined,
  });
  assert.equal(cleared.customSettings.conversationTitleModel, undefined);
});

test("chat runtime controls default and follow provider model reasoning support", () => {
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
      xai: "high",
    },
  });

  // 没有 modelId 就无法解析目录，拿不到任何档位。
  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({}), []);

  // claude-opus-4-5：pi-ai 目录没有 thinkingLevelMap，标准四档，无 xhigh/max。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-opus-4-5",
      baseUrl: "https://api.anthropic.com",
    }),
    ["minimal", "low", "medium", "high"],
  );
  // claude-sonnet-5：目录显式声明 xhigh/max。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-sonnet-5",
      baseUrl: "https://api.anthropic.com",
    }),
    ["minimal", "low", "medium", "high", "xhigh", "max"],
  );
  // gpt-5.1（openai-responses）：目录只覆盖 off，标准四档。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-responses",
      modelId: "gpt-5.1",
      baseUrl: "https://api.openai.com/v1",
    }),
    ["minimal", "low", "medium", "high"],
  );
  // gpt-5.2：目录额外声明 xhigh，仍无 max。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-responses",
      modelId: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  // Groq qwen/qwen3-32b（openai-completions 兼容端点）：目录覆盖到 xhigh，仍无 max。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-completions",
      modelId: "qwen/qwen3-32b",
      baseUrl: "https://api.groq.com/openai/v1",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  // gemini-2.5-flash：预算档字段驱动，标准四档，无 xhigh/max。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "gemini",
      modelId: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    }),
    ["minimal", "low", "medium", "high"],
  );
  // gemini-3-pro-preview：目录把 minimal/medium 显式置空，只剩两档（3.0/3.1 同档）。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "gemini",
      modelId: "gemini-3-pro-preview",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    }),
    ["low", "high"],
  );
  // 目录之外的自定义模型（glm/kimi 等三方聚合）按可推理处理：标准四档，
  // 不因 id 猜不中而禁用思考。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-completions",
      modelId: "glm-4.7",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
    }),
    ["minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "glm-4.7",
      baseUrl: "https://api.z.ai/api/anthropic",
    }),
    ["minimal", "low", "medium", "high"],
  );
  // DeepSeek 走 codex：适配层 thinkingLevelMap 额外开出 xhigh。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      modelId: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );

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
      {
        providerId: "gemini",
        modelId: "gemini-2.5-flash",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
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
        xai: "xhigh",
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
      {
        providerId: "codex",
        requestFormat: "openai-completions",
        modelId: "qwen/qwen3-32b",
        baseUrl: "https://api.groq.com/openai/v1",
      },
    ),
    {
      thinkingEnabled: true,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "xhigh",
        // gemini / xai 未在 reasoningByProvider 输入里显式给出，也未参与本次调用
        // 的当前 provider key，因此只继承顶层 reasoning 原值，不做钳制。
        gemini: "xhigh",
        xai: "xhigh",
      },
    },
  );

  assert.deepEqual(
    settings.updateChatRuntimeControlsForProvider(
      defaults.chatRuntimeControls,
      { reasoning: "xhigh" },
      {
        providerId: "codex",
        requestFormat: "openai-responses",
        modelId: "gpt-5.2",
        baseUrl: "https://api.openai.com/v1",
      },
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
        xai: "high",
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
      {
        providerId: "claude_code",
        modelId: "claude-sonnet-5",
        baseUrl: "https://api.anthropic.com",
      },
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
      {
        providerId: "gemini",
        modelId: "gemini-2.5-flash",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
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
      xai: "high",
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
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5" },
      rightDock: {
        width: 612,
        projects: {
          "/workspace/a": {
            activeTabId: RIGHT_DOCK_TAB_IDS.tunnel,
            tabOrder: [RIGHT_DOCK_TAB_IDS.tunnel, RIGHT_DOCK_TAB_IDS.fileTree],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.fileTree]: {
                id: RIGHT_DOCK_TAB_IDS.fileTree,
                kind: "fileTree",
                projectPathKey: "/workspace/a",
                createdAt: 1,
                uiState: {
                  query: "src",
                  selectedPath: "src/main.ts",
                  expandedPaths: ["", "src", "src/../bad", "src"],
                  revision: 3,
                },
              },
              [RIGHT_DOCK_TAB_IDS.tunnel]: {
                id: RIGHT_DOCK_TAB_IDS.tunnel,
                kind: "tunnel",
                projectPathKey: "/workspace/a",
                createdAt: 2,
              },
            },
            openVersion: 3,
            stateVersion: 4,
          },
          "/workspace/b": {
            activeTabId: RIGHT_DOCK_TAB_IDS.gitReview,
            tabOrder: [RIGHT_DOCK_TAB_IDS.gitReview],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.gitReview]: {
                id: RIGHT_DOCK_TAB_IDS.gitReview,
                kind: "gitReview",
                projectPathKey: "/workspace/b",
                createdAt: 3,
              },
            },
            openVersion: 2,
            stateVersion: 2,
          },
        },
      },
    },
  });

  const payload = sync.buildGatewaySettingsSyncPayload(appSettings);
  assert.equal(payload.customProviders[0].apiKey, undefined);
  assert.equal(payload.customProviders[0].apiKeyConfigured, true);
  assert.equal(payload.customProviders[0].nativeWebSearchEnabled, true);
  assert.deepEqual(payload.customSettings.conversationTitleModel, {
    customProviderId: "provider-1",
    model: "gpt-5",
  });
  assert.deepEqual(payload.customSettings.chatSidebar, {
    projectsCollapsed: false,
    recentCollapsed: false,
  });
  assert.deepEqual(payload.customSettings.rightDock, {
    width: 612,
    projects: {
      "/workspace/a": {
        activeTabId: RIGHT_DOCK_TAB_IDS.tunnel,
        tabOrder: [RIGHT_DOCK_TAB_IDS.tunnel, RIGHT_DOCK_TAB_IDS.fileTree],
        tools: {
          fileTree: {
            openedAt: 1,
            uiState: {
              query: "src",
              selectedPath: "src/main.ts",
              expandedPaths: ["", "src", "src/bad"],
              showHidden: false,
              revision: 3,
            },
          },
          tunnel: {
            openedAt: 2,
          },
        },
        openVersion: 3,
        stateVersion: 4,
        writerId: "",
        lastUsedAt: 0,
      },
      "/workspace/b": {
        activeTabId: RIGHT_DOCK_TAB_IDS.gitReview,
        tabOrder: [RIGHT_DOCK_TAB_IDS.gitReview],
        tools: {
          gitReview: {
            openedAt: 3,
          },
        },
        openVersion: 2,
        stateVersion: 2,
        writerId: "",
        lastUsedAt: 0,
      },
    },
  });
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

test("gateway settings sync redacts ssh secrets and preserves configured state", () => {
  const appSettings = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          port: 2222,
          username: "deploy",
          authType: "privateKey",
          password: "ssh-password",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
          privateKeyPath: "~/.ssh/id_ed25519",
          privateKeyPassphrase: "key-passphrase",
          proxy: {
            type: "http",
            url: "http://127.0.0.1",
            port: 1080,
            username: "proxy-user",
            password: "proxy-password",
          },
        },
      ],
      projectHostAssociations: {
        "/workspace/project": ["prod", "missing", "prod"],
      },
    },
    remote: {
      enableWebTerminal: true,
      enableWebSshTerminal: true,
    },
  });

  const payload = sync.buildGatewaySettingsSyncPayload(appSettings);
  assert.equal(payload.ssh.hosts[0].password, "");
  assert.equal(payload.ssh.hosts[0].privateKey, "");
  assert.equal(payload.ssh.hosts[0].privateKeyPassphrase, "");
  assert.equal(payload.ssh.hosts[0].proxy.password, "");
  assert.equal(payload.ssh.hosts[0].passwordConfigured, true);
  assert.equal(payload.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(payload.ssh.hosts[0].privateKeyPassphraseConfigured, true);
  assert.equal(payload.ssh.hosts[0].proxy.passwordConfigured, true);
  assert.deepEqual(payload.ssh.projectHostAssociations, {
    "/workspace/project": ["prod"],
  });
  assert.equal(payload.sshSecretUpdates, undefined);
  assert.deepEqual(payload.remote, {
    enableWebTerminal: true,
    enableWebSshTerminal: true,
    enableWebGit: false,
    enableWebTunnels: false,
  });

  const updatePayload = sync.buildGatewaySettingsSyncPayload(appSettings, {
    includeProviderApiKeyUpdates: true,
  });
  assert.deepEqual(updatePayload.sshSecretUpdates, {
    prod: {
      password: "ssh-password",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
      privateKeyPassphrase: "key-passphrase",
      proxyPassword: "proxy-password",
    },
  });
});

test("ssh keyboard-interactive hosts normalize without credential secrets or secret updates", () => {
  const appSettings = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "kbi-prod",
          name: "Keyboard Interactive Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "keyboardInteractive",
          password: "old-password",
          passwordConfigured: true,
          privateKey: "old-key",
          privateKeyPath: "~/.ssh/id_rsa",
          privateKeyConfigured: true,
          privateKeyPassphrase: "old-passphrase",
          privateKeyPassphraseConfigured: true,
          proxy: {
            type: "http",
            url: "http://127.0.0.1",
            port: 8080,
            username: "proxy-user",
            password: "proxy-password",
          },
        },
      ],
    },
  });

  const host = appSettings.ssh.hosts[0];
  assert.equal(host.authType, "keyboardInteractive");
  assert.equal(host.password, "");
  assert.equal(host.passwordConfigured, false);
  assert.equal(host.privateKey, "");
  assert.equal(host.privateKeyPath, "");
  assert.equal(host.privateKeyConfigured, false);
  assert.equal(host.privateKeyPassphrase, "");
  assert.equal(host.privateKeyPassphraseConfigured, false);

  const payload = sync.buildGatewaySettingsSyncPayload(appSettings, {
    includeProviderApiKeyUpdates: true,
  });
  assert.deepEqual(payload.sshSecretUpdates, {
    "kbi-prod": { proxyPassword: "proxy-password" },
  });
  assert.equal(payload.ssh.hosts[0].passwordConfigured, false);
  assert.equal(payload.ssh.hosts[0].privateKeyConfigured, false);
  assert.equal(payload.ssh.hosts[0].privateKeyPassphraseConfigured, false);
  assert.equal(payload.ssh.hosts[0].proxy.password, "");
  assert.equal(payload.ssh.hosts[0].proxy.passwordConfigured, true);
});

test("legacy ssh agent hosts fall back to password auth", () => {
  const appSettings = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "legacy-agent",
          name: "Legacy Agent",
          host: "legacy.example.com",
          username: "deploy",
          authType: "agent",
        },
      ],
    },
  });

  const host = appSettings.ssh.hosts[0];
  assert.equal(host.authType, "password");
  assert.equal(host.password, "");
  assert.equal(host.passwordConfigured, false);
});

test("workspace project selection does not rewrite global system workdir or sync active project", () => {
  const resolvedSystem = settings.resolveWorkspaceProjects(
    {
      ...settings.getDefaultSettings().system,
      executionMode: "tools",
      workdir: "/default-workdir",
      workspaceProjects: [
        {
          id: "project-a",
          name: "Project A",
          path: "/project-a",
          kind: "folder",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeWorkspaceProjectId: "project-a",
    },
    "/default-workdir",
  );

  assert.equal(resolvedSystem.workdir, "/default-workdir");
  assert.equal(resolvedSystem.activeWorkspaceProjectId, "project-a");

  const payload = sync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: resolvedSystem,
    }),
  );
  assert.equal(Object.hasOwn(payload.system, "activeWorkspaceProjectId"), false);
  assert.equal(payload.system.workdir, "/default-workdir");

  const synced = sync.applyGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: resolvedSystem,
    }),
    payload,
  );
  assert.equal(synced.system.activeWorkspaceProjectId, "project-a");
});

test("gateway settings sync preserves active workspace project by path when ids differ", () => {
  const current = settings.normalizeSettings({
    system: settings.resolveWorkspaceProjects(
      {
        ...settings.getDefaultSettings().system,
        executionMode: "tools",
        workdir: "/default-workdir",
        workspaceProjects: [
          {
            id: "web-project-a",
            name: "Project A",
            path: "/project-a",
            kind: "folder",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        activeWorkspaceProjectId: "web-project-a",
      },
      "/default-workdir",
    ),
  });
  const incoming = sync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: settings.resolveWorkspaceProjects(
        {
          ...settings.getDefaultSettings().system,
          executionMode: "tools",
          workdir: "/default-workdir",
          workspaceProjects: [
            {
              id: "desktop-project-a",
              name: "Project A",
              path: "/project-a",
              kind: "folder",
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        },
        "/default-workdir",
      ),
    }),
  );

  const synced = sync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(synced.system.activeWorkspaceProjectId, "desktop-project-a");
});

test("normalizes right dock from current settings", () => {
  const currentShape = settings.normalizeSettings({
    customSettings: {
      rightDock: {
        width: 544,
        projects: {
          " /workspace/app ": {
            activeTabId: "missing",
            tabOrder: [
              "terminal-2",
              "",
              "terminal-1",
              "terminal-2",
              "x".repeat(200),
              RIGHT_DOCK_TAB_IDS.fileTree,
            ],
            tabs: {
              "terminal-1": {
                id: "terminal-1",
                kind: "terminal",
                projectPathKey: "/workspace/app",
                title: " Terminal 1 ",
                createdAt: 2,
                params: {
                  sessionId: "terminal-1",
                },
              },
              "terminal-2": {
                id: "terminal-2",
                kind: "terminal",
                projectPathKey: "/workspace/app",
                createdAt: 1,
              },
              [RIGHT_DOCK_TAB_IDS.fileTree]: {
                id: RIGHT_DOCK_TAB_IDS.fileTree,
                kind: "fileTree",
                projectPathKey: "/workspace/app",
                createdAt: 3,
                uiState: {
                  query: "src",
                  selectedPath: "src/../main.ts",
                  expandedPaths: ["", "src", "src\\components", "src"],
                  revision: 4,
                  stateVersion: 5,
                },
              },
              invalid: {
                id: "invalid",
                kind: "fileTree",
                projectPathKey: "/workspace/other",
                createdAt: 4,
              },
            },
            openVersion: 6,
            stateVersion: 7,
          },
          " ": {
            tabOrder: ["ignored"],
            tabs: {},
          },
        },
      },
    },
  });

  assert.equal(currentShape.customSettings.rightDock.width, 544);
  assert.deepEqual(Object.keys(currentShape.customSettings.rightDock.projects), [
    "/workspace/app",
  ]);
  assert.deepEqual(currentShape.customSettings.rightDock.projects["/workspace/app"], {
    // Unknown active ids are user intent (e.g. a session not loaded yet) and
    // must never be reset by normalization.
    activeTabId: "missing",
    // Terminal session ids stay in tabOrder even though terminal tabs are now
    // derived from live sessions instead of persisted entries.
    tabOrder: ["terminal-2", "terminal-1", RIGHT_DOCK_TAB_IDS.fileTree],
    tools: {
      fileTree: {
        openedAt: 3,
        uiState: {
          query: "src",
          selectedPath: "src/main.ts",
          expandedPaths: ["", "src", "src/components"],
          showHidden: false,
          revision: 4,
        },
      },
    },
    openVersion: 6,
    stateVersion: 7,
    writerId: "",
    lastUsedAt: 0,
  });
});

test("opens right dock singleton tabs and updates file tree state per project", () => {
  const base = settings.normalizeSettings({});
  const opened = settings.openRightDockSingletonTab(base, "/workspace/app", "gitReview");
  const openedState = settings.getRightDockProjectState(
    opened.customSettings,
    "/workspace/app",
  );

  assert.equal(openedState.activeTabId, RIGHT_DOCK_TAB_IDS.gitReview);
  assert.deepEqual(openedState.tabOrder, [RIGHT_DOCK_TAB_IDS.gitReview]);
  assert.deepEqual(Object.keys(openedState.tools), ["gitReview"]);
  assert.equal(typeof openedState.tools.gitReview.openedAt, "number");
  assert.ok(openedState.tools.gitReview.openedAt > 0);
  assert.equal(openedState.openVersion, 1);
  assert.equal(openedState.stateVersion, 1);
  assert.equal(openedState.writerId, settings.getRightDockWriterId());
  assert.ok(openedState.lastUsedAt > 0);

  const updated = settings.updateRightDockFileTreeState(opened, "/workspace/app", {
    query: "x".repeat(250),
    selectedPath: "src/../main.ts",
    expandedPaths: ["", "src", "src/../bad", "src\\components", "src"],
    showHidden: true,
    bumpRevision: true,
  });
  const updatedState = settings.getRightDockProjectState(
    updated.customSettings,
    "/workspace/app",
  );

  assert.equal(updatedState.activeTabId, RIGHT_DOCK_TAB_IDS.gitReview);
  assert.deepEqual(updatedState.tabOrder, [
    RIGHT_DOCK_TAB_IDS.gitReview,
    RIGHT_DOCK_TAB_IDS.fileTree,
  ]);
  assert.deepEqual(settings.getRightDockFileTreeState(updated.customSettings, "/workspace/app"), {
    query: "x".repeat(200),
    selectedPath: "src/main.ts",
    expandedPaths: ["", "src", "src/bad", "src/components"],
    showHidden: true,
    revision: 1,
  });
  assert.equal(updatedState.openVersion, 1);
  assert.equal(updatedState.stateVersion, 2);

  const activated = settings.openRightDockSingletonTab(updated, "/workspace/app", "fileTree");
  const activatedState = settings.getRightDockProjectState(
    activated.customSettings,
    "/workspace/app",
  );
  assert.equal(activatedState.activeTabId, RIGHT_DOCK_TAB_IDS.fileTree);
  assert.equal(activatedState.openVersion, 1);
  assert.equal(activatedState.stateVersion, 3);
  assert.equal(
    settings.isRightDockSingletonTabOpen(activated.customSettings, "/workspace/app", "fileTree"),
    true,
  );
});

test("removes right dock state when a workspace project is deleted", () => {
  const base = settings.normalizeSettings({
    ssh: {
      hosts: [
        { id: "host-a", host: "example.com", username: "me" },
        { id: "host-b", host: "example.org", username: "me" },
      ],
      projectHostAssociations: {
        "/workspace/app": ["host-a"],
        "/workspace/other": ["host-b"],
      },
    },
    customSettings: {
      rightDock: {
        projects: {
          "/workspace/app": {
            activeTabId: RIGHT_DOCK_TAB_IDS.fileTree,
            tabOrder: ["terminal-a", RIGHT_DOCK_TAB_IDS.fileTree],
            tabs: {
              "terminal-a": {
                id: "terminal-a",
                kind: "terminal",
                projectPathKey: "/workspace/app",
                createdAt: 1,
              },
              [RIGHT_DOCK_TAB_IDS.fileTree]: {
                id: RIGHT_DOCK_TAB_IDS.fileTree,
                kind: "fileTree",
                projectPathKey: "/workspace/app",
                createdAt: 2,
              },
            },
            openVersion: 3,
            stateVersion: 4,
          },
          "/workspace/other": {
            activeTabId: RIGHT_DOCK_TAB_IDS.gitReview,
            tabOrder: [RIGHT_DOCK_TAB_IDS.gitReview],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.gitReview]: {
                id: RIGHT_DOCK_TAB_IDS.gitReview,
                kind: "gitReview",
                projectPathKey: "/workspace/other",
                createdAt: 3,
              },
            },
            openVersion: 5,
            stateVersion: 6,
          },
        },
      },
    },
  });

  const cleaned = settings.removeRightDockProjectState(base, "/workspace/app");

  assert.deepEqual(cleaned.ssh.projectHostAssociations, {
    "/workspace/other": ["host-b"],
  });
  const tombstone = cleaned.customSettings.rightDock.projects["/workspace/app"];
  assert.deepEqual(tombstone.tabOrder, []);
  assert.deepEqual(tombstone.tools, {});
  assert.equal(tombstone.activeTabId, undefined);
  assert.equal(tombstone.openVersion, 4);
  assert.equal(tombstone.stateVersion, 5);
  assert.equal(tombstone.writerId, settings.getRightDockWriterId());
  assert.equal(typeof tombstone.lastUsedAt, "number");
  assert.ok(tombstone.lastUsedAt > 0);
  assert.deepEqual(cleaned.customSettings.rightDock.projects["/workspace/other"].tabOrder, [
    RIGHT_DOCK_TAB_IDS.gitReview,
  ]);
  assert.equal(settings.removeRightDockProjectState(cleaned, "/workspace/app"), cleaned);
});

test("settings reload uses persisted right dock state only", () => {
  const reloaded = settings.normalizeSettings({
    locale: "en-US",
    customSettings: {
      rightDock: {
        width: 720,
        projects: {
          "/workspace/app": {
            activeTabId: "terminal-1",
            tabOrder: ["terminal-1"],
            tools: {},
            openVersion: 1,
            stateVersion: 1,
          },
        },
      },
    },
  });

  assert.equal(reloaded.locale, "en-US");
  assert.equal(reloaded.customSettings.rightDock.width, 720);
  const project = reloaded.customSettings.rightDock.projects["/workspace/app"];
  // Terminal tabs are derived from live sessions; only the session id order,
  // the active id, and the version bookkeeping are persisted.
  assert.deepEqual(project.tabOrder, ["terminal-1"]);
  assert.equal(project.activeTabId, "terminal-1");
  assert.deepEqual(project.tools, {});
  assert.equal(project.openVersion, 1);
  assert.equal(project.stateVersion, 1);
  // A tools-less bucket without a timestamp starts its tombstone clock at now.
  assert.ok(project.lastUsedAt > 0);
  assert.ok(project.lastUsedAt <= Date.now());
});

test("gateway settings sync keeps right dock width local and syncs project state", () => {
  const current = settings.normalizeSettings({
    customSettings: {
      rightDock: {
        width: 612,
        projects: {
          "/desktop/project": {
            activeTabId: "desktop-terminal",
            tabOrder: ["desktop-terminal"],
            tabs: {
              "desktop-terminal": {
                id: "desktop-terminal",
                kind: "terminal",
                projectPathKey: "/desktop/project",
                createdAt: 1,
              },
            },
            openVersion: 1,
            stateVersion: 1,
          },
          "/shared/project": {
            activeTabId: RIGHT_DOCK_TAB_IDS.fileTree,
            tabOrder: [RIGHT_DOCK_TAB_IDS.fileTree],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.fileTree]: {
                id: RIGHT_DOCK_TAB_IDS.fileTree,
                kind: "fileTree",
                projectPathKey: "/shared/project",
                createdAt: 2,
                uiState: {
                  query: "desktop",
                  selectedPath: "desktop.ts",
                  expandedPaths: ["", "src"],
                  showHidden: true,
                  revision: 1,
                  stateVersion: 3,
                },
              },
            },
            openVersion: 2,
            stateVersion: 3,
          },
        },
      },
    },
  });
  const incoming = settings.normalizeSettings({
    customSettings: {
      rightDock: {
        width: 360,
        projects: {
          "/web/project": {
            activeTabId: "web-terminal",
            tabOrder: ["web-terminal"],
            tabs: {
              "web-terminal": {
                id: "web-terminal",
                kind: "terminal",
                projectPathKey: "/web/project",
                createdAt: 3,
              },
            },
            openVersion: 2,
            stateVersion: 2,
          },
          "/shared/project": {
            activeTabId: RIGHT_DOCK_TAB_IDS.fileTree,
            tabOrder: [RIGHT_DOCK_TAB_IDS.fileTree],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.fileTree]: {
                id: RIGHT_DOCK_TAB_IDS.fileTree,
                kind: "fileTree",
                projectPathKey: "/shared/project",
                createdAt: 4,
                uiState: {
                  query: "web",
                  selectedPath: "web.ts",
                  expandedPaths: ["", "packages"],
                  revision: 2,
                  stateVersion: 2,
                },
              },
            },
            openVersion: 5,
            stateVersion: 2,
          },
        },
      },
    },
  });

  const payload = sync.buildGatewaySettingsSyncPayload(incoming);
  const synced = sync.applyGatewaySettingsSyncPayload(current, payload);

  assert.equal(synced.customSettings.rightDock.width, 612);
  assert.deepEqual(Object.keys(synced.customSettings.rightDock.projects).sort(), [
    "/desktop/project",
    "/shared/project",
    "/web/project",
  ]);
  assert.deepEqual(
    settings.getRightDockFileTreeState(synced.customSettings, "/shared/project"),
    {
      query: "desktop",
      selectedPath: "desktop.ts",
      expandedPaths: ["", "src"],
      showHidden: true,
      revision: 1,
    },
  );
  assert.equal(synced.customSettings.rightDock.projects["/shared/project"].openVersion, 5);
  assert.equal(synced.customSettings.rightDock.projects["/shared/project"].stateVersion, 3);
});

test("gateway settings sync uses right dock tombstones for deleted projects", () => {
  const deletedProjectLocal = settings.removeRightDockProjectState(
    settings.normalizeSettings({
      customSettings: {
        rightDock: {
          projects: {
            "/workspace/deleted": {
              activeTabId: RIGHT_DOCK_TAB_IDS.tunnel,
              tabOrder: [RIGHT_DOCK_TAB_IDS.tunnel],
              tabs: {
                [RIGHT_DOCK_TAB_IDS.tunnel]: {
                  id: RIGHT_DOCK_TAB_IDS.tunnel,
                  kind: "tunnel",
                  projectPathKey: "/workspace/deleted",
                  createdAt: 1,
                },
              },
              openVersion: 4,
              stateVersion: 4,
            },
          },
        },
      },
    }),
    "/workspace/deleted",
  );

  const staleSynced = sync.applyGatewaySettingsSyncPayload(deletedProjectLocal, {
    customSettings: {
      rightDock: {
        projects: {
          "/workspace/deleted": {
            activeTabId: RIGHT_DOCK_TAB_IDS.tunnel,
            tabOrder: [RIGHT_DOCK_TAB_IDS.tunnel],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.tunnel]: {
                id: RIGHT_DOCK_TAB_IDS.tunnel,
                kind: "tunnel",
                projectPathKey: "/workspace/deleted",
                createdAt: 1,
              },
            },
            openVersion: 4,
            stateVersion: 4,
          },
        },
      },
    },
  });

  const tombstone = staleSynced.customSettings.rightDock.projects["/workspace/deleted"];
  assert.deepEqual(tombstone.tabOrder, []);
  assert.deepEqual(tombstone.tools, {});
  assert.equal(tombstone.activeTabId, undefined);
  assert.equal(tombstone.openVersion, 5);
  assert.equal(tombstone.stateVersion, 5);
  assert.equal(tombstone.writerId, settings.getRightDockWriterId());
  assert.ok(tombstone.lastUsedAt > 0);

  const newerSynced = sync.applyGatewaySettingsSyncPayload(staleSynced, {
    customSettings: {
      rightDock: {
        projects: {
          "/workspace/deleted": {
            activeTabId: RIGHT_DOCK_TAB_IDS.tunnel,
            tabOrder: [RIGHT_DOCK_TAB_IDS.tunnel],
            tabs: {
              [RIGHT_DOCK_TAB_IDS.tunnel]: {
                id: RIGHT_DOCK_TAB_IDS.tunnel,
                kind: "tunnel",
                projectPathKey: "/workspace/deleted",
                createdAt: 2,
              },
            },
            openVersion: 6,
            stateVersion: 6,
          },
        },
      },
    },
  });

  assert.equal(
    newerSynced.customSettings.rightDock.projects["/workspace/deleted"].activeTabId,
    RIGHT_DOCK_TAB_IDS.tunnel,
  );
});

test("gateway settings sync keeps newer project conversation activity", () => {
  const current = settings.normalizeSettings({
    system: {
      ...settings.getDefaultSettings().system,
      workdir: "/default-workdir",
      workspaceProjects: [
        {
          id: "project-a",
          name: "Project A",
          path: "/project-a",
          kind: "folder",
          createdAt: 1,
          updatedAt: 1,
          lastConversationAt: 1_700_000_000_900,
        },
      ],
    },
  });
  const incoming = sync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: {
        ...settings.getDefaultSettings().system,
        workdir: "/default-workdir",
        workspaceProjects: [
          {
            id: "project-a",
            name: "Project A",
            path: "/project-a",
            kind: "folder",
            createdAt: 1,
            updatedAt: 1,
            lastConversationAt: 1_700_000_000_100,
          },
        ],
      },
    }),
  );

  const synced = sync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(
    synced.system.workspaceProjects.find((item) => item.id === "project-a")?.lastConversationAt,
    1_700_000_000_900,
  );
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
    customSettings: {
      conversationTitleModel: { customProviderId: "provider-1", model: "gpt-5.4" },
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
  // gateway sync 没有 model 上下文，无法按 provider 钳制，保留传入的原始合法档位。
  assert.equal(redacted.chatRuntimeControls.reasoningByProvider.gemini, "xhigh");
  assert.deepEqual(redacted.customSettings.conversationTitleModel, {
    customProviderId: "provider-1",
    model: "gpt-5.4",
  });

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

test("gateway settings sync applies redacted ssh hosts without clearing local secrets", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          password: "old-password",
          privateKey: "old-key",
          privateKeyPassphrase: "old-passphrase",
          proxy: {
            password: "old-proxy-password",
          },
        },
      ],
      projectHostAssociations: {
        "/workspace/project": ["prod"],
      },
    },
  });

  const redacted = sync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Renamed Production",
          host: "prod.internal",
          username: "ubuntu",
          authType: "privateKey",
          passwordConfigured: true,
          privateKeyConfigured: true,
          privateKeyPassphraseConfigured: true,
          proxy: {
            passwordConfigured: true,
          },
        },
      ],
      projectHostAssociations: {
        "/workspace/other": ["prod"],
      },
    },
  });
  assert.equal(redacted.ssh.hosts[0].name, "Renamed Production");
  assert.equal(redacted.ssh.hosts[0].password, "old-password");
  assert.equal(redacted.ssh.hosts[0].privateKey, "old-key");
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphrase, "old-passphrase");
  assert.equal(redacted.ssh.hosts[0].proxy.password, "old-proxy-password");
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphraseConfigured, true);
  assert.deepEqual(redacted.ssh.projectHostAssociations, {
    "/workspace/other": ["prod"],
  });

  const updated = sync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          passwordConfigured: true,
          privateKeyConfigured: true,
          privateKeyPassphraseConfigured: true,
          proxy: {
            passwordConfigured: true,
          },
        },
      ],
    },
    sshSecretUpdates: {
      prod: {
        password: "new-password",
        privateKey: "new-key",
        privateKeyPassphrase: "new-passphrase",
        proxyPassword: "new-proxy-password",
      },
    },
  });
  assert.equal(updated.ssh.hosts[0].password, "new-password");
  assert.equal(updated.ssh.hosts[0].privateKey, "new-key");
  assert.equal(updated.ssh.hosts[0].privateKeyPassphrase, "new-passphrase");
  assert.equal(updated.ssh.hosts[0].proxy.password, "new-proxy-password");
});

test("gateway settings update payload omits unchanged empty ssh hosts for non-ssh updates", () => {
  const desktop = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/workspace/project": ["prod"],
      },
    },
  });
  const staleWeb = settings.normalizeSettings({
    ssh: {
      hosts: [],
      projectHostAssociations: {},
    },
  });
  const nextWeb = settings.openRightDockSingletonTab(
    staleWeb,
    "/workspace/project",
    "sshTunnel",
  );

  const update = sync.buildGatewaySettingsSyncUpdatePayload(staleWeb, nextWeb, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.equal(Object.hasOwn(update, "customSettings"), true);

  const merged = sync.applyGatewaySettingsSyncPayload(desktop, update);
  assert.deepEqual(
    merged.ssh.hosts.map((host) => host.id),
    ["prod"],
  );
  assert.deepEqual(merged.ssh.projectHostAssociations, {
    "/workspace/project": ["prod"],
  });
  assert.equal(
    settings.isRightDockSingletonTabOpen(
      merged.customSettings,
      "/workspace/project",
      "sshTunnel",
    ),
    true,
  );
});

test("gateway settings update payload uses sshPatch when hosts are explicitly deleted", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/workspace/project": ["prod"],
      },
    },
  });
  const deleted = settings.updateSsh(current, {
    hosts: [],
    projectHostAssociations: {},
  });

  const update = sync.buildGatewaySettingsSyncUpdatePayload(current, deleted, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.deepEqual(update.sshPatch.hostChanges, [
    {
      id: "prod",
      before: {
        ...current.ssh.hosts[0],
        password: "",
        passwordConfigured: false,
        privateKey: "",
        privateKeyConfigured: false,
        privateKeyPassphrase: "",
        privateKeyPassphraseConfigured: false,
        proxy: {
          type: "socks5",
          url: "",
          port: 0,
          username: "",
          password: "",
          passwordConfigured: false,
        },
      },
      after: null,
    },
  ]);
  assert.deepEqual(update.sshPatch.projectAssociationChanges, [
    {
      pathKey: "/workspace/project",
      before: ["prod"],
      after: [],
    },
  ]);
});

test("gateway settings update payload uses sshSecretUpdates for secret-only ssh updates", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "old-password",
        },
      ],
    },
  });
  const next = settings.normalizeSettings({
    ...current,
    ssh: {
      ...current.ssh,
      hosts: [
        {
          ...current.ssh.hosts[0],
          password: "new-password",
        },
      ],
    },
  });

  const update = sync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.deepEqual(update.sshPatch, {});
  assert.deepEqual(update.sshSecretUpdates, {
    prod: {
      password: "new-password",
    },
  });

  const merged = sync.applyGatewaySettingsSyncPayload(current, update);
  assert.equal(merged.ssh.hosts[0].password, "new-password");
});

test("gateway settings update payload omits unchanged ssh secrets", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "prod-password",
        },
        {
          id: "staging",
          name: "Staging",
          host: "staging.example.com",
          username: "deploy",
          authType: "password",
          password: "staging-password",
        },
      ],
    },
  });
  const next = settings.normalizeSettings({
    ...current,
    ssh: {
      ...current.ssh,
      hosts: [
        {
          ...current.ssh.hosts[0],
          host: "prod.internal",
        },
        current.ssh.hosts[1],
      ],
    },
  });

  const update = sync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.equal(update.sshSecretUpdates, undefined);
  assert.equal(update.sshPatch.hostChanges.length, 1);
  assert.equal(update.sshPatch.hostChanges[0].id, "prod");
});

test("gateway settings update payload sends empty ssh secret updates when secrets are cleared", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "old-password",
        },
      ],
    },
  });
  const next = settings.normalizeSettings({
    ...current,
    ssh: {
      ...current.ssh,
      hosts: [
        {
          ...current.ssh.hosts[0],
          password: "",
          passwordConfigured: false,
        },
      ],
    },
  });

  const update = sync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.deepEqual(update.sshSecretUpdates, {
    prod: {
      password: "",
    },
  });

  const merged = sync.applyGatewaySettingsSyncPayload(current, update);
  assert.equal(merged.ssh.hosts[0].password, "");
  assert.equal(merged.ssh.hosts[0].passwordConfigured, false);
});

test("gateway settings update payload clears redacted configured ssh secrets", () => {
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "",
          passwordConfigured: true,
        },
      ],
    },
  });
  const next = settings.normalizeSettings({
    ...current,
    ssh: {
      ...current.ssh,
      hosts: [
        {
          ...current.ssh.hosts[0],
          passwordConfigured: false,
        },
      ],
    },
  });

  const update = sync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.deepEqual(update.sshSecretUpdates, {
    prod: {
      password: "",
    },
  });
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

test("web storage redaction clears ssh secrets but keeps configured state", () => {
  const appSettings = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "prod",
          name: "Production",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          password: "ssh-password",
          privateKey: "ssh-key",
          privateKeyPassphrase: "ssh-passphrase",
          proxy: {
            password: "proxy-password",
          },
        },
      ],
    },
  });

  const redacted = sync.redactSettingsForWebStorage(appSettings);
  assert.equal(redacted.ssh.hosts[0].password, "");
  assert.equal(redacted.ssh.hosts[0].privateKey, "");
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphrase, "");
  assert.equal(redacted.ssh.hosts[0].proxy.password, "");
  assert.equal(redacted.ssh.hosts[0].passwordConfigured, true);
  assert.equal(redacted.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(redacted.ssh.hosts[0].privateKeyPassphraseConfigured, true);
  assert.equal(redacted.ssh.hosts[0].proxy.passwordConfigured, true);
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
    gatewayPort: "0",
    token: " secret ",
    agentId: " agent-550e8400-e29b-41d4-a716-446655440000 ",
    autoReconnect: false,
    heartbeatInterval: "15.8",
    enableWebSshTerminal: true,
  });

  assert.equal(remote.gatewayUrl, "http://127.0.0.1:8787");
  assert.equal(remote.gatewayPort, 443);
  assert.equal(remote.token, "secret");
  assert.equal(remote.agentId, "agent-550e8400-e29b-41d4-a716-446655440000");
  assert.equal(remote.autoReconnect, false);
  assert.equal(remote.heartbeatInterval, 15);
  assert.equal(remote.enableWebSshTerminal, true);

  const remoteWithOversizedPort = settings.normalizeRemoteSettings({
    gatewayPort: "70000",
  });
  assert.equal(remoteWithOversizedPort.gatewayPort, 65_535);
});

test("font scale settings normalize invalid values to 1 and clamp out-of-range values", () => {
  const defaults = settings.normalizeFontScaleSettings(undefined);
  assert.deepEqual(defaults, { sidebar: 1, chat: 1, rightDock: 1 });

  const normalized = settings.normalizeFontScaleSettings({
    sidebar: "big",
    chat: 2.5,
    rightDock: 0.5,
  });
  assert.deepEqual(normalized, { sidebar: 1, chat: 1.4, rightDock: 0.8 });

  const kept = settings.normalizeFontScaleSettings({ sidebar: 0.9, chat: 1.1, rightDock: 1.2 });
  assert.deepEqual(kept, { sidebar: 0.9, chat: 1.1, rightDock: 1.2 });

  const custom = settings.normalizeCustomSettings({ fontScale: { chat: 1.2 } }, []);
  assert.deepEqual(custom.fontScale, { sidebar: 1, chat: 1.2, rightDock: 1 });
});

test("close window behavior defaults to minimize and only accepts exit", () => {
  assert.equal(settings.normalizeCloseWindowBehavior(undefined), "minimize");
  assert.equal(settings.normalizeCloseWindowBehavior("tray"), "minimize");
  assert.equal(settings.normalizeCloseWindowBehavior("exit"), "exit");
  assert.equal(settings.getDefaultSettings().closeWindowBehavior, "minimize");
  assert.equal(
    settings.normalizeSettings({ closeWindowBehavior: "exit" }).closeWindowBehavior,
    "exit",
  );
  assert.equal(
    settings.normalizeSettings({ closeWindowBehavior: "nope" }).closeWindowBehavior,
    "minimize",
  );
});

test("system proxy config normalizes defaults, ports, and password flags", () => {
  const defaults = settings.getDefaultSettings().system.systemProxy;
  assert.deepEqual(defaults, {
    enabled: false,
    type: "http",
    host: "",
    port: 0,
    username: "",
    password: "",
  });

  const missing = settings.normalizeSystemSettings({}).systemProxy;
  assert.equal(missing.enabled, false);
  assert.equal(missing.type, "http");
  assert.equal(missing.port, 0);
  assert.equal(missing.passwordConfigured, false);

  const normalized = settings.normalizeSystemProxyConfig({
    enabled: true,
    type: "socks5",
    host: " 10.0.0.1 ",
    port: 1080,
    username: " user ",
    password: "secret",
  });
  assert.deepEqual(normalized, {
    enabled: true,
    type: "socks5",
    host: "10.0.0.1",
    port: 1080,
    username: "user",
    password: "secret",
    passwordConfigured: true,
  });

  assert.equal(settings.normalizeSystemProxyConfig({ port: 0 }).port, 0);
  assert.equal(settings.normalizeSystemProxyConfig({ port: 65536 }).port, 0);
  assert.equal(settings.normalizeSystemProxyConfig({ port: "abc" }).port, 0);
  assert.equal(settings.normalizeSystemProxyConfig({ port: "8080" }).port, 8080);
  assert.equal(settings.normalizeSystemProxyConfig({ type: "https" }).type, "http");
  assert.equal(
    settings.normalizeSystemProxyConfig({ password: "", passwordConfigured: true })
      .passwordConfigured,
    true,
  );
  assert.equal(settings.isValidSystemProxyHost("proxy.local"), true);
  assert.equal(settings.isValidSystemProxyHost("127.0.0.1"), true);
  assert.equal(settings.isValidSystemProxyHost("::1"), true);
  assert.equal(settings.isValidSystemProxyHost("[::1]"), true);
  assert.equal(settings.isValidSystemProxyHost("bad host/@"), false);
  assert.equal(settings.isValidSystemProxyHost("proxy.local:7890"), false);
});

test("custom provider useSystemProxy defaults to false and keeps explicit true", () => {
  assert.equal(settings.normalizeCustomProvider({ id: "p-1" }).useSystemProxy, false);
  assert.equal(
    settings.normalizeCustomProvider({ id: "p-1", useSystemProxy: "yes" }).useSystemProxy,
    false,
  );
  assert.equal(
    settings.normalizeCustomProvider({ id: "p-1", useSystemProxy: true }).useSystemProxy,
    true,
  );
  for (const provider of settings.getBuiltinCustomProviders()) {
    assert.equal(provider.useSystemProxy, false);
  }
});

test("system proxy password is redacted for web storage and gateway sync", () => {
  const base = settings.normalizeSettings({
    system: {
      systemProxy: {
        enabled: true,
        type: "socks5",
        host: "10.0.0.1",
        port: 1080,
        username: "user",
        password: "secret",
      },
    },
  });

  const webStored = sync.redactSettingsForWebStorage(base);
  assert.equal(webStored.system.systemProxy.password, "");
  assert.equal(webStored.system.systemProxy.passwordConfigured, true);

  const payload = sync.buildGatewaySettingsSyncPayload(base);
  assert.equal(payload.system.systemProxy.password, "");
  assert.equal(payload.system.systemProxy.passwordConfigured, true);
  assert.equal(payload.systemProxyPasswordUpdate, undefined);

  const webuiPayload = sync.buildGatewaySettingsSyncPayload(base, {
    includeProviderApiKeyUpdates: true,
  });
  assert.equal(webuiPayload.system.systemProxy.password, "");
  assert.equal(webuiPayload.systemProxyPasswordUpdate, "secret");
});

test("gateway sync merge keeps system proxy password against redacted payloads", () => {
  const current = settings.normalizeSettings({
    system: {
      systemProxy: {
        enabled: true,
        type: "http",
        host: "proxy.local",
        port: 7890,
        username: "user",
        password: "secret",
      },
    },
  });

  // 脱敏 system（password 空 + passwordConfigured=true）不得冲掉本地密码。
  const redactedIncoming = sync.buildGatewaySettingsSyncPayload(current);
  const merged = sync.applyGatewaySettingsSyncPayload(current, redactedIncoming);
  assert.equal(merged.system.systemProxy.password, "secret");
  assert.equal(merged.system.systemProxy.passwordConfigured, true);

  // sidecar 回填新密码。
  const withUpdate = sync.applyGatewaySettingsSyncPayload(current, {
    ...redactedIncoming,
    systemProxyPasswordUpdate: "next-secret",
  });
  assert.equal(withUpdate.system.systemProxy.password, "next-secret");
  assert.equal(withUpdate.system.systemProxy.passwordConfigured, true);

  // passwordConfigured === false 是显式清除信号。
  const clearedIncoming = sync.buildGatewaySettingsSyncPayload(current);
  clearedIncoming.system = {
    ...clearedIncoming.system,
    systemProxy: {
      ...clearedIncoming.system.systemProxy,
      password: "",
      passwordConfigured: false,
    },
  };
  const cleared = sync.applyGatewaySettingsSyncPayload(current, clearedIncoming);
  assert.equal(cleared.system.systemProxy.password, "");
  assert.equal(cleared.system.systemProxy.passwordConfigured, false);

  // 其余 systemProxy 字段随 incoming 收敛（host/port 变化生效）。
  const hostChanged = sync.buildGatewaySettingsSyncPayload(current);
  hostChanged.system = {
    ...hostChanged.system,
    systemProxy: { ...hostChanged.system.systemProxy, host: "proxy2.local", port: 1080 },
  };
  const mergedHost = sync.applyGatewaySettingsSyncPayload(current, hostChanged);
  assert.equal(mergedHost.system.systemProxy.host, "proxy2.local");
  assert.equal(mergedHost.system.systemProxy.port, 1080);
  assert.equal(mergedHost.system.systemProxy.password, "secret");
});

test("xai provider model defaults come from the generated model catalog", () => {
  assert.equal(settings.getProviderModelDefaults("xai", "grok-4.5").contextWindow, 500_000);
  // 上游（models.dev）已下架的旧模型与目录未收录的模型一样吃供应商兜底值。
  assert.equal(settings.getProviderModelDefaults("xai", "grok-3").contextWindow, 258_000);
  assert.equal(settings.getProviderModelDefaults("xai", "grok-unknown").contextWindow, 258_000);
});

test("gateway sync keeps all desktop font families local", () => {
  const current = settings.normalizeSettings({
    customSettings: {
      interfaceFontFamily: "Inter",
      chatFontFamily: "Charter",
      codeFontFamily: "Menlo",
    },
  });
  const incoming = sync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      customSettings: {
        interfaceFontFamily: "Arial",
        chatFontFamily: "Georgia",
        codeFontFamily: "Monaco",
      },
    }),
  );

  assert.equal(incoming.customSettings.interfaceFontFamily, "");
  assert.equal(incoming.customSettings.chatFontFamily, "");
  assert.equal(incoming.customSettings.codeFontFamily, "");
  const merged = sync.applyGatewaySettingsSyncPayload(current, incoming).customSettings;
  assert.equal(merged.interfaceFontFamily, "Inter");
  assert.equal(merged.chatFontFamily, "Charter");
  assert.equal(merged.codeFontFamily, "Menlo");
});

test("degenerate catalog limits (output == context window) are clamped in the snapshot", () => {
  // 社区目录对不公布输出上限的供应商记"输出=窗口"（grok-4.5 上游 500K/500K），
  // 照单全收会把压缩阈值挤到下限。生成期统一钳到 min(32K, 窗口/4)。
  const grok45 = settings.getProviderModelDefaults("xai", "grok-4.5");
  assert.equal(grok45.contextWindow, 500_000);
  assert.equal(grok45.maxOutputToken, 32_000);
  const grokBuild = settings.getProviderModelDefaults("xai", "grok-build-0.1");
  assert.equal(grokBuild.contextWindow, 256_000);
  assert.equal(grokBuild.maxOutputToken, 32_000);
  // 非退化条目原样透传（grok-4.3 = 1M/30K）。
  const grok43 = settings.getProviderModelDefaults("xai", "grok-4.3");
  assert.equal(grok43.contextWindow, 1_000_000);
  assert.equal(grok43.maxOutputToken, 30_000);
});

test("persisted degenerate limits are repaired at normalize time for every provider", () => {
  // 坏目录数据落库期间加入的模型：读侧修复，不需要用户重新添加。
  const repaired = settings.normalizeProviderModelConfig(
    { id: "grok-4.5", contextWindow: 500_000, maxOutputToken: 500_000 },
    "xai",
  );
  assert.equal(repaired.contextWindow, 500_000);
  assert.equal(repaired.maxOutputToken, 32_000);
  // 用户显式配置的合法输出上限保持不动。
  const custom = settings.normalizeProviderModelConfig(
    { id: "grok-4.5", contextWindow: 500_000, maxOutputToken: 64_000 },
    "xai",
  );
  assert.equal(custom.maxOutputToken, 64_000);
  // 小窗口退化条目按窗口 1/4 保底留输入预算。
  const tiny = settings.normalizeProviderModelConfig(
    { id: "relay-grok", contextWindow: 8_192, maxOutputToken: 8_192 },
    "xai",
  );
  assert.equal(tiny.contextWindow, 8_192);
  assert.equal(tiny.maxOutputToken, 2_048);
  // 修复规则对所有供应商统一生效（不是 xai 特例）。
  const codex = settings.normalizeProviderModelConfig(
    { id: "custom-model", contextWindow: 128_000, maxOutputToken: 128_000 },
    "codex",
  );
  assert.equal(codex.maxOutputToken, 32_000);
});
