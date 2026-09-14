import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// 聊天运行时消费路由结果（docs/design/provider-registry-and-model-routing.md
// 第 2 / 4 节）：ProviderRuntimeConfig 由 resolveProviderChatRoute 填充；请求头按
// 协议头档 → 方言头档 → 用户头查表装配；模型工厂按 (protocol, dialect) 构造
// pi-ai Model，方言落到 Model.provider、quirks 落到 compat、远端模型名落到 Model.id。
// 旧配置（无新字段）的最终装配由 wire-payload-golden / transport-golden 锁定。
// ============================================================================

const PROXY_SERVER_INFO = { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
        throw new Error(`unexpected tauri invoke: ${command}`);
      },
    },
  },
});
const settings = loader.loadModule("src/lib/settings/index.ts");
const { createProviderRuntimeConfig } = loader.loadModule(
  "src/lib/providers/runtime/providerRuntimeConfig.ts",
);
const { buildProtocolRequestHeaders, prepareProviderRequest } = loader.loadModule(
  "src/lib/providers/runtime/requestOptions.ts",
);
const { createModelFromConfig, createModelFromRoute, createModelFromRuntime } =
  loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const { failoverBreakerKey } = loader.loadModule(
  "src/lib/providers/runtime/providerFailover.ts",
);
const { resolveRuntimeWireRoute } = loader.loadModule("src/lib/providers/runtime/wireRoute.ts");

