import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// LLM seam 改造（golden 基线之二）：传输装配整体快照。
//
// custom-headers-propagation.test.mjs 断言"自定义头能抵达"；本文件把
// prepareProviderRequest 的完整输出（反代 URL + 全量头集 + base64 覆盖包
// 解码内容）逐字段锁死，并锁定 failover 场景下逐候选传输配置的独立性——
// 供应商级 useSystemProxy 是"网络可达性属于每个目标"这一公理的载体，
// seam 重构绝不允许把主选的传输事实泄漏给备选。
// ============================================================================

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

const piAiEventStream = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
    import.meta.url,
  ).href
);

const PROXY_SERVER_INFO = { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function decodeOverrides(headers) {
  const encoded = headers["x-liveagent-upstream-headers"];
  if (encoded === undefined) return undefined;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

/** 覆盖包单独解码断言，其余头逐字段断言。 */
function splitPrepared(prepared) {
  const { "x-liveagent-upstream-headers": _encoded, ...headers } = prepared.headers;
  return { baseUrl: prepared.baseUrl, headers, overrides: decodeOverrides(prepared.headers) };
}

// ---------------------------------------------------------------------------
// 第一部分：prepareProviderRequest 完整输出快照（真实实现，仅 mock tauri invoke）
// ---------------------------------------------------------------------------

const transportLoader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
        throw new Error(`unexpected tauri invoke: ${command}`);
      },
    },
  },
});
const { prepareProviderRequest } = transportLoader.loadModule(
  "src/lib/providers/runtime/requestOptions.ts",
);
const { ANTHROPIC_DEFAULT_REQUEST_HEADERS } = transportLoader.loadModule(
  "@liveagent/ui/lib/providers/customHeaders.ts",
);

