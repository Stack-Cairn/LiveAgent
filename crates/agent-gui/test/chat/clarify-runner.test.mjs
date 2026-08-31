import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

/** streamAssistantMessage 收到的参数（按调用顺序）。 */
const calls = [];
const deltas = [];

const loader = createTsModuleLoader({
  mocks: {
    [abs("src/lib/providers/llm.ts")]: {
      streamAssistantMessage: async (params) => {
        calls.push(params);
        params.onTextDelta?.("[CLARIFY");
        params.onTextDelta?.("_QUESTION]");
        return {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "[CLARIFY_QUESTION]\nQ1" }],
        };
      },
      // 与真实实现同构：拼接 text 块（llm.ts 从 messageUtils 再导出）。
      assistantMessageToText: (message) => {
        let text = "";
        for (const block of message.content) {
          if (block.type === "text") text += block.text ?? "";
        }
        return text;
      },
    },
  },
});
const mod = loader.loadModule(abs("src/pages/chat/runtime/clarifyRunner.ts"));

test("runGuiClarifyTurn maps messages into a text-only stream call", async () => {
  const runtime = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    requestFormat: "openai",
    reasoning: "off",
    promptCachingEnabled: false,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1 },
  };
  const provider = {
    id: "p1",
    type: "openai",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    requestFormat: "openai",
    activeModels: ["m1"],
  };
  const selection = {
    selectedModel: { customProviderId: "p1", model: "m1" },
    provider,
    providerId: "openai",
    model: "m1",
  };
  const signal = new AbortController().signal;
  const out = await mod.createGuiClarifyRunner(
    () => selection,
    () => runtime,
  )(
    [
      // buildClarifyMessages（Task 1）在消息数组前置 system；pi-ai 的 Message
      // 类型没有 system 角色，runner 必须把它并入 context.systemPrompt。
      { role: "system", content: "You are a clarify assistant." },
      { role: "user", content: "hi" },
    ],
    signal,
    (delta) => deltas.push(delta),
  );
  assert.equal(out, "[CLARIFY_QUESTION]\nQ1");
  assert.deepEqual(deltas, ["[CLARIFY", "_QUESTION]"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerId, "openai");
  assert.equal(calls[0].model, "m1");
  assert.equal(calls[0].runtime, runtime);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].cacheRetention, "none");
  assert.equal(calls[0].nativeWebSearch, false);
  assert.equal(calls[0].context.systemPrompt, "You are a clarify assistant.");
  assert.equal(calls[0].context.messages.length, 1);
  assert.equal(calls[0].context.messages[0].role, "user");
  assert.equal(calls[0].context.messages[0].content, "hi");
});

test("runGuiClarifyTurn resolves selection lazily per turn", async () => {
  let model = "m1";
  const selection = {
    selectedModel: { customProviderId: "p1", model: "m1" },
    provider: {
      id: "p1",
      type: "openai",
      baseUrl: "https://api.example.com",
      apiKey: "k",
      requestFormat: "openai",
      activeModels: ["m1", "m2"],
    },
    providerId: "openai",
    get model() {
      return model;
    },
  };
  const runtime = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    requestFormat: "openai",
    reasoning: "off",
    promptCachingEnabled: false,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1 },
  };
  const runner = mod.createGuiClarifyRunner(() => selection, () => runtime);
  const run = () => runner([{ role: "user", content: "hi" }], new AbortController().signal);

  const before = calls.length;
  await run();
  assert.equal(calls[calls.length - 1].model, "m1");

  // 会话中途切模型：getter 惰性求值，下一轮澄清直接用新选择。
  model = "m2";
  await run();
  assert.equal(calls[calls.length - 1].model, "m2");
  assert.equal(calls.length - before, 2);
});
