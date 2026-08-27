import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// PR-1 seam 骨架单元测试：注册表分发、未知协议错误文案等价、一次性分发、
// dev 冻结/生产不冻结、兼容壳与统一入口 llm.stream() 的 wire payload 等价。
//
// 行为等价的总判定基准是 PR-0 golden 两套件零修改通过（见
// wire-payload-golden.test.mjs / transport-golden.test.mjs）；本文件补充
// seam 自身的新契约。
// ============================================================================

const realAnthropic = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
    import.meta.url,
  ).href
);
const realCompletions = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
    import.meta.url,
  ).href
);
const realResponses = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js",
    import.meta.url,
  ).href
);
const realGoogle = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js",
    import.meta.url,
  ).href
);

const loader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/anthropic-messages": { stream: realAnthropic.stream },
    "@earendil-works/pi-ai/api/openai-completions": { stream: realCompletions.stream },
    "@earendil-works/pi-ai/api/openai-responses": { stream: realResponses.stream },
    "@earendil-works/pi-ai/api/google-generative-ai": { stream: realGoogle.stream },
  },
});

const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");
const { llm, llmStream, setLlmServiceDevModeForTest } = loader.loadModule(
  "src/lib/providers/service/llmService.ts",
);
const { registeredApis, resolveAdapter, registerAdapter } = loader.loadModule(
  "src/lib/providers/service/registry.ts",
);
const { piAiAdapter } = loader.loadModule("src/lib/providers/service/piAiAdapter.ts");
const { deepSeekAdapter } = loader.loadModule("src/lib/providers/service/deepSeekAdapter.ts");
const { DEEPSEEK_RESPONSES_API } = loader.loadModule("src/lib/providers/deepSeekNative.ts");

function buildModel(api, overrides = {}) {
  return {
    id: "test-model",
    provider: "openai",
    api,
    baseUrl: "https://example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  };
}

function buildContext() {
  return {
    systemPrompt: "You are a precise assistant.",
    messages: [{ role: "user", content: "hello world", timestamp: 1 }],
  };
}

/** 在 onPayload 截获 wire payload 后中断请求（同 golden 的捕获通道）。 */
async function captureViaEntry(entry, model, context, options = {}) {
  let captured;
  const stream = entry(model, context, {
    apiKey: "sk-test",
    ...options,
    onPayload: async (payload) => {
      captured = payload;
      throw new Error("__capture_stop__");
    },
  });
  try {
    await stream.result();
  } catch {
    // onPayload 抛错中断请求属预期。
  }
  assert.ok(captured, "expected wire payload capture");
  return JSON.parse(JSON.stringify(captured));
}

test.afterEach(() => {
  setLlmServiceDevModeForTest(undefined);
});

// ---------------------------------------------------------------------------
// 注册表分发
// ---------------------------------------------------------------------------

test("seam/registry: 五协议各归其所（4×pi-ai + deepseek 原生）", () => {
  // 触发默认装配（llmService 模块加载即注册，此处显式断言注册表内容）。
  assert.deepEqual(registeredApis().sort(), [
    "anthropic-messages",
    DEEPSEEK_RESPONSES_API,
    "google-generative-ai",
    "openai-completions",
    "openai-responses",
  ].sort());

  for (const api of [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]) {
    assert.equal(resolveAdapter(api), piAiAdapter, `${api} should route to piAiAdapter`);
  }
  assert.equal(resolveAdapter(DEEPSEEK_RESPONSES_API), deepSeekAdapter);
});

test("seam/registry: 未注册协议错误文案与重构前逐字一致", () => {
  assert.throws(() => resolveAdapter("mock-api"), /^Error: Unsupported model API: mock-api$/);
  // 经兼容壳走同一路径、同一文案。
  assert.throws(
    () => streamSimpleByApi(buildModel("mock-api"), buildContext(), { apiKey: "k" }),
    /^Error: Unsupported model API: mock-api$/,
  );
});

test("seam/registry: 同一协议重复注册不同适配器立即抛错", () => {
  const rogue = { apis: ["anthropic-messages"], stream: () => {} };
  assert.throws(
    () => registerAdapter(rogue),
    /Duplicate LLM adapter registration for API: anthropic-messages/,
  );
  // 同一适配器重复注册幂等（默认装配的 ensure 语义依赖它）。
  registerAdapter(piAiAdapter);
});

// ---------------------------------------------------------------------------
// llm.stream() 信封语义
// ---------------------------------------------------------------------------

test("seam/llm.stream: 同一请求信封二次分发抛错（一次性分发）", async () => {
  const request = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const first = llm.stream(request);
  try {
    await first.result();
  } catch {
    // 中断属预期。
  }
  assert.throws(() => llm.stream(request), /already dispatched/);
});

test("seam/llm.stream: dev 构建冻结请求信封，生产构建不冻结", async () => {
  setLlmServiceDevModeForTest(true);
  const devRequest = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const devStream = llm.stream(devRequest);
  try {
    await devStream.result();
  } catch {
    // 中断属预期。
  }
  assert.ok(Object.isFrozen(devRequest), "dev build must freeze the request envelope");

  setLlmServiceDevModeForTest(false);
  const prodRequest = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const prodStream = llm.stream(prodRequest);
  try {
    await prodStream.result();
  } catch {
    // 中断属预期。
  }
  assert.equal(Object.isFrozen(prodRequest), false, "prod build must not freeze");
});

test("seam/llm.stream: 测试加载器环境自动探测落到不冻结（import.meta 空壳）", async () => {
  // 不设 override：detectDevBuild 在 esbuild CJS 转译下 import.meta.env 不存在。
  const request = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const stream = llmStream(request);
  try {
    await stream.result();
  } catch {
    // 中断属预期。
  }
  assert.equal(Object.isFrozen(request), false);
});

// ---------------------------------------------------------------------------
// 兼容壳与统一入口等价
// ---------------------------------------------------------------------------

test("seam/equivalence: 兼容壳与 llm.stream() 产出同一 wire payload", async () => {
  const context = buildContext();
  const viaShim = await captureViaEntry(
    streamSimpleByApi,
    buildModel("openai-completions"),
    context,
  );
  const viaService = await captureViaEntry(
    (model, ctx, options) => llm.stream({ model, context: ctx, options }),
    buildModel("openai-completions"),
    context,
  );
  assert.deepEqual(viaService, viaShim);
});

test("seam/equivalence: deepseek 原生协议经两个入口同样等价", async () => {
  const context = buildContext();
  const model = buildModel(DEEPSEEK_RESPONSES_API, { provider: "deepseek" });
  const viaShim = await captureViaEntry(streamSimpleByApi, model, context);
  const viaService = await captureViaEntry(
    (m, ctx, options) => llm.stream({ model: m, context: ctx, options }),
    model,
    context,
  );
  assert.deepEqual(viaService, viaShim);
});
