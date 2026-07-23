import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const webSettings = loader.loadModule("src/lib/webSettings.ts");
const settings = loader.loadModule("@/lib/settings/index.ts");
const settingsSync = loader.loadModule("@/lib/settings/sync.ts");
const chatHelpers = loader.loadModule("@/lib/chat/chatPageHelpers.ts");
const adminApi = loader.loadModule("@/lib/adminApi.ts");
const RIGHT_DOCK_TAB_IDS = settings.RIGHT_DOCK_SINGLETON_TAB_IDS;

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

test("gateway model picker keeps same-name provider instances in separate groups", () => {
  const modelOptions = chatHelpers.buildModelOptions({
    customProviders: [
      {
        id: "same-api-a",
        name: "Shared",
        type: "codex",
        activeModels: ["shared-model", "model-a"],
      },
      { id: "same-api-b", name: "Shared", type: "codex", activeModels: ["shared-model"] },
      { id: "different-api", name: "Shared", type: "claude_code", activeModels: ["model-c"] },
    ],
    selectedModel: { customProviderId: "same-api-b", model: "shared-model" },
  });

  const groups = chatHelpers.groupModelOptionsByProvider(modelOptions);

  assert.deepEqual(
    groups.map((group) => ({
      id: group.id,
      name: group.name,
      type: group.providerType,
      options: group.opts.map((option) => ({ value: option.value, model: option.model })),
    })),
    [
      {
        id: "same-api-b",
        name: "Shared",
        type: "codex",
        options: [{ value: "same-api-b::shared-model", model: "shared-model" }],
      },
      {
        id: "same-api-a",
        name: "Shared",
        type: "codex",
        options: [
          { value: "same-api-a::shared-model", model: "shared-model" },
          { value: "same-api-a::model-a", model: "model-a" },
        ],
      },
      {
        id: "different-api",
        name: "Shared",
        type: "claude_code",
        options: [{ value: "different-api::model-c", model: "model-c" }],
      },
    ],
  );
});

function installWindow(origin = "https://gateway.example") {
  const store = new Map();
  globalThis.window = {
    location: { origin },
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
  };
  return store;
}

