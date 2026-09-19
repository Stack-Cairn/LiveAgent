// 设计文档 §6.3：模型级请求参数覆盖（归一化、按接口白名单、落到 stream options）。
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("@liveagent/ui/lib/settings/index.ts");
const parameters = loader.loadModule("@liveagent/ui/lib/models/modelParameters.ts");
const requestOptions = loader.loadModule("src/lib/providers/runtime/requestOptions.ts");

test("PROTOCOL_PARAMETER_KEYS 只放运行时会透传的键", () => {
  // temperature / maxTokens 是 pi-ai StreamOptions 的具名字段，四类接口都读。
  for (const protocol of [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]) {
    assert.ok(parameters.PROTOCOL_PARAMETER_KEYS[protocol].includes("temperature"), protocol);
    assert.ok(parameters.PROTOCOL_PARAMETER_KEYS[protocol].includes("maxTokens"), protocol);
  }
  // topP 只能经 samplingParams 走，而 samplingParams 只被 OpenAI 兼容适配器读取。
  assert.deepEqual(parameters.PROTOCOL_PARAMETER_KEYS["openai-completions"].includes("topP"), true);
  assert.deepEqual(parameters.PROTOCOL_PARAMETER_KEYS["openai-responses"].includes("topP"), true);
  assert.deepEqual(parameters.PROTOCOL_PARAMETER_KEYS["anthropic-messages"].includes("topP"), false);
  assert.deepEqual(
    parameters.PROTOCOL_PARAMETER_KEYS["google-generative-ai"].includes("topP"),
    false,
  );
  // stop sequences 在 pi-ai 0.84.2 的这四类接口上没有通路，不收录。
  assert.deepEqual([...parameters.MODEL_PARAMETER_KEYS].sort(), [
    "maxTokens",
    "temperature",
    "topP",
  ]);
});

test("normalizeModelParameters 做范围校验并丢弃未知键", () => {
  const ok = parameters.normalizeModelParameters(
    { temperature: 0.7, topP: 0.95, maxTokens: 2048, frequency_penalty: 1 },
    { maxOutputToken: 8192 },
  );
  assert.deepEqual(ok, { temperature: 0.7, topP: 0.95, maxTokens: 2048 });

  // 越界项单独丢弃，其余保留。
  assert.deepEqual(
    parameters.normalizeModelParameters({ temperature: 3, topP: 0.5 }),
    { topP: 0.5 },
  );
  assert.deepEqual(parameters.normalizeModelParameters({ topP: 2 }), undefined);
  // maxTokens 必须是正整数，且不得超过模型输出上限。
  assert.deepEqual(parameters.normalizeModelParameters({ maxTokens: 0 }), undefined);
  assert.deepEqual(parameters.normalizeModelParameters({ maxTokens: 12.9 }), { maxTokens: 12 });
  assert.deepEqual(
    parameters.normalizeModelParameters({ maxTokens: 9000 }, { maxOutputToken: 8192 }),
    undefined,
  );
  // 非对象 / 空对象 = 未设置。
  assert.equal(parameters.normalizeModelParameters(undefined), undefined);
  assert.equal(parameters.normalizeModelParameters([1, 2]), undefined);
  assert.equal(parameters.normalizeModelParameters({}), undefined);
});

test("resolveModelParametersForProtocol 按接口过滤并钳制", () => {
  const stored = { temperature: 1.6, topP: 0.9, maxTokens: 4096 };
  assert.deepEqual(
    parameters.resolveModelParametersForProtocol("openai-responses", stored, 8192),
    { temperature: 1.6, topP: 0.9, maxTokens: 4096 },
  );
  // Anthropic：temperature 钳到 0–1，topP 整个丢掉。
  assert.deepEqual(
    parameters.resolveModelParametersForProtocol("anthropic-messages", stored, 8192),
    { temperature: 1, maxTokens: 4096 },
  );
  // maxTokens 只能更小。
  assert.deepEqual(
    parameters.resolveModelParametersForProtocol(
      "google-generative-ai",
      { maxTokens: 100_000 },
      8192,
    ),
    { maxTokens: 8192 },
  );
  assert.equal(
    parameters.resolveModelParametersForProtocol("openai-completions", undefined, 8192),
    undefined,
  );
});

test("模型配置归一化保留 parameters 并按模型输出上限校验", () => {
  const provider = settings.normalizeCustomProvider({
    id: "p",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [
      {
        id: "m1",
        contextWindow: 128_000,
        maxOutputToken: 8_192,
        limitsSource: "user",
        parameters: { temperature: 0.2, maxTokens: 4_096, nonsense: 1 },
      },
      {
        id: "m2",
        contextWindow: 128_000,
        maxOutputToken: 8_192,
        limitsSource: "user",
        parameters: { maxTokens: 999_999 },
      },
    ],
  });
  assert.deepEqual(provider.models[0].parameters, { temperature: 0.2, maxTokens: 4096 });
  // 超过模型输出上限的 maxTokens 落库时就被丢掉。
  assert.equal("parameters" in provider.models[1], false);
});

test("applyModelParameterOverrides 映射到 pi-ai stream options", () => {
  const applied = requestOptions.applyModelParameterOverrides(
    { apiKey: "k" },
    { temperature: 0.3, topP: 0.8, maxTokens: 2_000 },
    8_192,
  );
  assert.equal(applied.temperature, 0.3);
  assert.equal(applied.maxTokens, 2_000);
  // topP 没有具名字段，只能进 samplingParams.top_p。
  assert.deepEqual(applied.samplingParams, { top_p: 0.8 });

  // maxTokens 只能更小：超过模型输出上限时钳住。
  assert.equal(
    requestOptions.applyModelParameterOverrides({}, { maxTokens: 99_999 }, 8_192).maxTokens,
    8_192,
  );
  // 调用方已给的 temperature 优先（辅助请求自带的不被模型级覆盖顶掉）。
  assert.equal(
    requestOptions.applyModelParameterOverrides({ temperature: 0 }, { temperature: 0.9 }).temperature,
    0,
  );
  // 无覆盖时原样返回。
  const untouched = { apiKey: "k" };
  assert.equal(requestOptions.applyModelParameterOverrides(untouched, undefined), untouched);
});
