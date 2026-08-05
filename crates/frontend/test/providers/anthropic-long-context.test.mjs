import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const anthropicModels = loader.loadModule("src/lib/providers/anthropicModels.ts");
const longContext = loader.loadModule("src/lib/providers/runtime/anthropicLongContext.ts");
const payloadPipeline = loader.loadModule("src/lib/providers/runtime/payloadPipeline.ts");
const modelFactory = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const INTERLEAVED_BETA = "interleaved-thinking-2025-05-14";
const FINE_GRAINED_BETA = "fine-grained-tool-streaming-2025-05-14";

function makeAnthropicModel(overrides = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://relay.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    compat: { forceAdaptiveThinking: true },
    ...overrides,
  };
}

test("长上下文 beta：adaptive 模型 ctx>200K 时仅追加 context-1m，保留既有请求头", () => {
  const options = {
    apiKey: "sk-relay-key",
    headers: { Authorization: "Bearer sk-relay-key", "x-api-key": "sk-relay-key" },
  };
  const next = longContext.attachAnthropicLongContextBeta(options, {
    providerId: "claude_code",
    baseUrl: "https://relay.example.com/v1",
    model: makeAnthropicModel(),
  });
  assert.equal(next.headers["anthropic-beta"], CONTEXT_1M_BETA);
  assert.equal(next.headers.Authorization, "Bearer sk-relay-key");
  assert.equal(next.headers["x-api-key"], "sk-relay-key");
  // 原 options 不被原地修改。
  assert.equal(options.headers["anthropic-beta"], undefined);
});

test("长上下文 beta：非 adaptive 模型镜像 pi-ai 的 interleaved beta 再追加 context-1m", () => {
  const next = longContext.attachAnthropicLongContextBeta(
    { apiKey: "sk-relay-key", headers: {} },
    {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({ id: "claude-sonnet-4-5", compat: undefined }),
    },
  );
  assert.equal(next.headers["anthropic-beta"], `${INTERLEAVED_BETA},${CONTEXT_1M_BETA}`);
});

test("长上下文 beta：compat 关闭 eager streaming 且带工具时镜像 fine-grained beta", () => {
  const next = longContext.attachAnthropicLongContextBeta(
    { apiKey: "sk-relay-key", headers: {} },
    {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({
        compat: { forceAdaptiveThinking: true, supportsEagerToolInputStreaming: false },
      }),
      context: {
        messages: [],
        tools: [{ name: "read", description: "", parameters: { type: "object" } }],
      },
    },
  );
  assert.equal(next.headers["anthropic-beta"], `${FINE_GRAINED_BETA},${CONTEXT_1M_BETA}`);
});

test("长上下文 beta：忽略已有值，仅使用 pi-ai 动态 beta 与 context-1m", () => {
  const next = longContext.attachAnthropicLongContextBeta(
    {
      apiKey: "sk-relay-key",
      headers: {
        "Anthropic-Beta": `prompt-caching-scope-2026-01-05, ${CONTEXT_1M_BETA}`,
        Authorization: "Bearer sk-relay-key",
      },
    },
    {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({
        compat: undefined,
        headers: { "anthropic-beta": "model-custom-beta" },
      }),
    },
  );
  assert.equal(next.headers["anthropic-beta"], `${INTERLEAVED_BETA},${CONTEXT_1M_BETA}`);
  assert.equal(next.headers["Anthropic-Beta"], undefined);
  assert.equal(next.headers.Authorization, "Bearer sk-relay-key");
});

test("长上下文 beta：官方、Vertex、DeepSeek 端点不注入 HTTP 1M beta 头", () => {
  for (const baseUrl of [
    "https://api.anthropic.com/v1",
    "https://us-central1-aiplatform.googleapis.com/v1",
    "https://api.deepseek.com/anthropic",
  ]) {
    const options = { apiKey: "sk-relay-key", headers: {} };
    assert.equal(
      longContext.attachAnthropicLongContextBeta(options, {
        providerId: "claude_code",
        baseUrl,
        model: makeAnthropicModel(),
      }),
      options,
      baseUrl,
    );
  }
});

