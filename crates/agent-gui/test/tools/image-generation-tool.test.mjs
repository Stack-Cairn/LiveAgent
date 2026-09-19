import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 内置 generate_image 工具：模型选择优先级、无可用模型的报错、mock invoke 后的
// 落盘与返回内容块、count 上限、以及 WebUI 分支用的网关命令与形参。

const PNG_B64 = "iVBORw0KGgo=";

function createBundle({ workdir = "/workspace", settings, invokeImpl, webui = false } = {}) {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (invokeImpl) return invokeImpl(command, args);
          throw new Error(`unexpected invoke: ${command}`);
        },
      },
      "@liveagent/ui/lib/runtimeEnv": { isGatewayWebuiRuntime: () => webui },
    },
  });
  const settingsModule = loader.loadModule("src/lib/settings/index.ts");
  const tools = loader.loadModule("src/lib/tools/imageGenerationTools.ts");
  const resolved = settings(settingsModule);
  const bundle = tools.createImageGenerationTools({
    workdir,
    getSettings: () => resolved,
    // 文件名里的时间戳固定，断言才稳定。
    now: () => new Date(2026, 8, 19, 14, 5, 6),
  });
  return { bundle, tools, invocations, settings: resolved, settingsModule };
}

function relayProvider(settingsModule, extra = {}) {
  return settingsModule.normalizeCustomProvider({
    id: "p-relay",
    name: "Relay",
    type: "codex",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-relay",
    requestFormat: "openai-completions",
    models: [{ id: "gpt-4o" }, { id: "gpt-image-1" }, { id: "dall-e-3" }],
    activeModels: ["gpt-4o", "gpt-image-1", "dall-e-3"],
    ...extra,
  });
}

function geminiProvider(settingsModule, extra = {}) {
  return settingsModule.normalizeCustomProvider({
    id: "p-gemini",
    name: "Gemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "gk-1",
    models: [{ id: "gemini-3-pro-image" }],
    activeModels: ["gemini-3-pro-image"],
    ...extra,
  });
}

function call(args) {
  return { id: "call-1", name: "generate_image", arguments: args };
}

test("model selection follows argument > settings default > first available", () => {
  const { tools, settingsModule } = createBundle({
    settings: (m) => ({ customProviders: [relayProvider(m)] }),
  });
  const relay = relayProvider(settingsModule);
  const gemini = geminiProvider(settingsModule);
  const both = { customProviders: [relay, gemini] };

  // 缺省：第一个启用供应商里第一个启用的 image 类型模型（gpt-4o 是聊天模型，跳过）。
  const first = tools.selectImageGenerationModel(both);
  assert.equal(first.provider.id, "p-relay");
  assert.equal(first.modelId, "gpt-image-1");
  assert.equal(first.source, "first-available");

  // 设置里的默认模型优先于"第一个可用"。
  const withDefault = {
    ...both,
    imageGeneration: { defaultModel: { customProviderId: "p-gemini", model: "gemini-3-pro-image" } },
  };
  const fromSettings = tools.selectImageGenerationModel(withDefault);
  assert.equal(fromSettings.provider.id, "p-gemini");
  assert.equal(fromSettings.source, "settings");

  // 显式参数最优先。
  const fromArgument = tools.selectImageGenerationModel(withDefault, "p-relay:dall-e-3");
  assert.equal(fromArgument.modelId, "dall-e-3");
  assert.equal(fromArgument.source, "argument");

  // 默认模型失效（供应商停用）时回落，而不是报错。
  const disabled = {
    customProviders: [relay, geminiProvider(settingsModule, { enabled: false })],
    imageGeneration: { defaultModel: { customProviderId: "p-gemini", model: "gemini-3-pro-image" } },
  };
  assert.equal(tools.selectImageGenerationModel(disabled).source, "first-available");

  // 形参错误与指向聊天模型都要明确报错。
  assert.throws(() => tools.selectImageGenerationModel(both, "no-colon"), /providerId/);
  assert.throws(() => tools.selectImageGenerationModel(both, "p-relay:gpt-4o"), /生图模型/);
  assert.throws(() => tools.selectImageGenerationModel(both, "p-nope:gpt-image-1"), /找不到供应商/);
});