test("agent directory requests database-paged status filters", async () => {
  installWindow("https://gateway.example");
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let authorization;
  globalThis.fetch = async (input, init) => {
    requestUrl = new URL(String(input));
    authorization = init?.headers?.Authorization;
    return new Response(
      JSON.stringify({
        agents: [
          {
            agent_id: "shared-token-agent",
            name: "",
            online: false,
            has_token: false,
            registered_at: "2026-07-22T00:00:00Z",
          },
        ],
        page: 3,
        page_size: 50,
        total: 1,
        has_more: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await adminApi.listAdminAgents(" gateway-token ", 3, 50, "offline");
    assert.equal(requestUrl.pathname, "/api/agents");
    assert.equal(requestUrl.searchParams.get("page"), "3");
    assert.equal(requestUrl.searchParams.get("page_size"), "50");
    assert.equal(requestUrl.searchParams.get("status"), "offline");
    assert.equal(authorization, "Bearer gateway-token");
    assert.equal(result.page, 3);
    assert.equal(result.agents[0].has_token, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent management validates generated IDs and uses the single-record API", async () => {
  installWindow("https://gateway.example");
  const agentId = "agent-550e8400-e29b-41d4-a716-446655440000";
  assert.equal(adminApi.isGeneratedAgentID(` ${agentId} `), true);
  assert.equal(adminApi.isGeneratedAgentID("agent-550e8400-e29b-11d4-a716-446655440000"), false);
  assert.equal(adminApi.isGeneratedAgentID("agent-550E8400-E29B-41D4-A716-446655440000"), false);
  assert.equal(adminApi.isGeneratedAgentID("manual-agent"), false);

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: new URL(String(input)), init });
    if (init.method === "POST") {
      return new Response(JSON.stringify({ token: "agt_plaintext" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const issued = await adminApi.issueAdminToken(" gateway-token ", agentId, "  办公室电脑  ");
    await adminApi.updateAdminAgentName("gateway-token", agentId, "   ");
    await adminApi.deleteAdminAgent("gateway-token", agentId);

    assert.equal(issued, "agt_plaintext");
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url.pathname, `/api/agents/${agentId}/token`);
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.Authorization, "Bearer gateway-token");
    assert.equal(requests[0].init.headers["Content-Type"], "application/json");
    assert.equal(requests[0].init.body, JSON.stringify({ name: "办公室电脑" }));
    assert.equal(requests[1].url.pathname, `/api/agents/${agentId}`);
    assert.equal(requests[1].init.method, "PATCH");
    assert.equal(requests[1].init.body, JSON.stringify({ name: "" }));
    assert.equal(requests[2].url.pathname, `/api/agents/${agentId}`);
    assert.equal(requests[2].init.method, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getWebDefaultSettings enables remote settings from the gateway token", () => {
  installWindow("https://gateway.example");

  const settings = webSettings.getWebDefaultSettings(" token ");
  assert.equal(settings.system.executionMode, "tools");
  assert.equal(settings.system.workdir, "");
  assert.equal(settings.remote.enabled, true);
  assert.equal(settings.remote.gatewayUrl, "https://gateway.example");
  assert.equal(settings.remote.token, "token");
});

test("web settings normalization canonicalizes project keyed maps with Windows path compatibility", () => {
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

test("web chat runtime controls default and follow model-aware reasoning support", () => {
  installWindow("https://gateway.example");

  const defaults = webSettings.getWebDefaultSettings(" token ");
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

  assert.deepEqual(settings.getChatRuntimeReasoningLevelsForProvider({}), []);
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-opus-4-8",
    }),
    ["minimal", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-sonnet-4-6",
    }),
    ["minimal", "low", "medium", "high", "max"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-responses",
      modelId: "gpt-5.2",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-completions",
      modelId: "gpt-5",
    }),
    ["minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "gemini",
      modelId: "gemini-2.5-pro",
    }),
    ["minimal", "low", "medium", "high"],
  );
  // 目录之外的自定义模型（deepseek/glm 等）按可推理处理，与桌面端一致：
  // 标准四档；deepseek 走 codex 时镜像桌面端适配层的 xhigh 档。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      requestFormat: "openai-completions",
      modelId: "glm-4.7",
    }),
    ["minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "deepseek-reasoner",
    }),
    ["minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "codex",
      modelId: "deepseek-chat",
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );

  assert.equal(settings.isThinkingAlwaysOnForModel("claude_code", "claude-fable-5"), true);
  assert.equal(settings.isThinkingAlwaysOnForModel("claude_code", "claude-opus-4-8"), false);
  assert.equal(settings.isThinkingAlwaysOnForModel("claude_code", undefined), false);

  // 中转装饰过的 Anthropic id（日期后缀/大小写/@版本）按规范化后的目录条目解析，
  // xhigh/max 档位与"思考不可关"语义不丢失；与桌面端 modelFactory 同步。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-opus-4-8-20260213",
    }),
    ["minimal", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-sonnet-4-6-20251114",
    }),
    ["minimal", "low", "medium", "high", "max"],
  );
  assert.equal(settings.isThinkingAlwaysOnForModel("claude_code", "Claude-Fable-5"), true);
  // 目录彻底未命中的三方改名 id 走 id 启发式补 xhigh/max。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-4.6-sonnet",
    }),
    ["minimal", "low", "medium", "high", "max"],
  );
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-5-sonnet",
    }),
    ["minimal", "low", "medium", "high", "xhigh", "max"],
  );
  // 旧世代 id 不误判。
  assert.deepEqual(
    settings.getChatRuntimeReasoningLevelsForProvider({
      providerId: "claude_code",
      modelId: "claude-3-5-sonnet-20241022",
    }),
    ["minimal", "low", "medium", "high"],
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
      { providerId: "gemini", modelId: "gemini-2.5-pro" },
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
      { providerId: "codex", requestFormat: "openai-completions", modelId: "gpt-5.2" },
    ),
    {
      thinkingEnabled: true,
      nativeWebSearchEnabled: true,
      reasoning: "xhigh",
      reasoningByProvider: {
        claude_code: "xhigh",
        codex_openai_responses: "xhigh",
        codex_openai_completions: "xhigh",
        gemini: "xhigh",
      },
    },
  );

  assert.deepEqual(
    settings.updateChatRuntimeControlsForProvider(
      defaults.chatRuntimeControls,
      { reasoning: "xhigh" },
      { providerId: "codex", requestFormat: "openai-responses", modelId: "gpt-5.2" },
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
      { providerId: "claude_code", modelId: "claude-opus-4-8" },
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
      { providerId: "gemini", modelId: "gemini-2.5-pro" },
    ).reasoning,
    "low",
  );
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(defaults.chatRuntimeControls, {
      providerId: "claude_code",
      modelId: "not-a-real-model",
    }).reasoning,
    "high",
  );
});

