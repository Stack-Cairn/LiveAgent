import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 模型连通测试：URL 拼接（/v1 去重、isFullUrl、Gemini 路径）、四类请求体、请求头、
// 响应归类、多 Key 聚合，以及 checkProviderModel 的桌面 / WebUI 两条发送路径。
const invokeCalls = [];
let invokeResponder = () => ({ status: 200, latency_ms: 12, body: "{}" });
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command, args) {
        invokeCalls.push({ command, args });
        return Promise.resolve(invokeResponder(command, args));
      },
    },
  },
});
const modelCheck = loader.loadModule("@liveagent/ui/lib/providers/modelCheck.ts");
const providerUtils = loader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

function route(overrides = {}) {
  return {
    protocol: "openai-completions",
    protocolSource: "provider",
    family: "openai",
    dialect: "generic",
    adapterProviderId: "codex",
    baseUrl: "https://relay.example.com/v1",
    isFullUrl: false,
    wireModelId: "gpt-test",
    credentialId: "default",
    credentialSource: "scope",
    headers: [],
    quirks: {},
    ...overrides,
  };
}

test("model check URLs follow each protocol's request path without duplicating /v1", () => {
  const url = (overrides) => modelCheck.buildModelCheckUrl(route(overrides));
  assert.equal(url({}), "https://relay.example.com/v1/chat/completions");
  assert.equal(
    url({ baseUrl: "https://relay.example.com" }),
    "https://relay.example.com/v1/chat/completions",
  );
  assert.equal(
    url({ baseUrl: "https://relay.example.com/v1/chat/completions/" }),
    "https://relay.example.com/v1/chat/completions",
  );
  // 非 v1 版本段（智谱 /api/paas/v4）原样保留。
  assert.equal(
    url({ baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  assert.equal(
    url({ protocol: "openai-responses", baseUrl: "https://api.openai.com/v1/responses" }),
    "https://api.openai.com/v1/responses",
  );
  assert.equal(
    url({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    url({ protocol: "anthropic-messages", baseUrl: "https://relay.example.com/anthropic/v1" }),
    "https://relay.example.com/anthropic/v1/messages",
  );
  assert.equal(
    url({
      protocol: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      wireModelId: "gemini-2.5-pro",
    }),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
  );
  assert.equal(
    url({
      protocol: "google-generative-ai",
      baseUrl: "https://relay.example.com/v1beta/models/old-model:generateContent",
      wireModelId: "models/gemini-flash",
    }),
    "https://relay.example.com/v1beta/models/gemini-flash:generateContent",
  );
  assert.equal(
    url({ protocol: "google-generative-ai", baseUrl: "https://relay.example.com" }),
    "https://relay.example.com/v1beta/models/gpt-test:generateContent",
  );
  // 完整端点模式：原样使用。
  assert.equal(
    url({ isFullUrl: true, baseUrl: "https://relay.example.com/custom/chat?x=1" }),
    "https://relay.example.com/custom/chat?x=1",
  );
  assert.equal(url({ baseUrl: "   " }), "");
});

test("model check bodies are minimal and honour endpoint quirks", () => {
  const body = (overrides) => modelCheck.buildModelCheckBody(route(overrides));
  assert.deepEqual(body({}), {
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    max_tokens: 8,
  });
  assert.deepEqual(body({ quirks: { maxTokensField: "max_completion_tokens" } }), {
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    max_completion_tokens: 8,
  });
  assert.deepEqual(body({ protocol: "openai-responses" }), {
    model: "gpt-test",
    input: "hi",
    max_output_tokens: 16,
    store: false,
  });
  assert.deepEqual(body({ protocol: "openai-responses", quirks: { supportsStore: false } }), {
    model: "gpt-test",
    input: "hi",
    max_output_tokens: 16,
  });
  assert.deepEqual(body({ protocol: "anthropic-messages", wireModelId: "claude-sonnet-4" }), {
    model: "claude-sonnet-4",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(body({ protocol: "google-generative-ai" }), {
    contents: [{ parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 8 },
  });
});

test("model check requests carry protocol auth, custom headers and drop auth when key is redacted", () => {
  const completions = modelCheck.buildModelCheckRequest(
    route({ headers: [{ key: "X-Relay", value: "1" }] }),
    "sk-test",
  );
  assert.equal(completions.method, "POST");
  assert.equal(completions.headers.Authorization, "Bearer sk-test");
  assert.equal(completions.headers["Content-Type"], "application/json");
  assert.equal(completions.headers["X-Relay"], "1");

  const messages = modelCheck.buildModelCheckRequest(
    route({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
    "sk-ant",
  );
  assert.equal(messages.headers["x-api-key"], "sk-ant");
  assert.equal(messages.headers["anthropic-version"], "2023-06-01");

  const overridden = modelCheck.buildModelCheckRequest(
    route({ auth: { headerName: "api-key" } }),
    "azure-key",
  );
  assert.equal(overridden.headers["api-key"], "azure-key");
  assert.equal(overridden.headers.Authorization, undefined);

  // WebUI 脱敏态：不带鉴权头，由桌面端按 credentialId 补。
  const redacted = modelCheck.buildModelCheckRequest(route(), "");
  assert.equal(redacted.headers.Authorization, undefined);
  assert.equal(redacted.headers["Content-Type"], "application/json");
  const redactedOverride = modelCheck.buildModelCheckRequest(
    route({ auth: { headerName: "api-key" } }),
    "",
  );
  assert.equal(redactedOverride.headers["api-key"], undefined);
});

test("model check responses are classified by status and body shape", () => {
  const summarize = modelCheck.summarizeModelCheckResponse;
  const ok = summarize(
    "openai-completions",
    200,
    JSON.stringify({ choices: [{ message: { content: "Hello there" } }] }),
  );
  assert.deepEqual(ok, { ok: true, outputSnippet: "Hello there" });
  assert.equal(
    summarize("openai-responses", 200, JSON.stringify({ output_text: "hi" })).outputSnippet,
    "hi",
  );
  assert.equal(
    summarize(
      "openai-responses",
      200,
      JSON.stringify({ output: [{ content: [{ type: "output_text", text: "yo" }] }] }),
    ).outputSnippet,
    "yo",
  );
  assert.equal(
    summarize("anthropic-messages", 200, JSON.stringify({ content: [{ type: "text", text: "hey" }] }))
      .outputSnippet,
    "hey",
  );
  assert.equal(
    summarize(
      "google-generative-ai",
      200,
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "hola" }] } }] }),
    ).outputSnippet,
    "hola",
  );
  // 合法 JSON 但解析不出文本（例如只有 usage）：仍算通。
  assert.equal(summarize("openai-completions", 200, JSON.stringify({ usage: {} })).ok, true);

  const unauthorized = summarize(
    "openai-completions",
    401,
    JSON.stringify({ error: { message: "Incorrect API key provided" } }),
  );
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.kind, "unauthorized");
  assert.equal(unauthorized.error, "Incorrect API key provided");
  assert.equal(summarize("openai-completions", 403, "").kind, "unauthorized");
  assert.equal(summarize("openai-completions", 404, "not found").kind, "notFound");
  assert.equal(summarize("openai-completions", 429, "{}").kind, "rateLimited");

  const server = summarize("openai-completions", 500, JSON.stringify({ message: "boom" }));
  assert.equal(server.kind, "http");
  assert.equal(server.error, "boom");
  assert.equal(summarize("openai-completions", 502, "").error, "HTTP 502");
  const long = summarize(
    "openai-completions",
    400,
    JSON.stringify({ error: { message: "x".repeat(500) } }),
  );
  assert.equal(long.error.length, 161);

  const notJson = summarize("openai-completions", 200, "<html>upstream</html>");
  assert.equal(notJson.ok, false);
  assert.equal(notJson.kind, "invalidResponse");
  // 200 里包着错误对象：按错误处理。
  const wrapped = summarize(
    "openai-completions",
    200,
    JSON.stringify({ error: { message: "model not allowed" } }),
  );
  assert.equal(wrapped.ok, false);
  assert.equal(wrapped.error, "model not allowed");
});

test("aggregateModelCheck reports ok / partial / failed and the fastest passing key", () => {
  const pass = (id, latencyMs) => ({
    ok: true,
    latencyMs,
    credentialId: id,
    credentialLabel: id,
  });
  const fail = (id) => ({
    ok: false,
    kind: "unauthorized",
    latencyMs: 5,
    credentialId: id,
    credentialLabel: id,
  });
  assert.equal(modelCheck.aggregateModelCheck([]).state, "idle");
  const ok = modelCheck.aggregateModelCheck([pass("a", 300), pass("b", 120)]);
  assert.equal(ok.state, "ok");
  assert.equal(ok.latencyMs, 120);
  const partial = modelCheck.aggregateModelCheck([pass("a", 300), fail("b")]);
  assert.equal(partial.state, "partial");
  assert.equal(partial.latencyMs, 300);
  const failed = modelCheck.aggregateModelCheck([fail("a"), fail("b")]);
  assert.equal(failed.state, "failed");
  assert.equal(failed.latencyMs, undefined);
});

function multiKeyProvider(extra = {}) {
  return settings.normalizeCustomProvider({
    id: "p-check",
    name: "Relay",
    type: "codex",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-primary",
    requestFormat: "openai-completions",
    useSystemProxy: true,
    models: [{ id: "gpt-a" }, { id: "gpt-b" }, { id: "gpt-c" }],
    activeModels: ["gpt-a", "gpt-b", "gpt-c"],
    credentials: [
      { id: "default", label: "", apiKey: "sk-primary", enabled: true },
      {
        id: "backup",
        label: "备用",
        apiKey: "sk-backup",
        enabled: true,
        modelScope: { mode: "manual", models: ["gpt-a"] },
      },
      { id: "off", label: "停用", apiKey: "sk-off", enabled: false },
    ],
    ...extra,
  });
}

test("checkProviderModel sends the minimal request through the desktop command with the chosen key", async () => {
  invokeCalls.length = 0;
  invokeResponder = () => ({
    status: 200,
    latency_ms: 321,
    body: JSON.stringify({ choices: [{ message: { content: "hi!" } }] }),
  });
  const provider = multiKeyProvider();
  const result = await providerUtils.checkProviderModel(provider, "gpt-a", {
    credentialId: "backup",
  });
  assert.equal(result.ok, true);
  assert.equal(result.latencyMs, 321);
  assert.equal(result.status, 200);
  assert.equal(result.credentialId, "backup");
  assert.equal(result.credentialLabel, "备用");
  assert.equal(result.outputSnippet, "hi!");
  assert.equal(invokeCalls.length, 1);
  const { command, args } = invokeCalls[0];
  assert.equal(command, "provider_check_model");
  assert.equal(args.url, "https://relay.example.com/v1/chat/completions");
  assert.equal(args.use_system_proxy, true);
  assert.deepEqual(args.body, {
    model: "gpt-a",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    max_tokens: 8,
  });
  const headers = Object.fromEntries(args.headers);
  assert.equal(headers.Authorization, "Bearer sk-backup");
  assert.equal(headers["Content-Type"], "application/json");

  // 失败归类透传；invoke 抛错归为 network。
  invokeResponder = () => ({ status: 401, latency_ms: 40, body: '{"error":"bad key"}' });
  const unauthorized = await providerUtils.checkProviderModel(provider, "gpt-a");
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.kind, "unauthorized");
  assert.equal(unauthorized.error, "bad key");
  invokeResponder = () => Promise.reject(new Error("无法连接到供应商"));
  const network = await providerUtils.checkProviderModel(provider, "gpt-a");
  assert.equal(network.kind, "network");
  assert.equal(network.error, "无法连接到供应商");

  // 没有 Key：不发请求。
  invokeCalls.length = 0;
  const noKey = await providerUtils.checkProviderModel(
    multiKeyProvider({ apiKey: "", credentials: [{ id: "default", label: "", apiKey: "", enabled: true }] }),
    "gpt-a",
  );
  assert.equal(noKey.kind, "noKey");
  assert.equal(invokeCalls.length, 0);
});

test("checkProviderModelAllKeys tests every enabled key covering the model and aggregates", async () => {
  invokeCalls.length = 0;
  invokeResponder = (_command, args) => {
    const auth = Object.fromEntries(args.headers).Authorization;
    return auth === "Bearer sk-backup"
      ? { status: 429, latency_ms: 20, body: "{}" }
      : { status: 200, latency_ms: 100, body: '{"choices":[{"message":{"content":"ok"}}]}' };
  };
  const provider = multiKeyProvider();
  const a = await providerUtils.checkProviderModelAllKeys(provider, "gpt-a");
  assert.equal(a.state, "partial");
  assert.deepEqual(
    a.results.map((result) => [result.credentialId, result.ok, result.kind]),
    [
      ["default", true, undefined],
      ["backup", false, "rateLimited"],
    ],
  );
  // gpt-b 只有默认 Key 覆盖（备用 Key 手选范围不含、停用 Key 不参与）。
  const b = await providerUtils.checkProviderModelAllKeys(provider, "gpt-b");
  assert.equal(b.state, "ok");
  assert.deepEqual(
    b.results.map((result) => result.credentialId),
    ["default"],
  );
  assert.equal(b.latencyMs, 100);
});

test("checkProviderModels runs a bounded worker pool and stops on abort", async () => {
  invokeCalls.length = 0;
  let inFlight = 0;
  let peak = 0;
  const release = [];
  invokeResponder = () =>
    new Promise((resolve) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      release.push(() => {
        inFlight -= 1;
        resolve({ status: 200, latency_ms: 1, body: "{}" });
      });
    });
  const provider = multiKeyProvider({
    credentials: [{ id: "default", label: "", apiKey: "sk-primary", enabled: true }],
  });
  const seen = [];
  const controller = new AbortController();
  const done = providerUtils.checkProviderModels(provider, ["gpt-a", "gpt-b", "gpt-c"], {
    concurrency: 2,
    signal: controller.signal,
    onResult: (modelId, aggregate) => seen.push([modelId, aggregate.state]),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  while (release.length > 0) release.shift()();
  const results = await done;
  // 第一个结果在中止前落地；中止后不再回调也不再发新请求。
  assert.deepEqual(seen, [["gpt-a", "ok"]]);
  assert.equal(results.size, 1);
  assert.equal(invokeCalls.length, 3);
});

test("gateway WebUI sends model checks through the bridge without the redacted key", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { documentElement: { dataset: { liveagentWebui: "gateway" } } };
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return key === "liveagent.gateway.token" ? "gateway-token" : null;
      },
    },
  };
  invokeCalls.length = 0;
  invokeResponder = () => ({ status: 200, latency_ms: 55, body: '{"content":[{"text":"hi"}]}' });
  try {
    const provider = settings.normalizeCustomProvider({
      id: "p-web",
      name: "Anthropic relay",
      type: "claude_code",
      baseUrl: "https://relay.example.com",
      apiKey: "",
      apiKeyConfigured: true,
      models: [{ id: "claude-sonnet-4" }],
      activeModels: ["claude-sonnet-4"],
      credentials: [{ id: "default", label: "", apiKey: "", apiKeyConfigured: true, enabled: true }],
      endpointConfigs: {
        "anthropic-messages": {
          baseUrl: "https://relay.example.com",
          auth: { headerName: "X-Relay-Key", prefix: "Key " },
        },
      },
    });
    const result = await providerUtils.checkProviderModel(provider, "claude-sonnet-4");
    assert.equal(result.ok, true);
    assert.equal(result.latencyMs, 55);
    assert.equal(invokeCalls.length, 1);
    const { command, args } = invokeCalls[0];
    assert.equal(command, "gateway_provider_check_model");
    assert.equal(args.url, "https://relay.example.com/v1/messages");
    assert.equal(args.provider_id, "p-web");
    assert.equal(args.credential_id, "default");
    assert.equal(args.protocol, "anthropic-messages");
    assert.equal(args.auth_header_name, "X-Relay-Key");
    assert.equal(args.auth_prefix, "Key ");
    const headerNames = args.headers.map((header) => header.key.toLowerCase());
    assert.ok(!headerNames.includes("x-relay-key"));
    assert.ok(!headerNames.includes("x-api-key"));
    assert.ok(headerNames.includes("anthropic-version"));
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});