test("no enabled image model yields a directed error instead of a request", async () => {
  const { bundle, invocations, settingsModule } = createBundle({
    settings: (m) => ({
      customProviders: [
        m.normalizeCustomProvider({
          id: "p-chat",
          name: "Chat only",
          type: "codex",
          baseUrl: "https://relay.example.com/v1",
          apiKey: "sk",
          models: [{ id: "gpt-4o" }],
          activeModels: ["gpt-4o"],
        }),
      ],
    }),
  });
  void settingsModule;
  const result = await bundle.executeToolCall(call({ prompt: "a cat" }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /没有可用的生图模型/);
  assert.match(result.content[0].text, /设置 → 供应商/);
  assert.equal(invocations.length, 0);
});

test("a successful call saves every image into the workspace and returns image blocks", async () => {
  const { bundle, invocations } = createBundle({
    settings: (m) => ({ customProviders: [relayProvider(m)] }),
    invokeImpl: (command) => {
      if (command === "provider_generate_image") {
        return {
          status: 200,
          latency_ms: 4200,
          body: JSON.stringify({
            data: [
              { b64_json: PNG_B64, revised_prompt: "a very red panda" },
              { b64_json: PNG_B64 },
            ],
          }),
        };
      }
      if (command === "fs_write_text") {
        return { path: String(command), mode: "rewrite", existedBefore: false, bytesWritten: 8 };
      }
      throw new Error(`unexpected invoke: ${command}`);
    },
  });

  const result = await bundle.executeToolCall(call({ prompt: "a red panda", count: 2 }));
  assert.equal(result.isError, false);

  // 一个文本块 + 每张图一个 image 块。
  assert.equal(result.content.length, 3);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(result.content.slice(1), [
    { type: "image", data: PNG_B64, mimeType: "image/png" },
    { type: "image", data: PNG_B64, mimeType: "image/png" },
  ]);
  assert.match(result.content[0].text, /Revised prompt: a very red panda/);
  assert.match(result.content[0].text, /generated-images\/20260919-140506-1\.png/);

  // 请求：桌面命令、headers 为 [key, value] 数组、体按 OpenAI Images 拼。
  const generate = invocations.find((item) => item.command === "provider_generate_image");
  assert.equal(generate.args.url, "https://relay.example.com/v1/images/generations");
  assert.deepEqual(generate.args.body, {
    model: "gpt-image-1",
    prompt: "a red panda",
    n: 2,
  });
  assert.equal(Object.fromEntries(generate.args.headers).Authorization, "Bearer sk-relay");
  assert.equal(generate.args.timeout_ms, 120_000);

  // 落盘：两次 base64 写入，路径在工作区内，文件名带时间戳与序号。
  const writes = invocations.filter((item) => item.command === "fs_write_text");
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map((item) => item.args.path),
    ["generated-images/20260919-140506-1.png", "generated-images/20260919-140506-2.png"],
  );
  for (const write of writes) {
    assert.equal(write.args.workdir, "/workspace");
    assert.equal(write.args.encoding, "base64");
    assert.equal(write.args.content, PNG_B64);
  }

  assert.equal(result.details.kind, "generate_image");
  assert.equal(result.details.api, "openai-images");
  assert.equal(result.details.model, "gpt-image-1");
  assert.equal(result.details.modelSource, "first-available");
  assert.equal(result.details.count, 2);
});

