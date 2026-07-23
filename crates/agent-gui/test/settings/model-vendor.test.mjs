import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const modelVendor = loader.loadModule("src/lib/providers/modelVendor.ts");

test("resolveModelVendor covers supported model id prefixes", () => {
  const cases = [
    ["gpt-5", "OpenAI"],
    ["o1-preview", "OpenAI"],
    ["o3", "OpenAI"],
    ["o4-mini", "OpenAI"],
    ["chatgpt-4o-latest", "OpenAI"],
    ["dall-e-3", "OpenAI"],
    ["text-embedding-3-small", "OpenAI"],
    ["claude-opus-4-6", "Anthropic"],
    ["gemini-2.5-pro", "Google"],
    ["gemma-3", "Google"],
    ["qwen3-coder", "Qwen"],
    ["qwq-32b", "Qwen"],
    ["qvq-max", "Qwen"],
    ["deepseek-r1", "DeepSeek"],
    ["glm-4.5", "智谱"],
    ["chatglm3-6b", "智谱"],
    ["kimi-k2", "Moonshot"],
    ["moonshot-v1-128k", "Moonshot"],
    ["doubao-seed-1.6", "字节豆包"],
    ["llama-4-maverick", "Meta"],
    ["mistral-large", "Mistral"],
    ["mixtral-8x7b", "Mistral"],
    ["codestral-latest", "Mistral"],
    ["grok-4", "xAI"],
    ["minimax-m2", "MiniMax"],
    ["abab6.5s-chat", "MiniMax"],
    ["ernie-4.5", "百度"],
    ["hunyuan-t1", "腾讯"],
    ["yi-large", "零一万物"],
  ];

  for (const [id, expected] of cases) {
    assert.equal(modelVendor.resolveModelVendor({ id }), expected, id);
  }
});

test("resolveModelVendor ignores case and common model path prefixes", () => {
  assert.equal(
    modelVendor.resolveModelVendor({ id: "providers/google/models/GEMINI-2.5-PRO" }),
    "Google",
  );
  assert.equal(modelVendor.resolveModelVendor({ id: "MODELS/CLAUDE-OPUS-4-6" }), "Anthropic");
});

test("resolveModelVendor falls back to ownedBy and leaves unknown models in other", () => {
  assert.equal(
    modelVendor.resolveModelVendor({ id: "relay-premium", ownedBy: "Anthropic" }),
    "Anthropic",
  );
  assert.equal(
    modelVendor.resolveModelVendor({ id: "relay-legacy", ownedBy: " ", owned_by: "Anthropic" }),
    "Anthropic",
  );
  assert.equal(
    modelVendor.resolveModelVendor({ id: "relay-coder", ownedBy: "alibaba-cloud" }),
    "Qwen",
  );
  assert.equal(modelVendor.resolveModelVendor({ id: "relay-unknown", ownedBy: "Acme" }), "其他");
  assert.equal(modelVendor.resolveModelVendor({ id: "unknown-model" }), "其他");
});

test("sortModelsByVendor sorts groups by size, ids Z to A, and other last", () => {
  const sorted = modelVendor.sortModelsByVendor([
    { id: "unknown-z" },
    { id: "gpt-z" },
    { id: "claude-z" },
    { id: "gemini-z" },
    { id: "unknown-a" },
    { id: "claude-a" },
    { id: "gpt-a" },
    { id: "relay-anthropic", ownedBy: "anthropic" },
    { id: "gemini-a" },
    { id: "unknown-m" },
    { id: "unknown-b" },
  ]);

  assert.deepEqual(
    sorted.map((model) => model.id),
    [
      "relay-anthropic",
      "claude-z",
      "claude-a",
      "gpt-z",
      "gpt-a",
      "gemini-z",
      "gemini-a",
      "unknown-z",
      "unknown-m",
      "unknown-b",
      "unknown-a",
    ],
  );
});

test("sortModelsByActiveStateAndVendor puts active models first before vendor sorting", () => {
  const sorted = modelVendor.sortModelsByActiveStateAndVendor(
    [
      { id: "unknown-active" },
      { id: "claude-z" },
      { id: "gpt-a" },
      { id: "claude-a" },
      { id: "gpt-z" },
      { id: "gemini-z" },
    ],
    new Set(["unknown-active", "gpt-a", "gpt-z"]),
  );

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["gpt-z", "gpt-a", "unknown-active", "claude-z", "claude-a", "gemini-z"],
  );
});
