import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// LLM seam 改造（golden 基线之一）：五协议最终 wire payload 整体快照。
//
// 现有 provider 测试逐字段断言单个行为（tool_choice、缓存断点、thinking 档位…）；
// 本文件的职责不同——把每条协议"固定输入 → 完整请求体"逐字段锁死，作为后续
// seam 重构（PR-1 适配器包装 / PR-3 拦截器注册化）"行为等价"的判定基准。
// 快照有意写成显式对象字面量而非 .snapshot 文件：diff 直接可读，且杜绝
// 无意 re-record。
//
// 捕获通道：走真实 pi-ai stream()（连同 finalizeProviderStreamOptions 全部
// payload 中间件），用 onPayload 截获最终线格式后抛错中断，网络零触碰。
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

const { createModelFromConfig } = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");
const { finalizeProviderStreamOptions } = loader.loadModule(
  "src/lib/providers/runtime/payloadPipeline.ts",
);

// 固定 session id：payload 中所有会话关联字段（prompt_cache_key/metadata.user_id）
// 由它派生，保证快照确定性。
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function buildContext({ withTools = true } = {}) {
  return {
    systemPrompt: "You are a precise assistant.",
    messages: [{ role: "user", content: "hello world", timestamp: 1 }],
    ...(withTools ? { tools: TOOLS } : {}),
  };
}

/**
 * 走真实装配链（finalizeProviderStreamOptions → streamSimpleByApi → 真实
 * pi-ai stream），在 onPayload 链尾截获最终 wire payload 后中断请求。
 */
async function captureWirePayload(providerId, model, context, baseOptions) {
  let captured;
  const finalized = finalizeProviderStreamOptions({
    providerId,
    baseUrl: model.baseUrl,
    options: baseOptions,
    context,
    model,
  });
  const prevOnPayload = finalized.onPayload;
  const stream = streamSimpleByApi(model, context, {
    ...finalized,
    onPayload: async (payload, m) => {
      captured = prevOnPayload ? ((await prevOnPayload(payload, m)) ?? payload) : payload;
      throw new Error("__capture_stop__");
    },
  });
  try {
    await stream.result();
  } catch {
    // onPayload 抛错中断请求属预期。
  }
  assert.ok(captured, `expected wire payload capture for ${model.id}`);
  // JSON 往返归一化：golden 锁定的是线上 JSON 形态；值为 undefined 的键
  // （如 responses 链路的 prompt_cache_retention）序列化后不存在，不入快照。
  return JSON.parse(JSON.stringify(captured));
}

const WIRE_TOOL_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

test("golden/anthropic-messages: 官方端点完整请求体（adaptive thinking + 缓存断点 + metadata）", async () => {
  const baseUrl = "https://api.anthropic.com/v1";
  const model = createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-6",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("claude_code", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
    cacheRetention: "short",
    metadata: { user_id: SESSION_ID },
  });

  assert.deepEqual(payload, {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }],
    max_tokens: 128000,
    stream: true,
    system: [{ type: "text", text: "You are a precise assistant." }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        eager_input_streaming: true,
        input_schema: WIRE_TOOL_SCHEMA,
      },
    ],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    metadata: { user_id: SESSION_ID },
    tool_choice: { type: "auto" },
    cache_control: { type: "ephemeral" },
  });
});

test("golden/openai-completions: 中转端点完整请求体（带工具 + reasoning_effort）", async () => {
  const baseUrl = "https://relay.example.com/v1";
  const model = createModelFromConfig(
    "codex",
    "gpt-5.2",
    baseUrl,
    "openai-completions",
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("codex", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
  });

  assert.deepEqual(payload, {
    model: "gpt-5.2",
    messages: [
      { role: "system", content: "You are a precise assistant." },
      { role: "user", content: "hello world" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128000,
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: WIRE_TOOL_SCHEMA,
          strict: false,
        },
      },
    ],
    tool_choice: "auto",
    reasoning_effort: "high",
  });
});

test("golden/openai-completions: text-only 请求既不带 tools 也不带 tool_choice（严格网关 400 回归）", async () => {
  const baseUrl = "https://relay.example.com/v1";
  const model = createModelFromConfig(
    "codex",
    "gpt-5.2",
    baseUrl,
    "openai-completions",
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload(
    "codex",
    model,
    buildContext({ withTools: false }),
    { apiKey: "sk-test", toolChoice: "auto", sessionId: SESSION_ID },
  );

  assert.deepEqual(payload, {
    model: "gpt-5.2",
    messages: [
      { role: "system", content: "You are a precise assistant." },
      { role: "user", content: "hello world" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128000,
  });
});

test("golden/openai-responses: codex 官方端点完整请求体（store + prompt_cache_key + encrypted reasoning）", async () => {
  const baseUrl = "https://chatgpt.com/backend-api/codex";
  const model = createModelFromConfig(
    "codex",
    "gpt-5.2-codex",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("codex", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    sessionId: SESSION_ID,
    cacheRetention: "short",
  });

  assert.deepEqual(payload, {
    model: "gpt-5.2-codex",
    input: [
      { role: "system", content: "You are a precise assistant." },
      { role: "user", content: [{ type: "input_text", text: "hello world" }] },
    ],
    stream: true,
    prompt_cache_key: SESSION_ID,
    store: true,
    max_output_tokens: 142000,
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: WIRE_TOOL_SCHEMA,
      },
    ],
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
  });
});

test("golden/google-generative-ai: 官方端点完整请求体（thinkingLevel + functionCallingConfig）", async () => {
  const baseUrl = "https://generativelanguage.googleapis.com";
  const model = createModelFromConfig(
    "gemini",
    "gemini-3-pro-preview",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("gemini", model, buildContext(), {
    apiKey: "test-key",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
  });

  assert.deepEqual(payload, {
    model: "gemini-3-pro-preview",
    contents: [{ role: "user", parts: [{ text: "hello world" }] }],
    config: {
      maxOutputTokens: 65536,
      systemInstruction: "You are a precise assistant.",
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "Read a file",
              parametersJsonSchema: WIRE_TOOL_SCHEMA,
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    },
  });
});

test("golden/deepseek-responses: 原生适配器完整请求体（developer role + reasoning effort 直通）", async () => {
  const baseUrl = "https://api.deepseek.com";
  const model = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("deepseek", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
  });

  assert.deepEqual(payload, {
    model: "deepseek-v4-flash",
    input: [
      { role: "developer", content: "You are a precise assistant." },
      { role: "user", content: [{ type: "input_text", text: "hello world" }] },
    ],
    stream: true,
    max_output_tokens: 384000,
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: WIRE_TOOL_SCHEMA,
      },
    ],
    tool_choice: "auto",
    reasoning: { effort: "high" },
  });
});