test("Anthropic settings keep 1M context parity for adaptive and explicit relay suffix models", () => {
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-6").contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-5").contextWindow,
    200_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-5[1m]").contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-4.6-sonnet").contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.findProviderModelConfig(
      { models: [], type: "claude_code", baseUrl: "https://relay.example.com/v1" },
      "claude-sonnet-4-5[1m]",
    ).contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.findProviderModelConfig(
      { models: [], type: "claude_code", baseUrl: "https://api.anthropic.com/v1" },
      "claude-sonnet-4-5[1m]",
    ).contextWindow,
    200_000,
  );
});

test("loadWebSettings forces current gateway URL/token over stale persisted remote settings", () => {
  const store = installWindow("https://new.example");
  const stale = webSettings.getWebDefaultSettings("old-token");
  stale.remote.gatewayUrl = "https://old.example";
  stale.remote.token = "old-token";
  stale.system.workdir = "/workspace";
  stale.customSettings.rightDock = {
    width: 612,
    projects: {
      "/stale/project": {
        activeTabId: RIGHT_DOCK_TAB_IDS.fileTree,
        tabOrder: [RIGHT_DOCK_TAB_IDS.fileTree],
        tabs: {
          [RIGHT_DOCK_TAB_IDS.fileTree]: {
            id: RIGHT_DOCK_TAB_IDS.fileTree,
            kind: "fileTree",
            projectPathKey: "/stale/project",
            createdAt: 1,
          },
        },
        openVersion: 1,
        stateVersion: 1,
      },
    },
  };
  store.set("liveagent.gateway.webui.settings.v1", JSON.stringify(stale));

  const loaded = webSettings.loadWebSettings(" new-token ");
  assert.equal(loaded.system.workdir, "/workspace");
  assert.equal(loaded.remote.gatewayUrl, "https://new.example");
  assert.equal(loaded.remote.token, "new-token");
  assert.equal(loaded.remote.enabled, true);
  assert.equal(loaded.customSettings.rightDock.width, 612);
  assert.deepEqual(Object.keys(loaded.customSettings.rightDock.projects), ["/stale/project"]);
});

