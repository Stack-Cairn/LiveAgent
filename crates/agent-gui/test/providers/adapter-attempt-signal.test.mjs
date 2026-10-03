import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// 五个适配器工厂的 attemptSignal 接线。
//
// withStreamRetry 的 watchdog 只能中止"本次尝试"的 signal；某个工厂若漏接
// attemptSignal、仍把父 signal 交给 pi-ai，超时触发后请求不会被中止，流就
// 永远挂着。本文件按"传给底层 stream() 的 options.signal"逐协议锁定：
// 设了计时器 → 尝试级 signal（随父中止）；没设 → 原样是父 signal。
// ============================================================================

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const deepSeekNativePath = path.join(rootDir, "src/lib/providers/deepSeekNative.ts");

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createSourceStream(model) {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "done", reason: "stop", message: assistant },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return assistant;
    },
  };
}

function createModel(api, provider) {
  return {
    id: `${provider}-model`,
    name: `${provider}-model`,
    api,
    provider,
    baseUrl: "https://relay.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const CONTEXT = {
  systemPrompt: "You are precise.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

const captured = [];
function captureStream(streamModel, _context, options) {
  captured.push(options);
  return createSourceStream(streamModel);
}

const PI_AI_APIS = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "google-generative-ai": "google",
};

const piAiLoader = createTsModuleLoader({
  mocks: Object.fromEntries(
    Object.keys(PI_AI_APIS).map((api) => [
      `@earendil-works/pi-ai/api/${api}`,
      { stream: captureStream },
    ]),
  ),
});
const { piAiAdapter } = piAiLoader.loadModule("src/lib/providers/service/piAiAdapter.ts");

const DEEPSEEK_RESPONSES_API = "deepseek-responses";
const deepSeekLoader = createTsModuleLoader({
  mocks: {
    [deepSeekNativePath]: { DEEPSEEK_RESPONSES_API, streamDeepSeekResponses: captureStream },
  },
});
const { deepSeekAdapter } = deepSeekLoader.loadModule(
  "src/lib/providers/service/deepSeekAdapter.ts",
);

const CASES = [
  ...Object.entries(PI_AI_APIS).map(([api, provider]) => ({
    api,
    adapter: piAiAdapter,
    model: createModel(api, provider),
  })),
  {
    api: DEEPSEEK_RESPONSES_API,
    adapter: deepSeekAdapter,
    model: createModel(DEEPSEEK_RESPONSES_API, "deepseek"),
  },
];

for (const { api, adapter, model } of CASES) {
  test(`${api}: a watchdog timer hands the request an attempt signal linked to the parent`, async () => {
    captured.length = 0;
    const parent = new AbortController();
    const stream = adapter.stream(model, CONTEXT, {
      apiKey: "sk-test",
      signal: parent.signal,
      streamRetry: { firstEventTimeoutMs: 60_000 },
    });
    assert.equal(captured.length, 1, `${api}: expected exactly one stream call`);
    const { signal } = captured[0];
    assert.ok(signal instanceof AbortSignal, api);
    assert.notEqual(signal, parent.signal, api);
    assert.equal(signal.aborted, false, api);
    // 尝试仍在进行（watchdog 未释放）时，父中止必须传到请求上。
    parent.abort();
    assert.equal(signal.aborted, true, api);
    await stream.result();
  });

  test(`${api}: without a timer the request keeps the parent signal itself`, async () => {
    captured.length = 0;
    const parent = new AbortController();
    const stream = adapter.stream(model, CONTEXT, {
      apiKey: "sk-test",
      signal: parent.signal,
      streamRetry: {},
    });
    assert.equal(captured.length, 1, `${api}: expected exactly one stream call`);
    assert.equal(captured[0].signal, parent.signal, api);
    await stream.result();
  });
}