test("count is clamped to 4 and save_to is honoured but cannot escape the workspace", async () => {
  const make = (invokeImpl) =>
    createBundle({ settings: (m) => ({ customProviders: [relayProvider(m)] }), invokeImpl });

  const { bundle, invocations } = make((command) => {
    if (command === "provider_generate_image") {
      return {
        status: 200,
        latency_ms: 10,
        body: JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
      };
    }
    return { path: "x", mode: "rewrite", existedBefore: false, bytesWritten: 8 };
  });
  await bundle.executeToolCall(call({ prompt: "x", count: 99, save_to: "art/renders/" }));
  const generate = invocations.find((item) => item.command === "provider_generate_image");
  assert.equal(generate.args.body.n, 4);
  const write = invocations.find((item) => item.command === "fs_write_text");
  assert.equal(write.args.path, "art/renders/20260919-140506-1.png");

  // 越出工作区：不写盘，直接报错。
  const escape = make((command) =>
    command === "provider_generate_image"
      ? { status: 200, latency_ms: 10, body: JSON.stringify({ data: [{ b64_json: PNG_B64 }] }) }
      : { path: "x", mode: "rewrite", existedBefore: false, bytesWritten: 8 },
  );
  const result = await escape.bundle.executeToolCall(
    call({ prompt: "x", save_to: "../../outside" }),
  );
  assert.equal(result.isError, true);
  assert.equal(
    escape.invocations.filter((item) => item.command === "fs_write_text").length,
    0,
  );
});

test("url results are downloaded before saving, and upstream errors surface classified", async () => {
  const { bundle, invocations } = createBundle({
    settings: (m) => ({ customProviders: [relayProvider(m)] }),
    invokeImpl: (command) => {
      if (command === "provider_generate_image") {
        return {
          status: 200,
          latency_ms: 10,
          body: JSON.stringify({ data: [{ url: "https://cdn.example.com/a.webp" }] }),
        };
      }
      if (command === "provider_download_image") {
        return { mime_type: "image/webp", data: PNG_B64 };
      }
      return { path: "x", mode: "rewrite", existedBefore: false, bytesWritten: 8 };
    },
  });
  const result = await bundle.executeToolCall(call({ prompt: "x", model: "p-relay:dall-e-3" }));
  assert.equal(result.isError, false);
  const download = invocations.find((item) => item.command === "provider_download_image");
  assert.equal(download.args.url, "https://cdn.example.com/a.webp");
  // 扩展名跟着下载回来的 MIME 走。
  const write = invocations.find((item) => item.command === "fs_write_text");
  assert.equal(write.args.path, "generated-images/20260919-140506-1.webp");

  const failing = createBundle({
    settings: (m) => ({ customProviders: [relayProvider(m)] }),
    invokeImpl: () => ({ status: 401, latency_ms: 5, body: '{"error":{"message":"bad key"}}' }),
  });
  const error = await failing.bundle.executeToolCall(call({ prompt: "x" }));
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /unauthorized/);
  assert.match(error.content[0].text, /bad key/);
});

test("the WebUI branch goes through the gateway command with the redacted payload shape", async () => {
  const { bundle, invocations } = createBundle({
    webui: true,
    settings: (m) => ({ customProviders: [geminiProvider(m)] }),
    invokeImpl: (command) => {
      if (command === "gateway_provider_generate_image") {
        return {
          status: 200,
          latency_ms: 30,
          body: JSON.stringify({
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } },
            ],
          }),
        };
      }
      return { path: "x", mode: "rewrite", existedBefore: false, bytesWritten: 8 };
    },
  });
  const result = await bundle.executeToolCall(call({ prompt: "a cat" }));
  assert.equal(result.isError, false);
  assert.equal(result.details.api, "gemini");

  const generate = invocations.find((item) => item.command === "gateway_provider_generate_image");
  assert.equal(
    generate.args.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
  );
  // 网关分支的 headers 是 {key,value} 对象数组，并额外带补 Key 需要的三件套。
  assert.ok(Array.isArray(generate.args.headers));
  assert.ok(generate.args.headers.every((header) => "key" in header && "value" in header));
  assert.equal(generate.args.provider_id, "p-gemini");
  assert.equal(generate.args.protocol, "google-generative-ai");
  assert.equal(typeof generate.args.credential_id, "string");
  assert.deepEqual(generate.args.body, {
    contents: [{ parts: [{ text: "a cat" }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  });
});