test("gateway settings sync keeps remote connection local and syncs web terminal setting", () => {
  installWindow();
  const current = webSettings.getWebDefaultSettings("token");
  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, {
    system: {
      executionMode: "tools",
      workdir: "/remote-workdir",
      selectedSystemTools: ["http_get_test"],
    },
    chatRuntimeControls: {
      thinkingEnabled: false,
      nativeWebSearchEnabled: false,
      reasoning: "minimal",
      reasoningByProvider: {
        claude_code: "minimal",
        codex_openai_responses: "minimal",
        codex_openai_completions: "high",
        gemini: "xhigh",
      },
    },
    selectedModel: null,
  });

  assert.equal(synced.system.executionMode, "tools");
  assert.equal(synced.system.workdir, "/remote-workdir");
  assert.deepEqual(synced.system.selectedSystemTools, ["http_get_test"]);
  assert.equal(synced.chatRuntimeControls.thinkingEnabled, false);
  assert.equal(synced.chatRuntimeControls.nativeWebSearchEnabled, false);
  assert.equal(synced.chatRuntimeControls.reasoning, "minimal");
  assert.equal(synced.chatRuntimeControls.reasoningByProvider.claude_code, "minimal");
  assert.equal(synced.chatRuntimeControls.reasoningByProvider.codex_openai_responses, "minimal");
  assert.equal(synced.chatRuntimeControls.reasoningByProvider.gemini, "xhigh");
  assert.equal(synced.selectedModel, undefined);
  assert.equal(synced.remote.gatewayUrl, "https://gateway.example");
  assert.equal(synced.remote.token, "token");

  const payload = settingsSync.buildGatewaySettingsSyncPayload(synced);
  assert.deepEqual(payload.remote, {
    enableWebTerminal: synced.remote.enableWebTerminal,
    enableWebSshTerminal: synced.remote.enableWebSshTerminal,
    enableWebGit: synced.remote.enableWebGit,
    enableWebTunnels: synced.remote.enableWebTunnels,
  });
  assert.deepEqual(payload.chatRuntimeControls, synced.chatRuntimeControls);
});

test("ssh settings sync redacts stored secrets and carries one-shot secret updates", () => {
  installWindow();
  const source = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          description: "Production jump host",
          host: "prod.example.com",
          port: 2222,
          username: "deploy",
          authType: "privateKey",
          password: "ssh-password",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
          privateKeyPath: "~/.ssh/prod",
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
        "/project-a": ["ssh-prod", "missing-host", "ssh-prod"],
        "   ": ["ssh-prod"],
      },
    },
  });
  assert.deepEqual(source.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });

  const redacted = settingsSync.redactSettingsForWebStorage(source);
  assert.deepEqual(redacted.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(redacted.ssh.hosts[0].password, "");
  assert.equal(redacted.ssh.hosts[0].privateKey, "");
  assert.equal(redacted.ssh.hosts[0].proxy.type, "http");
  assert.equal(redacted.ssh.hosts[0].proxy.password, "");
  assert.equal(redacted.ssh.hosts[0].passwordConfigured, true);
  assert.equal(redacted.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(redacted.ssh.hosts[0].proxy.passwordConfigured, true);

  const publicPayload = settingsSync.buildGatewaySettingsSyncPayload(source);
  assert.deepEqual(publicPayload.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(publicPayload.ssh.hosts[0].password, "");
  assert.equal(publicPayload.ssh.hosts[0].privateKey, "");
  assert.equal(publicPayload.ssh.hosts[0].proxy.type, "http");
  assert.equal(publicPayload.ssh.hosts[0].proxy.password, "");
  assert.equal(publicPayload.ssh.hosts[0].passwordConfigured, true);
  assert.equal(publicPayload.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(publicPayload.ssh.hosts[0].proxy.passwordConfigured, true);
  assert.equal(Object.hasOwn(publicPayload, "sshSecretUpdates"), false);

  const privatePayload = settingsSync.buildGatewaySettingsSyncPayload(source, {
    includeProviderApiKeyUpdates: true,
  });
  assert.deepEqual(privatePayload.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(privatePayload.ssh.hosts[0].password, "");
  assert.equal(privatePayload.ssh.hosts[0].privateKey, "");
  assert.equal(privatePayload.ssh.hosts[0].proxy.type, "http");
  assert.equal(privatePayload.ssh.hosts[0].proxy.password, "");
  assert.deepEqual(privatePayload.sshSecretUpdates, {
    "ssh-prod": {
      password: "ssh-password",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      proxyPassword: "proxy-password",
    },
  });
});

test("ssh keyboard-interactive hosts normalize without credential secrets or secret updates", () => {
  installWindow();
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

  const payload = settingsSync.buildGatewaySettingsSyncPayload(appSettings, {
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
  installWindow();
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

test("ssh settings sync merges one-shot secret updates into existing hosts", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "old-password",
          privateKey: "old-key",
          proxy: {
            type: "socks5",
            url: "socks5://127.0.0.1",
            port: 1080,
            username: "proxy-user",
            password: "old-proxy-password",
          },
        },
      ],
    },
  });

  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "privateKey",
          password: "",
          passwordConfigured: true,
          privateKey: "",
          privateKeyPath: "~/.ssh/prod",
          privateKeyConfigured: true,
          proxy: {
            type: "http",
            url: "http://127.0.0.1",
            port: 1080,
            username: "proxy-user",
            password: "",
            passwordConfigured: true,
          },
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
    sshSecretUpdates: {
      "ssh-prod": {
        password: "new-password",
        privateKey: "new-key",
        proxyPassword: "new-proxy-password",
      },
    },
  });

  assert.equal(synced.ssh.hosts[0].authType, "privateKey");
  assert.equal(synced.ssh.hosts[0].password, "new-password");
  assert.equal(synced.ssh.hosts[0].privateKey, "new-key");
  assert.equal(synced.ssh.hosts[0].proxy.type, "http");
  assert.equal(synced.ssh.hosts[0].proxy.password, "new-proxy-password");
  assert.equal(synced.ssh.hosts[0].passwordConfigured, true);
  assert.equal(synced.ssh.hosts[0].privateKeyConfigured, true);
  assert.equal(synced.ssh.hosts[0].proxy.passwordConfigured, true);
  assert.deepEqual(synced.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
});

