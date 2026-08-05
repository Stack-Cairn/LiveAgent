import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  attachXaiResponsesPayloadCompat,
  isXaiDirectBaseUrl,
  isXaiProviderTarget,
  mapUiEffortToXaiEffort,
} = loader.loadModule("src/lib/providers/runtime/xaiResponsesPayload.ts");
const { finalizeProviderStreamOptions } = loader.loadModule(
  "src/lib/providers/runtime/payloadPipeline.ts",
);

function createXaiResponsesModel(overrides = {}) {
  return {
    id: "grok-4.5",
    name: "grok-4.5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "http://127.0.0.1:18080/proxy/codex",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192,
    ...overrides,
  };
}

test("isXaiDirectBaseUrl only matches the api.x.ai host", () => {
  assert.equal(isXaiDirectBaseUrl("https://api.x.ai/v1"), true);
  assert.equal(isXaiDirectBaseUrl("https://api.x.ai"), true);
  assert.equal(isXaiDirectBaseUrl("https://API.X.AI/v1/"), true);
  assert.equal(isXaiDirectBaseUrl("api.x.ai/v1"), true);
  assert.equal(isXaiDirectBaseUrl("https://relay.example.com/api.x.ai/v1"), false);
  assert.equal(isXaiDirectBaseUrl("https://api.x.ai.evil.example.com/v1"), false);
  assert.equal(isXaiDirectBaseUrl("https://api.openai.com/v1"), false);
  assert.equal(isXaiDirectBaseUrl(""), false);
  assert.equal(isXaiDirectBaseUrl(undefined), false);
});

test("isXaiProviderTarget matches the formal xai provider type", () => {
  assert.equal(isXaiProviderTarget({ providerId: "xai", baseUrl: "https://relay.example.com/v1" }), true);
  assert.equal(
    isXaiProviderTarget({ providerId: "codex", baseUrl: "https://api.x.ai/v1" }),
    true,
  );
  assert.equal(
    isXaiProviderTarget({ providerId: "codex", baseUrl: "https://api.openai.com/v1" }),
    false,
  );
});

test("mapUiEffortToXaiEffort maps LiveAgent levels onto official Grok efforts", () => {
  assert.equal(mapUiEffortToXaiEffort("minimal", "grok-4.5"), "low");
  assert.equal(mapUiEffortToXaiEffort("low", "grok-4.5"), "low");
  assert.equal(mapUiEffortToXaiEffort("medium", "grok-4.5"), "medium");
  assert.equal(mapUiEffortToXaiEffort("high", "grok-4.5"), "high");
  assert.equal(mapUiEffortToXaiEffort("xhigh", "grok-4.5"), "xhigh");
  assert.equal(mapUiEffortToXaiEffort("max", "grok-4.5"), "high");
  assert.equal(mapUiEffortToXaiEffort("off", "grok-4.5"), undefined);
  assert.equal(mapUiEffortToXaiEffort("none", "grok-4.5"), undefined);
  assert.equal(mapUiEffortToXaiEffort("none", "grok-4.3"), "none");
  assert.equal(mapUiEffortToXaiEffort("off", "grok-4.3"), "none");
});

test("xAI responses compat strips unsupported fields and keeps mapped reasoning effort", async () => {
  const options = attachXaiResponsesPayloadCompat(
    {},
    { providerId: "codex", baseUrl: "https://api.x.ai/v1" },
  );
  const payload = await options.onPayload(
    {
      model: "grok-4.5",
      input: [],
      stream: true,
      store: true,
      background: false,
      prompt_cache_key: "session-1",
      prompt_cache_retention: "24h",
      reasoning: { effort: "minimal", summary: "auto" },
      metadata: { trace: "ok" },
      instructions: "custom instructions",
      prompt: { id: "pmpt_123" },
      service_tier: "auto",
      stream_options: { include_obfuscation: true },
      text: { verbosity: "low" },
      temperature: 0.7,
      max_output_tokens: 8_192,
      tools: [{ type: "function", name: "Bash" }],
    },
    createXaiResponsesModel(),
  );

  for (const key of [
    "store",
    "background",
    "prompt_cache_key",
    "prompt_cache_retention",
    "metadata",
    "instructions",
    "prompt",
    "service_tier",
    "stream_options",
    "text",
  ]) {
    assert.equal(Object.hasOwn(payload, key), false, `expected ${key} to be stripped`);
  }
  assert.deepEqual(payload.reasoning, { effort: "low" });
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
  assert.equal(payload.model, "grok-4.5");
  assert.equal(payload.stream, true);
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.max_output_tokens, 8_192);
  assert.deepEqual(payload.tools, [{ type: "function", name: "Bash" }]);
});