function decodeOverrides(headers) {
  const encoded = headers["x-liveagent-upstream-headers"];
  return encoded === undefined
    ? undefined
    : JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

/** 多 Key、多渠道、模型级覆盖齐全的网关供应商。 */
function buildGatewayProvider(overrides = {}) {
  return settings.normalizeCustomProvider({
    id: "gateway",
    name: "Gateway",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    apiKey: "key-main",
    customHeaders: [
      { key: "X-Provider", value: "provider" },
      { key: "X-Shared", value: "provider" },
    ],
    credentials: [
      { id: "k1", label: "main", apiKey: "key-main", enabled: true },
      {
        id: "k2",
        label: "backup",
        apiKey: "key-backup",
        enabled: true,
        modelScope: { mode: "manual", models: ["gpt-*"] },
      },
    ],
    endpointConfigs: {
      "openai-completions": {
        baseUrl: "https://relay.example/compat/v1",
        headers: [
          { key: "X-Endpoint", value: "endpoint" },
          { key: "x-shared", value: "endpoint" },
        ],
        quirks: { supportsReasoningEffort: false, supportsUsageInStreaming: false },
        auth: { headerName: "X-Auth", prefix: "Token " },
      },
    },
    models: [
      {
        id: "gpt-5.2",
        wireModelId: "openai/gpt-5.2",
        chatProtocols: ["openai-completions", "openai-responses"],
        credentialId: "k2",
        reasoning: "low",
        nativeWebSearch: false,
      },
    ],
    activeModels: ["gpt-5.2"],
    ...overrides,
  });
}

test("createProviderRuntimeConfig carries the resolved route: protocol, dialect, family, wire id, credential, merged headers, quirks, auth", () => {
  const runtime = createProviderRuntimeConfig(
    buildGatewayProvider(),
    "gpt-5.2",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );

  assert.equal(runtime.protocol, "openai-completions");
  assert.equal(runtime.chatProtocol, runtime.protocol);
  assert.equal(runtime.dialect, "openai");
  assert.equal(runtime.family, "openai");
  assert.equal(runtime.adapterProviderId, "codex");
  assert.equal(runtime.baseUrl, "https://relay.example/compat/v1");
  assert.equal(runtime.modelId, "gpt-5.2");
  assert.equal(runtime.wireModelId, "openai/gpt-5.2");
  // 模型指定凭据：apiKey 取该凭据的值，而不是供应商默认 Key。
  assert.equal(runtime.credentialId, "k2");
  assert.equal(runtime.apiKey, "key-backup");
  // 用户头 = 供应商级 + 端点级合并（端点覆盖同名，大小写不敏感）。
  assert.deepEqual(runtime.customHeaders, [
    { key: "X-Provider", value: "provider" },
    { key: "X-Endpoint", value: "endpoint" },
    { key: "x-shared", value: "endpoint" },
  ]);
  assert.deepEqual(runtime.endpointHeaders, [
    { key: "X-Endpoint", value: "endpoint" },
    { key: "x-shared", value: "endpoint" },
  ]);
  assert.deepEqual(runtime.quirks, {
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
  });
  assert.deepEqual(runtime.authOverride, { headerName: "X-Auth", prefix: "Token " });
});

test("createProviderRuntimeConfig honours failover overrides for credential and protocol", () => {
  const provider = buildGatewayProvider();
  const byCredential = createProviderRuntimeConfig(
    provider,
    "gpt-5.2",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
    { credentialId: "k1" },
  );
  assert.equal(byCredential.credentialId, "k1");
  assert.equal(byCredential.apiKey, "key-main");

  const byProtocol = createProviderRuntimeConfig(
    provider,
    "gpt-5.2",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
    { protocol: "openai-responses" },
  );
  assert.equal(byProtocol.protocol, "openai-responses");
  // Responses 没有显式端点：退回主连接，端点头 / quirks / auth 不再带入。
  assert.equal(byProtocol.baseUrl, "https://relay.example/v1");
  assert.equal(byProtocol.endpointHeaders, undefined);
  assert.equal(byProtocol.quirks, undefined);
  assert.equal(byProtocol.authOverride, undefined);
  assert.deepEqual(byProtocol.customHeaders, [
    { key: "X-Provider", value: "provider" },
    { key: "X-Shared", value: "provider" },
  ]);
});

test("model-level reasoning default overrides the conversation level and is clamped to the model's ladder", () => {
  const controls = { ...settings.DEFAULT_CHAT_RUNTIME_CONTROLS, reasoning: "high" };
  const provider = (reasoning) =>
    settings.normalizeCustomProvider({
      id: "openai",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk",
      models: [
        { id: "gpt-5.2", reasoning },
        // 目录里只有 medium 一档：模型级 high 必须钳到 medium。
        { id: "gpt-5.2-chat-latest", reasoning },
      ],
    });

  assert.equal(createProviderRuntimeConfig(provider(undefined), "gpt-5.2", controls).reasoning, "high");
  assert.equal(createProviderRuntimeConfig(provider("low"), "gpt-5.2", controls).reasoning, "low");
  assert.equal(
    createProviderRuntimeConfig(provider("high"), "gpt-5.2-chat-latest", controls).reasoning,
    "medium",
  );
  assert.equal(createProviderRuntimeConfig(provider("off"), "gpt-5.2", controls).reasoning, "off");
  // 会话里关掉思考仍然是最高优先级。
  assert.equal(
    createProviderRuntimeConfig(provider("low"), "gpt-5.2", { ...controls, thinkingEnabled: false })
      .reasoning,
    "off",
  );
});

test("model-level nativeWebSearch overrides the conversation toggle in both directions", () => {
  const provider = (nativeWebSearch) =>
    settings.normalizeCustomProvider({
      id: "openai",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk",
      models: [{ id: "gpt-5.2", nativeWebSearch }],
    });
  const on = { ...settings.DEFAULT_CHAT_RUNTIME_CONTROLS, nativeWebSearchEnabled: true };
  const off = { ...settings.DEFAULT_CHAT_RUNTIME_CONTROLS, nativeWebSearchEnabled: false };

  assert.equal(createProviderRuntimeConfig(provider(undefined), "gpt-5.2", on).nativeWebSearchEnabled, true);
  assert.equal(createProviderRuntimeConfig(provider(undefined), "gpt-5.2", off).nativeWebSearchEnabled, false);
  assert.equal(createProviderRuntimeConfig(provider(false), "gpt-5.2", on).nativeWebSearchEnabled, false);
  assert.equal(createProviderRuntimeConfig(provider(true), "gpt-5.2", off).nativeWebSearchEnabled, true);
});

test("protocol/dialect header tables: completions never carries session headers, Codex Responses does, endpoint auth overrides the protocol header", () => {
  assert.deepEqual(
    buildProtocolRequestHeaders({
      protocol: "openai-completions",
      dialect: "deepseek",
      apiKey: "sk",
      sessionId: SESSION_ID,
    }),
    { Authorization: "Bearer sk" },
  );
  assert.deepEqual(
    buildProtocolRequestHeaders({
      protocol: "openai-completions",
      dialect: "openai",
      apiKey: "sk",
      sessionId: SESSION_ID,
    }),
    { Authorization: "Bearer sk" },
  );
  assert.deepEqual(
    buildProtocolRequestHeaders({
      protocol: "openai-responses",
      dialect: "openai",
      apiKey: "sk",
      sessionId: SESSION_ID,
    }),
    {
      Authorization: "Bearer sk",
      "session-id": SESSION_ID,
      "thread-id": SESSION_ID,
      "x-client-request-id": SESSION_ID,
      session_id: SESSION_ID,
      conversation_id: SESSION_ID,
    },
  );
  // xai / deepseek / generic 方言的 Responses 只带 Bearer。
  for (const dialect of ["xai", "deepseek", "generic"]) {
    assert.deepEqual(
      buildProtocolRequestHeaders({
        protocol: "openai-responses",
        dialect,
        apiKey: "sk",
        sessionId: SESSION_ID,
      }),
      { Authorization: "Bearer sk" },
      dialect,
    );
  }
  // 端点 auth 覆盖：换头名与前缀。
  assert.deepEqual(
    buildProtocolRequestHeaders({
      protocol: "openai-completions",
      dialect: "generic",
      apiKey: "sk",
      auth: { headerName: "X-Auth", prefix: "Token " },
    }),
    { "X-Auth": "Token sk" },
  );
  const anthropicOverride = buildProtocolRequestHeaders({
    protocol: "anthropic-messages",
    dialect: "generic",
    apiKey: "sk",
    sessionId: SESSION_ID,
    auth: { headerName: "Authorization", prefix: "Bearer " },
  });
  assert.equal(anthropicOverride.Authorization, "Bearer sk");
  assert.equal(anthropicOverride["x-api-key"], undefined);
  assert.equal(anthropicOverride["anthropic-version"], "2023-06-01");
  assert.equal(anthropicOverride["X-Claude-Code-Session-Id"], SESSION_ID);
});

test("prepareProviderRequest assembles protocol auth, endpoint auth override, and merged endpoint headers from the routed runtime", async () => {
  const runtime = createProviderRuntimeConfig(
    buildGatewayProvider(),
    "gpt-5.2",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  const prepared = await prepareProviderRequest("codex", runtime, { sessionId: SESSION_ID });
  assert.equal(prepared.baseUrl, "http://127.0.0.1:18080/proxy/codex/compat/v1");
  const { "x-liveagent-upstream-headers": _encoded, ...headers } = prepared.headers;
  assert.deepEqual(headers, {
    "X-Auth": "Token key-backup",
    "X-Provider": "provider",
    "X-Endpoint": "endpoint",
    "x-shared": "endpoint",
    "x-liveagent-upstream-origin": "https://relay.example",
    "x-liveagent-proxy-token": "proxy-token",
  });
  // 覆盖包只按排除集剔除标准鉴权头名；自定义鉴权头名与用户头一起经覆盖包送达上游。
  assert.deepEqual(decodeOverrides(prepared.headers), {
    "X-Auth": "Token key-backup",
    "X-Provider": "provider",
    "X-Endpoint": "endpoint",
    "x-shared": "endpoint",
  });
});

test("DeepSeek endpoint normalization only applies to the Responses dialect, not Completions", async () => {
  const responses = await prepareProviderRequest("codex", {
    baseUrl: "https://relay.example.com/custom/chat/completions?region=cn",
    isFullUrl: true,
    apiKey: "sk",
    adapterProviderId: "deepseek",
    chatProtocol: "openai-responses",
    protocol: "openai-responses",
    dialect: "deepseek",
  });
  assert.equal(
    responses.headers["x-liveagent-upstream-url"],
    "https://relay.example.com/custom/v1/responses?region=cn",
  );

  const completions = await prepareProviderRequest("codex", {
    baseUrl: "https://relay.example.com/custom/chat/completions?region=cn",
    isFullUrl: true,
    apiKey: "sk",
    adapterProviderId: "codex",
    chatProtocol: "openai-completions",
    protocol: "openai-completions",
    dialect: "deepseek",
  });
  assert.equal(
    completions.headers["x-liveagent-upstream-url"],
    "https://relay.example.com/custom/chat/completions?region=cn",
  );
  assert.equal(completions.baseUrl, "http://127.0.0.1:18080/proxy/codex");
});

test("legacy runtimes without route fields resolve (protocol, dialect) from adapterProviderId and requestFormat", () => {
  assert.deepEqual(resolveRuntimeWireRoute("codex", { baseUrl: "x", apiKey: "k" }), {
    protocol: "openai-responses",
    dialect: "openai",
    family: "openai",
    adapterProviderId: "codex",
  });
  assert.deepEqual(
    resolveRuntimeWireRoute("codex", { baseUrl: "x", apiKey: "k", requestFormat: "openai-completions" }),
    { protocol: "openai-completions", dialect: "openai", family: "openai", adapterProviderId: "codex" },
  );
  assert.deepEqual(resolveRuntimeWireRoute("deepseek", { baseUrl: "x", apiKey: "k" }), {
    protocol: "openai-responses",
    dialect: "deepseek",
    family: "openai",
    adapterProviderId: "deepseek",
  });
  assert.deepEqual(resolveRuntimeWireRoute("xai", { baseUrl: "x", apiKey: "k" }), {
    protocol: "openai-responses",
    dialect: "xai",
    family: "openai",
    adapterProviderId: "xai",
  });
  assert.equal(resolveRuntimeWireRoute("claude_code", {}).dialect, "generic");
  assert.equal(resolveRuntimeWireRoute("gemini", {}).family, "gemini");
});

test("model factory maps the dialect onto Model.provider so pi-ai detectCompat applies", () => {
  const base = {
    modelId: "some-model",
    baseUrl: "http://127.0.0.1:18080/proxy/codex/v1",
    upstreamBaseUrl: "https://relay.example/v1",
  };
  const deepseek = createModelFromRoute({ ...base, protocol: "openai-completions", dialect: "deepseek" });
  assert.equal(deepseek.api, "openai-completions");
  assert.equal(deepseek.provider, "deepseek");
  // 厂商差异交给 pi-ai detectCompat（按 provider 推导），本地不再叠一份域名判断。
  assert.equal(deepseek.compat, undefined);

  const xai = createModelFromRoute({ ...base, protocol: "openai-completions", dialect: "xai" });
  assert.equal(xai.provider, "xai");
  assert.equal(xai.compat, undefined);
  assert.equal(xai.thinkingLevelMap?.minimal, "low");

  // generic / openai 方言在非官方端点上仍保留 pi-ai 隔着反代看不到的中转默认。
  const generic = createModelFromRoute({ ...base, protocol: "openai-completions", dialect: "generic" });
  assert.equal(generic.provider, "custom");
  assert.deepEqual(generic.compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsFinishReason: false,
  });
  const openai = createModelFromRoute({ ...base, protocol: "openai-completions", dialect: "openai" });
  assert.equal(openai.provider, "openai");
  assert.deepEqual(openai.compat, generic.compat);

  const official = createModelFromRoute({
    ...base,
    upstreamBaseUrl: "https://api.openai.com/v1",
    protocol: "openai-completions",
    dialect: "openai",
  });
  assert.equal(official.compat, undefined);

  // Responses + deepseek 走原生 DeepSeek Responses 适配器；Responses + xai 走 Responses。
  const deepseekResponses = createModelFromRoute({
    ...base,
    protocol: "openai-responses",
    dialect: "deepseek",
  });
  assert.equal(deepseekResponses.api, "deepseek-responses");
  assert.equal(deepseekResponses.provider, "deepseek");
  const xaiResponses = createModelFromRoute({ ...base, protocol: "openai-responses", dialect: "xai" });
  assert.equal(xaiResponses.api, "openai-responses");
  assert.equal(xaiResponses.provider, "xai");
  assert.deepEqual(xaiResponses.compat, { supportsDeveloperRole: false });
});

test("endpoint quirks map onto same-named compat keys on top of the defaults", () => {
  const model = createModelFromRoute({
    protocol: "openai-completions",
    dialect: "generic",
    modelId: "glm-5",
    baseUrl: "http://127.0.0.1:18080/proxy/codex/v1",
    upstreamBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    quirks: { supportsReasoningEffort: false, supportsUsageInStreaming: false, supportsStore: true },
  });
  assert.deepEqual(model.compat, {
    supportsStore: true,
    supportsDeveloperRole: false,
    supportsFinishReason: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
  });
  const official = createModelFromRoute({
    protocol: "openai-completions",
    dialect: "openai",
    modelId: "gpt-5.2",
    baseUrl: "https://api.openai.com/v1",
    quirks: { supportsDeveloperRole: false },
  });
  assert.deepEqual(official.compat, { supportsDeveloperRole: false });
});

test("wireModelId becomes Model.id while the local id keeps driving catalog lookups", () => {
  const openai = createModelFromRoute({
    protocol: "openai-responses",
    dialect: "openai",
    modelId: "gpt-5.2",
    wireModelId: "openai/gpt-5.2",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(openai.id, "openai/gpt-5.2");
  // 目录按本地 id 命中：展示名、限额与档位来自 gpt-5.2 的目录条目。
  assert.notEqual(openai.name, "openai/gpt-5.2");
  assert.equal(openai.contextWindow, 400000);
  assert.equal(openai.reasoning, true);

  const anthropic = createModelFromRoute({
    protocol: "anthropic-messages",
    dialect: "generic",
    modelId: "claude-sonnet-4-6",
    wireModelId: "anthropic/claude-sonnet-4-6",
    baseUrl: "https://relay.example/v1",
  });
  assert.equal(anthropic.id, "anthropic/claude-sonnet-4-6");
  assert.equal(anthropic.name, "claude-sonnet-4-6");
  assert.equal(anthropic.compat?.forceAdaptiveThinking, true);

  const gemini = createModelFromRoute({
    protocol: "google-generative-ai",
    dialect: "generic",
    modelId: "gemini-3-pro-preview",
    wireModelId: "google/gemini-3-pro-preview",
    baseUrl: "https://gateway.example",
  });
  assert.equal(gemini.id, "google/gemini-3-pro-preview");
  assert.equal(gemini.api, "google-generative-ai");

  // 未声明 wireModelId 时 Model.id 就是本地 id（旧配置不变）。
  assert.equal(
    createModelFromRoute({
      protocol: "openai-completions",
      dialect: "openai",
      modelId: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
    }).id,
    "gpt-5.2",
  );
});

test("createModelFromRuntime reads the routed runtime; legacy runtimes fall back to the ProviderId path", () => {
  const routed = createModelFromRuntime(
    "codex",
    createProviderRuntimeConfig(buildGatewayProvider(), "gpt-5.2", settings.DEFAULT_CHAT_RUNTIME_CONTROLS),
    "gpt-5.2",
    "http://127.0.0.1:18080/proxy/codex/compat/v1",
  );
  assert.equal(routed.api, "openai-completions");
  assert.equal(routed.provider, "openai");
  assert.equal(routed.id, "openai/gpt-5.2");
  assert.equal(routed.name, "gpt-5.2");
  assert.equal(routed.baseUrl, "http://127.0.0.1:18080/proxy/codex/compat/v1");
  assert.deepEqual(routed.compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsFinishReason: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
  });

  const legacy = createModelFromRuntime(
    "codex",
    { baseUrl: "https://api.x.ai/v1", apiKey: "sk", requestFormat: "openai-completions" },
    "grok-4.5",
    "http://127.0.0.1:18080/proxy/codex/v1",
  );
  // 旧 runtime 沿用 xAI 直连识别：固定 Responses。
  assert.equal(legacy.api, "openai-responses");
  assert.equal(legacy.id, "grok-4.5");

  // 旧签名的 Completions 中转仍是 openai 方言（provider "openai"），与 golden 一致。
  const legacyRelay = createModelFromConfig(
    "codex",
    "gpt-5.2",
    "https://relay.example.com/v1",
    "openai-completions",
  );
  assert.equal(legacyRelay.provider, "openai");
});

test("failover breaker keys extend to provider::credential::protocol::model while old callers keep provider::model", () => {
  assert.equal(failoverBreakerKey("p", "m"), "p::m");
  assert.equal(failoverBreakerKey("p", "m", {}), "p::m");
  assert.equal(
    failoverBreakerKey("p", "m", { credentialId: "k1", protocol: "openai-completions" }),
    "p::k1::openai-completions::m",
  );
  assert.equal(failoverBreakerKey("p", "m", { credentialId: "k1" }), "p::k1::::m");
});
