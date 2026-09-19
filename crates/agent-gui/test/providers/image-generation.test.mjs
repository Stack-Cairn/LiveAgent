import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 图像生成的请求装配：两条 API 的地址与请求体、`{origin}` 展开、路由选择
// （Gemini 端点 vs 中转的 OpenAI 家族端点）、两种 OpenAI 响应形态、Gemini
// inlineData 解析与错误归类。
const loader = createTsModuleLoader();
const imageGeneration = loader.loadModule("@liveagent/ui/lib/providers/imageGeneration.ts");
const modelType = loader.loadModule("@liveagent/ui/lib/models/modelType.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

function provider(extra = {}) {
  return settings.normalizeCustomProvider({
    id: "p-image",
    name: "Relay",
    type: "codex",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-relay",
    requestFormat: "openai-completions",
    models: [{ id: "gpt-image-1" }, { id: "gemini-3-pro-image" }, { id: "dall-e-3" }],
    activeModels: ["gpt-image-1", "gemini-3-pro-image", "dall-e-3"],
    ...extra,
  });
}

function geminiProvider(extra = {}) {
  return settings.normalizeCustomProvider({
    id: "p-gemini",
    name: "Gemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "gk-1",
    models: [{ id: "gemini-3-pro-image" }, { id: "imagen-4.0-fast" }],
    activeModels: ["gemini-3-pro-image", "imagen-4.0-fast"],
    ...extra,
  });
}

test("image generation URLs replace the chat action segment on both APIs", () => {
  const openai = imageGeneration.buildOpenAIImagesUrl;
  assert.equal(openai("https://api.openai.com/v1"), "https://api.openai.com/v1/images/generations");
  // 没有版本段时补 /v1；已有版本段（含 /api/paas/v4）不再补。
  assert.equal(openai("https://relay.example.com"), "https://relay.example.com/v1/images/generations");
  assert.equal(
    openai("https://open.bigmodel.cn/api/paas/v4"),
    "https://open.bigmodel.cn/api/paas/v4/images/generations",
  );
  // 端点已指到聊天动作段：退回接口根再换成 /images/generations。
  assert.equal(
    openai("https://relay.example.com/v1/chat/completions"),
    "https://relay.example.com/v1/images/generations",
  );
  assert.equal(
    openai("https://relay.example.com/v1/responses/"),
    "https://relay.example.com/v1/images/generations",
  );
  // 幂等：已经是生图地址不会叠加。
  assert.equal(
    openai("https://relay.example.com/v1/images/generations"),
    "https://relay.example.com/v1/images/generations",
  );
  assert.equal(openai("   "), "");

  const gemini = imageGeneration.buildGeminiGenerateContentUrl;
  assert.equal(
    gemini("https://generativelanguage.googleapis.com/v1beta", "gemini-3-pro-image"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
  );
  assert.equal(
    gemini("https://relay.example.com", "gemini-2.5-flash-image"),
    "https://relay.example.com/v1beta/models/gemini-2.5-flash-image:generateContent",
  );
  // 端点已指到某个模型：退回 /models 之前再按当前模型重拼，models/ 前缀剥掉。
  assert.equal(
    gemini("https://relay.example.com/v1beta/models/old:generateContent", "models/gemini-3-pro-image"),
    "https://relay.example.com/v1beta/models/gemini-3-pro-image:generateContent",
  );
  assert.equal(gemini("", "x"), "");
});

test("route selection prefers the Gemini endpoint for Gemini models and falls back to OpenAI Images", () => {
  // 原生 Gemini 渠道上的 Gemini 生图模型 → generateContent。
  const gemini = imageGeneration.resolveImageGenerationRoute(
    geminiProvider(),
    "gemini-3-pro-image",
    { apiKey: "gk-1" },
  );
  assert.equal(gemini.kind, "gemini");
  assert.equal(
    gemini.requestUrl,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
  );
  assert.equal(gemini.headers["x-goog-api-key"], "gk-1");

  // imagen 也算 Gemini 系列。
  assert.equal(
    imageGeneration.resolveImageGenerationRoute(geminiProvider(), "imagen-4.0-fast").kind,
    "gemini",
  );

  // 中转（只有 OpenAI 家族端点）上的 gpt-image → Images 接口。
  const relay = imageGeneration.resolveImageGenerationRoute(provider(), "gpt-image-1", {
    apiKey: "sk-relay",
  });
  assert.equal(relay.kind, "openai-images");
  assert.equal(relay.requestUrl, "https://relay.example.com/v1/images/generations");
  assert.equal(relay.headers.Authorization, "Bearer sk-relay");
  assert.equal(relay.protocol, "openai-completions");

  // 同一个中转上挂的 Gemini 生图模型：没有 google-generative-ai 端点，退回 Images。
  assert.equal(
    imageGeneration.resolveImageGenerationRoute(provider(), "gemini-3-pro-image").kind,
    "openai-images",
  );

  // 只有 Anthropic Messages 的供应商：两条路都不通。
  const anthropicOnly = settings.normalizeCustomProvider({
    id: "p-anthropic",
    name: "Claude",
    type: "claude_code",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant",
    models: [{ id: "gpt-image-1" }],
    activeModels: ["gpt-image-1"],
  });
  assert.equal(
    imageGeneration.resolveImageGenerationRoute(anthropicOnly, "gpt-image-1"),
    undefined,
  );
});

test("route resolution expands {origin} endpoint templates", () => {
  const withOrigin = settings.normalizeCustomProvider({
    id: "p-origin",
    name: "Mirror",
    type: "codex",
    baseUrl: "{origin}/v1",
    apiKey: "sk-origin",
    requestFormat: "openai-completions",
    origins: [
      { id: "cn", url: "https://cn.example.com", enabled: true },
      { id: "global", url: "https://global.example.com", enabled: true },
    ],
    models: [{ id: "gpt-image-1" }],
    activeModels: ["gpt-image-1"],
  });
  const route = imageGeneration.resolveImageGenerationRoute(withOrigin, "gpt-image-1");
  assert.equal(route.requestUrl, "https://cn.example.com/v1/images/generations");
});

test("request bodies match each API and clamp the image count", () => {
  const relay = imageGeneration.resolveImageGenerationRoute(provider(), "gpt-image-1");
  const request = imageGeneration.buildImageGenerationRequest(relay, {
    prompt: "a red panda",
    count: 9,
    size: "1536x1024",
    quality: "high",
  });
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://relay.example.com/v1/images/generations");
  // gpt-image-* 不接受 response_format（官方回 400），其余模型要显式要 b64。
  assert.deepEqual(request.body, {
    model: "gpt-image-1",
    prompt: "a red panda",
    n: 4,
    size: "1536x1024",
    quality: "high",
  });

  const dalle = imageGeneration.resolveImageGenerationRoute(provider(), "dall-e-3");
  assert.deepEqual(
    imageGeneration.buildImageGenerationRequest(dalle, { prompt: "a cat" }).body,
    { model: "dall-e-3", prompt: "a cat", n: 1, response_format: "b64_json" },
  );

  const gemini = imageGeneration.resolveImageGenerationRoute(
    geminiProvider(),
    "gemini-3-pro-image",
  );
  // Gemini 没有 n / size / quality，只声明 responseModalities。
  assert.deepEqual(
    imageGeneration.buildImageGenerationRequest(gemini, { prompt: "a cat", count: 3, size: "1024x1024" })
      .body,
    {
      contents: [{ parts: [{ text: "a cat" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    },
  );

  assert.equal(imageGeneration.clampImageCount(undefined), 1);
  assert.equal(imageGeneration.clampImageCount(0), 1);
  assert.equal(imageGeneration.clampImageCount(2.7), 2);
  assert.equal(imageGeneration.clampImageCount(99), 4);
});

test("OpenAI responses parse both b64_json and url results", () => {
  const b64 = imageGeneration.parseImageGenerationResponse(
    "openai-images",
    200,
    JSON.stringify({
      data: [
        { b64_json: "AAAA", revised_prompt: "a very red panda" },
        { b64_json: "BBBB" },
      ],
    }),
  );
  assert.equal(b64.ok, true);
  assert.equal(b64.images.length, 2);
  assert.deepEqual(b64.images[0], { mimeType: "image/png", base64: "AAAA" });
  assert.equal(b64.revisedPrompt, "a very red panda");

  const url = imageGeneration.parseImageGenerationResponse(
    "openai-images",
    200,
    JSON.stringify({ data: [{ url: "https://cdn.example.com/a.png" }] }),
  );
  assert.equal(url.ok, true);
  assert.deepEqual(url.images, [
    { mimeType: "image/png", remoteUrl: "https://cdn.example.com/a.png" },
  ]);

  // 2xx 但没有图片数据：算无效响应，不能当成功。
  const empty = imageGeneration.parseImageGenerationResponse(
    "openai-images",
    200,
    JSON.stringify({ data: [] }),
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.kind, "invalidResponse");
});

test("Gemini responses parse inlineData parts and keep the narration text", () => {
  const result = imageGeneration.parseImageGenerationResponse(
    "gemini",
    200,
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: "Here is your panda." },
              { inlineData: { mimeType: "image/webp", data: "CCCC" } },
            ],
          },
        },
      ],
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.images, [{ mimeType: "image/webp", base64: "CCCC" }]);
  assert.deepEqual(result.texts, ["Here is your panda."]);

  // 中转按 proto 命名回 inline_data / mime_type 也要认。
  const snake = imageGeneration.parseImageGenerationResponse(
    "gemini",
    200,
    JSON.stringify({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: "DD" } }] } }],
    }),
  );
  assert.deepEqual(snake.images, [{ mimeType: "image/png", base64: "DD" }]);

  // 只有文本、没有图片（内容被拦）：失败并带上模型的说明。
  const textOnly = imageGeneration.parseImageGenerationResponse(
    "gemini",
    200,
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "I can't do that." }] } }] }),
  );
  assert.equal(textOnly.ok, false);
  assert.equal(textOnly.kind, "invalidResponse");
  assert.equal(textOnly.error, "I can't do that.");
});