test("formal xai provider type also applies responses compat", async () => {
  const options = attachXaiResponsesPayloadCompat(
    {},
    { providerId: "xai", baseUrl: "https://relay.example.com/v1" },
  );
  const payload = await options.onPayload(
    {
      model: "grok-4.5",
      input: [],
      stream: true,
      store: true,
      reasoning: { effort: "high", summary: "auto" },
    },
    createXaiResponsesModel(),
  );
  assert.equal(Object.hasOwn(payload, "store"), false);
  assert.deepEqual(payload.reasoning, { effort: "high" });
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
});

test("xAI responses compat maps hosted tool types to include values and keeps custom includes", async () => {
  const options = attachXaiResponsesPayloadCompat(
    {},
    { providerId: "codex", baseUrl: "https://api.x.ai/v1" },
  );
  const payload = await options.onPayload(
    {
      model: "grok-4.5",
      input: [],
      stream: true,
      include: ["custom.include"],
      tools: [{ type: "x_search" }, { type: "web_search" }, { type: "code_interpreter" }],
    },
    createXaiResponsesModel(),
  );

  assert.deepEqual(payload.include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources",
    "code_interpreter_call.outputs",
    "custom.include",
  ]);
  assert.deepEqual(payload.tools, [
    { type: "x_search" },
    { type: "web_search" },
    { type: "code_interpreter" },
  ]);
});

test("xAI responses compat is a no-op for non-xAI targets and non-openai providers", () => {
  const options = {};
  assert.equal(
    attachXaiResponsesPayloadCompat(options, {
      providerId: "codex",
      baseUrl: "https://api.openai.com/v1",
    }),
    options,
  );
  assert.equal(
    attachXaiResponsesPayloadCompat(options, {
      providerId: "claude_code",
      baseUrl: "https://api.x.ai/v1",
    }),
    options,
  );
});

test("xAI responses compat leaves openai-completions payloads untouched", async () => {
  const options = attachXaiResponsesPayloadCompat(
    {},
    { providerId: "codex", baseUrl: "https://api.x.ai/v1" },
  );
  const original = {
    model: "grok-4.5",
    messages: [],
    stream: true,
    reasoning_effort: "low",
  };
  const payload = await options.onPayload(
    original,
    createXaiResponsesModel({ api: "openai-completions" }),
  );
  assert.deepEqual(payload, original);
});

test("payload pipeline turns an xAI web-search request into a sanitized hosted-tool payload", async () => {
  const options = finalizeProviderStreamOptions({
    providerId: "xai",
    baseUrl: "https://api.x.ai/v1",
    options: {},
    nativeWebSearch: true,
  });
  const payload = await options.onPayload(
    {
      model: "grok-4.5",
      input: [],
      stream: true,
      store: false,
      prompt_cache_key: "session-1",
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "Bash" }],
    },
    createXaiResponsesModel(),
  );

  assert.equal(Object.hasOwn(payload, "store"), false);
  assert.equal(Object.hasOwn(payload, "prompt_cache_key"), false);
  assert.deepEqual(payload.reasoning, { effort: "high" });
  assert.deepEqual(payload.include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources",
  ]);
  assert.deepEqual(
    payload.tools.map((tool) => tool.type),
    ["function", "web_search"],
  );
});

test("payload pipeline keeps the OpenAI responses storage behaviour for non-xAI targets", async () => {
  const options = finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    options: {},
    nativeWebSearch: false,
  });
  const payload = await options.onPayload(
    { model: "gpt-5.2", input: [], stream: true },
    createXaiResponsesModel({ id: "gpt-5.2", name: "gpt-5.2" }),
  );
  assert.equal(payload.store, true);
  assert.equal(Object.hasOwn(payload, "include"), false);
});