test("ssh settings sync preserves project host associations when older payload omits them", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
  });

  const preserved = settingsSync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
    },
  });
  assert.deepEqual(preserved.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });

  const cleared = settingsSync.applyGatewaySettingsSyncPayload(current, {
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {},
    },
  });
  assert.deepEqual(cleared.ssh.projectHostAssociations, {});
});

test("settings update payload omits unchanged empty ssh hosts for non-ssh updates", () => {
  installWindow();
  const desktop = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
  });
  const staleWeb = settings.normalizeSettings({
    ssh: {
      hosts: [],
      projectHostAssociations: {},
    },
  });
  const nextWeb = settings.openRightDockSingletonTab(staleWeb, "/project-a", "sshTunnel");

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(staleWeb, nextWeb, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.equal(Object.hasOwn(update, "customSettings"), true);

  const merged = settingsSync.applyGatewaySettingsSyncPayload(desktop, update);
  assert.deepEqual(
    merged.ssh.hosts.map((host) => host.id),
    ["ssh-prod"],
  );
  assert.deepEqual(merged.ssh.projectHostAssociations, {
    "/project-a": ["ssh-prod"],
  });
  assert.equal(
    settings.isRightDockSingletonTabOpen(merged.customSettings, "/project-a", "sshTunnel"),
    true,
  );
});

test("settings update payload uses sshPatch when hosts are explicitly deleted", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
        },
      ],
      projectHostAssociations: {
        "/project-a": ["ssh-prod"],
      },
    },
  });
  const deleted = settings.updateSsh(current, {
    hosts: [],
    projectHostAssociations: {},
  });

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(current, deleted, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.deepEqual(update.sshPatch.hostChanges, [
    {
      id: "ssh-prod",
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
      pathKey: "/project-a",
      before: ["ssh-prod"],
      after: [],
    },
  ]);
});

test("settings update payload uses sshSecretUpdates for secret-only ssh updates", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
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

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.deepEqual(update.sshPatch, {});
  assert.deepEqual(update.sshSecretUpdates, {
    "ssh-prod": {
      password: "new-password",
    },
  });

  const merged = settingsSync.applyGatewaySettingsSyncPayload(current, update);
  assert.equal(merged.ssh.hosts[0].password, "new-password");
});

test("settings update payload omits unchanged ssh secrets", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
          host: "prod.example.com",
          username: "deploy",
          authType: "password",
          password: "prod-password",
        },
        {
          id: "ssh-staging",
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

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.equal(update.sshSecretUpdates, undefined);
  assert.equal(update.sshPatch.hostChanges.length, 1);
  assert.equal(update.sshPatch.hostChanges[0].id, "ssh-prod");
});