test("error classification mirrors the model connectivity check", () => {
  const parse = (status, body) =>
    imageGeneration.parseImageGenerationResponse("openai-images", status, body);
  assert.equal(parse(401, '{"error":{"message":"bad key"}}').kind, "unauthorized");
  assert.equal(parse(403, "{}").kind, "unauthorized");
  assert.equal(parse(404, '{"error":"no such model"}').kind, "notFound");
  assert.equal(parse(404, '{"error":"no such model"}').error, "no such model");
  assert.equal(parse(429, "{}").kind, "rateLimited");
  assert.equal(parse(500, "boom").kind, "http");
  assert.equal(parse(500, "boom").error, "boom");
  assert.equal(parse(200, "not json").kind, "invalidResponse");
  // 200 里包着错误对象（部分中转的写法）：按 http 错误处理。
  const wrapped = parse(200, '{"error":{"message":"quota exceeded"}}');
  assert.equal(wrapped.ok, false);
  assert.equal(wrapped.kind, "http");
  assert.equal(wrapped.error, "quota exceeded");
});

test("resolveModelType prefers the user override, then the catalog, then the id heuristic", () => {
  const p = provider();
  // 目录命中 gpt-image-1（outputModalities 含 image）。
  assert.deepEqual(modelType.resolveModelType(p, "gpt-image-1"), {
    type: "image",
    source: "catalog",
  });
  // 目录没有的中转生图模型：按 id 启发式。
  assert.deepEqual(modelType.resolveModelType(p, "flux-1.1-pro"), {
    type: "image",
    source: "heuristic",
  });
  assert.equal(modelType.resolveModelType(p, "gpt-4o").type, "chat");
  // 视觉理解模型不能被误判成生图。
  assert.equal(modelType.resolveModelType(p, "qwen-vl-max").type, "chat");

  const overridden = settings.normalizeCustomProvider({
    id: "p-override",
    name: "R",
    type: "codex",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "k",
    models: [
      { id: "gpt-image-1", modelType: "chat" },
      { id: "my-custom-renderer", modelType: "image" },
    ],
    activeModels: ["gpt-image-1", "my-custom-renderer"],
  });
  assert.deepEqual(modelType.resolveModelType(overridden, "gpt-image-1"), {
    type: "chat",
    source: "user",
  });
  assert.deepEqual(modelType.resolveModelType(overridden, "my-custom-renderer"), {
    type: "image",
    source: "user",
  });
  assert.deepEqual(modelType.listImageGenerationModels(overridden), ["my-custom-renderer"]);
});