test("长上下文 beta：标准窗口/OAuth/非 anthropic api 一律不改写", () => {
  const standardWindow = { apiKey: "sk-relay-key", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(standardWindow, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({ contextWindow: 200_000 }),
    }),
    standardWindow,
  );

  // OAuth：pi-ai 注入 claude-code/oauth beta 组合，覆盖会破坏鉴权；官方 GA 后
  // OAuth 也无需该头。
  const oauth = { apiKey: "sk-ant-oat01-xxx", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(oauth, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel(),
    }),
    oauth,
  );

  const gemini = { apiKey: "sk-relay-key", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(gemini, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({ api: "google-generative-ai", provider: "google" }),
    }),
    gemini,
  );

  const noModel = { apiKey: "sk-relay-key", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(noModel, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
    }),
    noModel,
  );
});

test("payload 管线：目录模型经 createModelFromConfig 后自动携带 1M beta 头", () => {
  const model = modelFactory.createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-6",
    "https://relay.example.com/v1",
  );
  const finalized = payloadPipeline.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://relay.example.com/v1",
    options: { apiKey: "sk-relay-key", headers: { "x-api-key": "sk-relay-key" } },
    model,
  });
  assert.equal(finalized.headers["anthropic-beta"], CONTEXT_1M_BETA);
  assert.equal(finalized.headers["x-api-key"], "sk-relay-key");
});

test("id 规范化：剥离 [1m] 后缀并与日期/@版本/大小写规则组合", () => {
  const candidates = anthropicModels.normalizeAnthropicModelIdCandidates(
    "Claude-Sonnet-4-6-20260101[1m]",
  );
  assert.ok(candidates.includes("claude-sonnet-4-6"));
  assert.ok(candidates.includes("claude-sonnet-4-6-20260101"));
  // 原始 id 始终是首选候选，命中目录后请求体仍用原始 id。
  assert.equal(candidates[0], "Claude-Sonnet-4-6-20260101[1m]");
});

test("wire model id：官方端点剥离 [1m]，兼容中转保留端点要求的 suffix", () => {
  const official = modelFactory.createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-6[1m]",
    "https://api.anthropic.com/v1",
    undefined,
    undefined,
    "https://api.anthropic.com/v1",
  );
  assert.equal(official.id, "claude-sonnet-4-6");
  assert.equal(official.contextWindow, 1_000_000);

  const relay = modelFactory.createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-5[1m]",
    "https://relay.example.com/v1",
    undefined,
    undefined,
    "https://relay.example.com/v1",
  );
  assert.equal(relay.id, "claude-sonnet-4-5[1m]");
  assert.equal(relay.contextWindow, 1_000_000);
});

test("有效限额：adaptive 世代保留 1M，旧世代默认钳回 200K，显式 [1m] 走中转 1M", () => {
  assert.deepEqual(anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-6"), {
    contextWindow: 1_000_000,
    maxOutputToken: 128_000,
  });
  assert.deepEqual(anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-6[1m]"), {
    contextWindow: 1_000_000,
    maxOutputToken: 128_000,
  });
  // 官方 2026-04-30 起 sonnet-4/4.5 的 context-1m beta 退役，目录 1M 是历史数值。
  assert.deepEqual(anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-5"), {
    contextWindow: 200_000,
    maxOutputToken: 64_000,
  });
  assert.deepEqual(
    anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-5[1m]", "https://relay.example.com/v1"),
    {
      contextWindow: 1_000_000,
      maxOutputToken: 64_000,
    },
  );
  assert.equal(anthropicModels.resolveAnthropicKnownModelLimits("unknown-model"), undefined);
});

test("settings 默认值：装饰 id 继承规范化目录限额，未知 id 落回 200K 默认", () => {
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-6-20260101").contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-5").contextWindow,
    200_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "some-custom-model").contextWindow,
    200_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "some-custom-model[1m]").contextWindow,
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
  assert.equal(
    settings.findProviderModelConfig(
      { models: [], type: "claude_code", baseUrl: "https://relay.example.com/v1" },
      "custom-fable-5-relay",
    ).contextWindow,
    1_000_000,
  );
});