test("settings update payload sends empty ssh secret updates when secrets are cleared", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
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

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.equal(Object.hasOwn(update, "ssh"), false);
  assert.deepEqual(update.sshSecretUpdates, {
    "ssh-prod": {
      password: "",
    },
  });

  const merged = settingsSync.applyGatewaySettingsSyncPayload(current, update);
  assert.equal(merged.ssh.hosts[0].password, "");
  assert.equal(merged.ssh.hosts[0].passwordConfigured, false);
});

test("settings update payload clears redacted configured ssh secrets", () => {
  installWindow();
  const current = settings.normalizeSettings({
    ssh: {
      hosts: [
        {
          id: "ssh-prod",
          name: "Prod",
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

  const update = settingsSync.buildGatewaySettingsSyncUpdatePayload(current, next, {
    includeProviderApiKeyUpdates: true,
  });

  assert.deepEqual(update.sshSecretUpdates, {
    "ssh-prod": {
      password: "",
    },
  });
});

test("workspace project selection stays out of synced system workdir", () => {
  installWindow();
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

  const payload = settingsSync.buildGatewaySettingsSyncPayload(
    settings.normalizeSettings({
      system: resolvedSystem,
    }),
  );
  assert.equal(Object.hasOwn(payload.system, "activeWorkspaceProjectId"), false);
  assert.equal(payload.system.workdir, "/default-workdir");
});

test("gateway settings sync preserves active workspace project by path when ids differ", () => {
  installWindow();
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
  const incoming = settingsSync.buildGatewaySettingsSyncPayload(
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

  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(synced.system.activeWorkspaceProjectId, "desktop-project-a");
});

test("gateway settings sync keeps right dock width local and syncs project state", () => {
  installWindow();
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

  const payload = settingsSync.buildGatewaySettingsSyncPayload(incoming);
  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, payload);

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

test("gateway settings sync keeps newer project conversation activity", () => {
  installWindow();
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
  const incoming = settingsSync.buildGatewaySettingsSyncPayload(
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

  const synced = settingsSync.applyGatewaySettingsSyncPayload(current, incoming);

  assert.equal(
    synced.system.workspaceProjects.find((item) => item.id === "project-a")?.lastConversationAt,
    1_700_000_000_900,
  );
});

test("web remote settings normalize single-slash http gateway URLs", () => {
  const remote = settings.normalizeRemoteSettings({
    enabled: true,
    gatewayUrl: " https:/gateway.example/ ",
    token: " token ",
  });

  assert.equal(remote.gatewayUrl, "https://gateway.example");
  assert.equal(remote.token, "token");

  const remoteWithOversizedPort = settings.normalizeRemoteSettings({
    gatewayPort: "70000",
  });
  assert.equal(remoteWithOversizedPort.gatewayPort, 65_535);
});

test("web provider normalization keeps native web search toggle", () => {
  const enabledByDefault = settings.normalizeCustomProvider({
    id: "provider-enabled",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(enabledByDefault.nativeWebSearchEnabled, true);

  const disabled = settings.normalizeCustomProvider({
    id: "provider-disabled",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    nativeWebSearchEnabled: false,
  });
  assert.equal(disabled.nativeWebSearchEnabled, false);
});

test("web right dock normalize keeps unknown session ids and unresolved active tab", () => {
  const project = settings.normalizeRightDockProjectState({
    activeTabId: "sess-active",
    tabOrder: ["sess-a", RIGHT_DOCK_TAB_IDS.gitReview, "sess-b"],
    tools: { gitReview: { openedAt: 4 } },
    openVersion: 1,
    stateVersion: 2,
    writerId: "peer",
    lastUsedAt: 9,
  });
  assert.deepEqual(project.tabOrder, ["sess-a", RIGHT_DOCK_TAB_IDS.gitReview, "sess-b"]);
  assert.equal(project.activeTabId, "sess-active");
  assert.deepEqual(Object.keys(project.tools), ["gitReview"]);
});

test("web right dock merge converges symmetrically on writerId ties", () => {
  const bucket = (writerId, activeTabId) => ({
    activeTabId,
    tabOrder: [activeTabId],
    tools: { gitReview: { openedAt: 1 } },
    openVersion: 1,
    stateVersion: 3,
    writerId,
    lastUsedAt: 100,
  });
  const stateA = settings.normalizeSettings({
    customSettings: { rightDock: { projects: { "/w/app": bucket("bbb", RIGHT_DOCK_TAB_IDS.gitReview) } } },
  });
  const stateB = settings.normalizeSettings({
    customSettings: { rightDock: { projects: { "/w/app": bucket("aaa", "sess-2") } } },
  });
  const aGotB = settingsSync.applyGatewaySettingsSyncPayload(stateA, {
    customSettings: { rightDock: stateB.customSettings.rightDock },
  });
  const bGotA = settingsSync.applyGatewaySettingsSyncPayload(stateB, {
    customSettings: { rightDock: stateA.customSettings.rightDock },
  });
  const mergedA = aGotB.customSettings.rightDock.projects["/w/app"];
  const mergedB = bGotA.customSettings.rightDock.projects["/w/app"];
  assert.equal(mergedA.activeTabId, RIGHT_DOCK_TAB_IDS.gitReview);
  assert.deepEqual(mergedA, mergedB);
  assert.equal(mergedA.stateVersion, 3);
  assert.equal(mergedA.lastUsedAt, 100);
});

test("web right dock buckets are kept by recency and tombstones expire", () => {
  const now = Date.now();
  const projects = {};
  for (let index = 0; index <= 100; index += 1) {
    projects[`/p/n${String(index).padStart(3, "0")}`] = {
      tabOrder: [],
      tools: { gitReview: { openedAt: 1 } },
      openVersion: 1,
      stateVersion: 1,
      writerId: "w",
      lastUsedAt: now - index * 1000,
    };
  }
  const capped = settings.normalizeRightDockSettings({ projects });
  assert.equal(Object.keys(capped.projects).length, 100);
  assert.equal(capped.projects["/p/n100"], undefined);
  assert.ok(capped.projects["/p/n000"]);

  const tombstones = settings.normalizeRightDockSettings({
    projects: {
      "/t/expired": { tools: {}, openVersion: 1, stateVersion: 2, lastUsedAt: now - 91 * 24 * 3600 * 1000 },
      "/t/fresh": { tools: {}, openVersion: 1, stateVersion: 2, lastUsedAt: now - 1000 },
      "/t/legacy": { tools: {}, openVersion: 1, stateVersion: 2 },
    },
  });
  assert.deepEqual(Object.keys(tombstones.projects).sort(), ["/t/fresh", "/t/legacy"]);
  assert.ok(tombstones.projects["/t/legacy"].lastUsedAt >= now - 1000);
});

test("web right dock migrates the legacy tabs shape", () => {
  const project = settings.normalizeRightDockProjectState({
    activeTabId: "sess-1",
    tabOrder: ["sess-1", RIGHT_DOCK_TAB_IDS.fileTree],
    tabs: {
      "sess-1": { id: "sess-1", kind: "terminal", projectPathKey: "/w/app", createdAt: 1 },
      [RIGHT_DOCK_TAB_IDS.fileTree]: {
        id: RIGHT_DOCK_TAB_IDS.fileTree,
        kind: "fileTree",
        projectPathKey: "/w/app",
        createdAt: 7,
        uiState: { query: "q", expandedPaths: ["", "src"] },
      },
    },
    openVersion: 2,
    stateVersion: 5,
  });
  assert.deepEqual(Object.keys(project.tools), ["fileTree"]);
  assert.equal(project.tools.fileTree.openedAt, 7);
  assert.equal(project.tools.fileTree.uiState.query, "q");
  assert.deepEqual(project.tabOrder, ["sess-1", RIGHT_DOCK_TAB_IDS.fileTree]);
  assert.equal(project.activeTabId, "sess-1");
});