test("golden/transport: anthropic 全量头集（内置默认头 + 自定义头 + 覆盖包 + use-system-proxy）", async () => {
  const prepared = await prepareProviderRequest(
    "claude_code",
    {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      customHeaders: [
        { key: "X-Relay-Channel", value: "vip" },
        // 浏览器禁止头名：常规通道会被 WebView 丢弃，只能靠覆盖包送达。
        { key: "Cookie", value: "session=abc" },
      ],
      useSystemProxy: true,
    },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/claude_code/v1");
  assert.deepEqual(headers, {
    "x-api-key": "sk-ant-test",
    ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
    "X-Claude-Code-Session-Id": SESSION_ID,
    "X-Relay-Channel": "vip",
    Cookie: "session=abc",
    "x-liveagent-upstream-origin": "https://api.anthropic.com",
    "x-liveagent-proxy-token": "proxy-token",
    "x-liveagent-use-system-proxy": "1",
  });
  // 覆盖包 = 内置默认头 + 自定义头；鉴权头（x-api-key）按排除集绝不进包。
  assert.deepEqual(overrides, {
    ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
    "X-Claude-Code-Session-Id": SESSION_ID,
    "X-Relay-Channel": "vip",
    Cookie: "session=abc",
  });
});

test("golden/transport: codex Responses 链路带 session/conversation 头；直连时无 use-system-proxy", async () => {
  const prepared = await prepareProviderRequest(
    "codex",
    { baseUrl: "https://chatgpt.com/backend-api/codex", apiKey: "sk-codex-test" },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/codex/backend-api/codex");
  assert.deepEqual(headers, {
    Authorization: "Bearer sk-codex-test",
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    "session-id": SESSION_ID,
    "thread-id": SESSION_ID,
    "x-client-request-id": SESSION_ID,
    "x-liveagent-upstream-origin": "https://chatgpt.com",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.deepEqual(overrides, {
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    "session-id": SESSION_ID,
    "thread-id": SESSION_ID,
    "x-client-request-id": SESSION_ID,
  });
});

test("golden/transport: codex Completions 格式绝不泄漏 session/conversation 头", async () => {
  const prepared = await prepareProviderRequest(
    "codex",
    {
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk-relay-test",
      requestFormat: "openai-completions",
    },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/codex/v1");
  // 无状态协议仅 Bearer；头集不含任何需要覆盖包的条目。
  assert.deepEqual(headers, {
    Authorization: "Bearer sk-relay-test",
    "x-liveagent-upstream-origin": "https://relay.example.com",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.equal(overrides, undefined);
});

test("golden/transport: gemini 用 x-goog-api-key 单头鉴权", async () => {
  const prepared = await prepareProviderRequest(
    "gemini",
    { baseUrl: "https://generativelanguage.googleapis.com", apiKey: "g-test-key" },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/gemini");
  assert.deepEqual(headers, {
    "x-goog-api-key": "g-test-key",
    "x-liveagent-upstream-origin": "https://generativelanguage.googleapis.com",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.equal(overrides, undefined);
});

test("golden/transport: deepseek full URL 模式保留完整上游 URL（含查询参数）", async () => {
  const prepared = await prepareProviderRequest(
    "deepseek",
    {
      baseUrl: "https://relay.example.com/openai/v1/responses?alt=x",
      apiKey: "sk-ds-test",
      isFullUrl: true,
    },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/deepseek");
  assert.deepEqual(headers, {
    Authorization: "Bearer sk-ds-test",
    "x-liveagent-upstream-origin": "https://relay.example.com",
    "x-liveagent-upstream-url": "https://relay.example.com/openai/v1/responses?alt=x",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.equal(overrides, undefined);
});

// ---------------------------------------------------------------------------
// 第二部分：failover 逐候选传输配置独立性。
// 场景来自网络拓扑用户故事：主选是走应用代理的国外供应商，备选是直连的国内
// 中转。断言两个目标各自独立装配（use-system-proxy 头互不泄漏），主选未提交
// 失败后备选以自己的传输配置接管。
// ---------------------------------------------------------------------------

/** 捕获经 streamSimpleByApi 发出的每次调用（model + options.headers）。 */
const streamCalls = [];
let streamImpl = () => {
  throw new Error("streamImpl was not configured");
};

const failoverLoader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
        throw new Error(`unexpected tauri invoke: ${command}`);
      },
    },
    [abs("src/lib/providers/runtime/streamByApi.ts")]: {
      streamSimpleByApi: (model, context, options) => {
        streamCalls.push({ model, options });
        return streamImpl(model, context, options);
      },
    },
    [abs("src/lib/system/powerActivity.ts")]: {
      withPowerActivity: (_scope, _reason, run) => run(),
    },
    [abs("src/lib/debug/agentDebug.ts")]: {
      buildStreamRequestDebugPayload: () => ({}),
    },
    [abs("src/lib/providers/hostedSearchEvents.ts")]: {
      createHostedSearchProbeId: () => undefined,
      withHostedSearchProbeHeader: (headers) => headers ?? {},
      startHostedSearchFetchProbe: () => ({ finish: async () => {} }),
      createHostedSearchEventAggregator: () => ({
        accept: () => {},
        complete: () => [],
        fail: () => {},
        dispose: () => {},
        getBlocks: () => [],
      }),
    },
  },
});

const { streamAssistantMessage } = failoverLoader.loadModule(
  "src/lib/providers/runtime/textOnlyRuntime.ts",
);
const { resetFailoverBreakers } = failoverLoader.loadModule(
  "src/lib/providers/runtime/providerFailover.ts",
);

function makeAssistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "claude_code",
    model: "claude-x",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function makeSourceStream(events) {
  const stream = piAiEventStream.createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  return stream;
}

function successStream(text) {
  const message = { ...makeAssistantMessage(), content: [{ type: "text", text }] };
  return makeSourceStream([
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "done", reason: "stop", message },
  ]);
}

function uncommittedErrorStream(errorMessage) {
  const message = { ...makeAssistantMessage(), stopReason: "error", errorMessage };
  return makeSourceStream([
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ]);
}

test.beforeEach(() => {
  resetFailoverBreakers();
  streamCalls.length = 0;
});

test("golden/transport-failover: 主选走代理 + 备选直连，逐候选传输配置互不泄漏", async () => {
  // 主选：国外供应商，勾选走应用代理。
  const primaryRuntime = {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-primary",
    promptCachingEnabled: false,
    useSystemProxy: true,
  };
  // 备选：国内中转，直连（不带 useSystemProxy）。
  const fallbackRuntime = {
    baseUrl: "https://relay.cn.example/v1",
    apiKey: "sk-fallback",
    promptCachingEnabled: false,
  };

  streamImpl = (_model, _context, options) =>
    options.headers["x-liveagent-use-system-proxy"] === "1"
      ? uncommittedErrorStream("502 upstream proxy unavailable")
      : successStream("fallback-answer");

  const final = await streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-x",
    runtime: primaryRuntime,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    sessionId: SESSION_ID,
    onTextDelta: () => {},
    failover: {
      config: { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 },
      primary: {
        selectedModel: { customProviderId: "p-abroad", model: "claude-x" },
        label: "国外官方 · claude-x",
      },
      fallbacks: [
        {
          selectedModel: { customProviderId: "p-cn-relay", model: "claude-x" },
          providerId: "claude_code",
          model: "claude-x",
          label: "国内中转 · claude-x",
          runtime: fallbackRuntime,
        },
      ],
    },
  });

  assert.equal(final.content[0].text, "fallback-answer");
  assert.equal(streamCalls.length, 2);

  // 候选 1（主选）：真实 prepareProviderRequest 输出，带 use-system-proxy。
  const primaryCall = streamCalls[0];
  assert.equal(primaryCall.model.baseUrl, "http://127.0.0.1:18080/proxy/claude_code/v1");
  assert.equal(primaryCall.options.headers["x-liveagent-use-system-proxy"], "1");
  assert.equal(primaryCall.options.headers["x-api-key"], "sk-primary");
  assert.equal(
    primaryCall.options.headers["x-liveagent-upstream-origin"],
    "https://api.anthropic.com",
  );

  // 候选 2（备选）：独立装配，绝不继承主选的 use-system-proxy 与凭据。
  const fallbackCall = streamCalls[1];
  assert.equal(fallbackCall.model.baseUrl, "http://127.0.0.1:18080/proxy/claude_code/v1");
  assert.equal(fallbackCall.options.headers["x-liveagent-use-system-proxy"], undefined);
  assert.equal(fallbackCall.options.headers["x-api-key"], "sk-fallback");
  assert.equal(
    fallbackCall.options.headers["x-liveagent-upstream-origin"],
    "https://relay.cn.example",
  );
});

test("golden/transport-failover: 反向拓扑（主选直连 + 备选走代理）同样逐候选独立", async () => {
  const primaryRuntime = {
    baseUrl: "https://relay.cn.example/v1",
    apiKey: "sk-primary-direct",
    promptCachingEnabled: false,
  };
  const fallbackRuntime = {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-fallback-proxied",
    promptCachingEnabled: false,
    useSystemProxy: true,
  };

  streamImpl = (_model, _context, options) =>
    options.headers["x-liveagent-use-system-proxy"] === "1"
      ? successStream("proxied-answer")
      : uncommittedErrorStream("503 relay unavailable");

  const final = await streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-x",
    runtime: primaryRuntime,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    sessionId: SESSION_ID,
    onTextDelta: () => {},
    failover: {
      config: { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 },
      primary: {
        selectedModel: { customProviderId: "p-cn-relay", model: "claude-x" },
        label: "国内中转 · claude-x",
      },
      fallbacks: [
        {
          selectedModel: { customProviderId: "p-abroad", model: "claude-x" },
          providerId: "claude_code",
          model: "claude-x",
          label: "国外官方 · claude-x",
          runtime: fallbackRuntime,
        },
      ],
    },
  });

  assert.equal(final.content[0].text, "proxied-answer");
  assert.equal(streamCalls.length, 2);
  assert.equal(streamCalls[0].options.headers["x-liveagent-use-system-proxy"], undefined);
  assert.equal(streamCalls[0].options.headers["x-api-key"], "sk-primary-direct");
  assert.equal(streamCalls[1].options.headers["x-liveagent-use-system-proxy"], "1");
  assert.equal(streamCalls[1].options.headers["x-api-key"], "sk-fallback-proxied");
});
