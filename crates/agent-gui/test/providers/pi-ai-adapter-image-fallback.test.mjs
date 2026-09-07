import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// pi-ai 适配器入口侧的工具结果图片降级。
//
// 纯文本模型（model.input 不含 "image"）下，openai-completions / openai-responses /
// google 三协议在进 pi-ai 前把工具结果里的 image 块替换成说明文字；
// anthropic-messages 刻意不做（自定义模型的 input 是保守默认值，中转背后可能
// 具备视觉）。本文件按"传给 pi-ai stream() 的 context"逐协议锁定这条口径。
// ============================================================================

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

const SCREENSHOT = "/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(16);

function buildContext() {
  return {
    systemPrompt: "You are precise.",
    messages: [
      { role: "user", content: "screenshot the page", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call_shot",
        toolName: "Browser",
        content: [
          { type: "text", text: "Screenshot captured (see image below)." },
          { type: "image", data: SCREENSHOT, mimeType: "image/jpeg" },
        ],
        details: { kind: "browser", action: "screenshot", hasScreenshot: true },
        isError: false,
        timestamp: 2,
      },
    ],
  };
}

function createModel(api, provider, input) {
  return {
    id: `${provider}-model`,
    name: `${provider}-model`,
    api,
    provider,
    baseUrl: "https://relay.example.test/v1",
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const API_MODULES = {
  "anthropic-messages": "@earendil-works/pi-ai/api/anthropic-messages",
  "openai-completions": "@earendil-works/pi-ai/api/openai-completions",
  "openai-responses": "@earendil-works/pi-ai/api/openai-responses",
  "google-generative-ai": "@earendil-works/pi-ai/api/google-generative-ai",
};

async function captureContext(model) {
  const captured = [];
  const mocks = Object.fromEntries(
    Object.values(API_MODULES).map((specifier) => [
      specifier,
      {
        stream(streamModel, context) {
          captured.push(context);
          return createSourceStream(streamModel);
        },
      },
    ]),
  );
  const loader = createTsModuleLoader({ mocks });
  const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");
  const context = buildContext();
  const stream = streamSimpleByApi(model, context, {
    apiKey: "sk-test",
    streamRetry: { disabled: true },
  });
  await stream.result();
  assert.equal(captured.length, 1, `expected exactly one pi-ai stream call for ${model.api}`);
  return { original: context, passed: captured[0] };
}

function assertDegraded(model, { original, passed }) {
  assert.notEqual(passed, original, `${model.api}: text-only model must get a rewritten context`);
  const toolResult = passed.messages[1];
  assert.ok(
    toolResult.content.every((block) => block.type === "text"),
    `${model.api}: no image blocks may reach pi-ai`,
  );
  assert.equal(toolResult.content[0].text, "Screenshot captured (see image below).");
  assert.match(toolResult.content[1].text, /1 image omitted from this tool result/);
  assert.match(toolResult.content[1].text, new RegExp(`${model.id}.*does not accept image input`));
  assert.ok(!JSON.stringify(passed).includes(SCREENSHOT), `${model.api}: bytes must not leak`);
  // 调用方的 context 不被改写：UI 仍渲染图片，切到视觉模型后图片仍可发送。
  assert.equal(original.messages[1].content[1].type, "image");
}

for (const [api, provider] of [
  ["openai-completions", "openai"],
  ["openai-responses", "openai"],
  ["google-generative-ai", "google"],
]) {
  test(`${api}: text-only model gets tool-result images replaced by a notice`, async () => {
    const model = createModel(api, provider, ["text"]);
    assertDegraded(model, await captureContext(model));
  });

  test(`${api}: vision model keeps tool-result images and context identity`, async () => {
    const model = createModel(api, provider, ["text", "image"]);
    const { original, passed } = await captureContext(model);
    assert.equal(passed, original);
    assert.equal(passed.messages[1].content[1].type, "image");
  });
}

test("anthropic-messages: tool-result images pass through even when model.input is text-only", async () => {
  const model = createModel("anthropic-messages", "anthropic", ["text"]);
  const { original, passed } = await captureContext(model);
  assert.equal(passed, original);
  assert.equal(passed.messages[1].content[1].type, "image");
});
