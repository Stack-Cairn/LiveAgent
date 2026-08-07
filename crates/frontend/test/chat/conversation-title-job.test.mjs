import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 标题生成已下沉引擎（crates/core）：这套用例驱动 core 的
// generateConversationTitle，前端侧只剩一条委托（见文末）。
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);

const provider = {
  id: "provider-1",
  type: "codex",
  baseUrl: "https://example.test",
  apiKey: "secret",
  requestFormat: "openai-responses",
  activeModels: ["gpt-5"],
};

const baseSettings = {
  locale: "en-US",
  selectedModel: { customProviderId: "provider-1", model: "gpt-5" },
  customProviders: [provider],
  chatRuntimeControls: {},
  customSettings: { conversationTitleModel: null },
};

function loadCoreTitleModule({ settings, streamImpl }) {
  const rootLoader = createTsModuleLoader();
  const captured = {};
  const loader = createTsModuleLoader({
    mocks: {
      [rootLoader.resolveLocal(coreSrc("settings/storage.ts"))]: {
        loadPersistedSettingsWithDefaults: async () => ({ settings }),
      },
      [rootLoader.resolveLocal(coreSrc("providers/llm.ts"))]: {
        assistantMessageToText: (assistant) => assistant.text,
        createProviderRuntimeConfig: (p, model, controls) => ({
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          requestFormat: p.requestFormat,
          reasoning: "xhigh",
          promptCachingEnabled: true,
          nativeWebSearchEnabled: true,
          modelConfig: { id: model },
          controls,
        }),
        streamAssistantMessage: async (params) => {
          captured.params = params;
          return streamImpl(params);
        },
      },
      [rootLoader.resolveLocal(coreSrc("chat/runner/agentRunner.ts"))]: {
        runAssistantWithTools: async (params) => {
          captured.params = params;
          return { assistant: streamImpl(params), messages: [], emittedMessages: [] };
        },
      },
    },
  });
  const mod = loader.loadModule(coreSrc("turns/conversationTitle.ts"));
  return { mod, captured };
}

test("core title job disables thinking, caching, and native web search", async () => {
  const { mod, captured } = loadCoreTitleModule({
    settings: baseSettings,
    streamImpl: () => ({ text: "Fast title" }),
  });

  const runtime = {
    baseUrl: "https://example.test",
    apiKey: "secret",
    requestFormat: "openai-responses",
    reasoning: "xhigh",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: true,
    modelConfig: { id: "gpt-5", reasoning: true },
  };
  assert.deepEqual(mod.buildConversationTitleRuntime(runtime), {
    ...runtime,
    reasoning: "off",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
  });
  // The helper must not mutate the caller's runtime.
  assert.equal(runtime.reasoning, "xhigh");
  assert.equal(runtime.promptCachingEnabled, true);
  assert.equal(runtime.nativeWebSearchEnabled, true);

  const title = await mod.generateConversationTitle({
    titleSourceText: "Please build a fast settings drawer.",
  });

  assert.equal(title, "Fast title");
  assert.equal(captured.params.runtime.reasoning, "off");
  assert.equal(captured.params.runtime.promptCachingEnabled, false);
  assert.equal(captured.params.runtime.nativeWebSearchEnabled, false);
  assert.equal(captured.params.nativeWebSearch, false);
  assert.deepEqual(captured.params.tools, []);
  // The persisted UI locale must reach the model, not just the prompt builders.
  assert.match(captured.params.context.systemPrompt, /concise conversation titles/i);
  assert.match(captured.params.context.messages[0].content, /under 10 words/i);
});

test("core title job uses language-of-content prompt for zh-CN input", async () => {
  const { mod, captured } = loadCoreTitleModule({
    settings: { ...baseSettings, locale: "zh-CN" },
    streamImpl: () => ({ text: "很快的设置抽屉" }),
  });

  const title = await mod.generateConversationTitle({
    titleSourceText: "请帮我做一个很快的设置抽屉。",
  });

  assert.equal(title, "很快的设置抽屉");
  assert.match(captured.params.context.systemPrompt, /Match the language of the content/i);
  assert.match(captured.params.context.messages[0].content, /under 10 words/i);
});

test("core title job prefers the configured title model over the conversation model", async () => {
  const titleProvider = {
    id: "provider-2",
    type: "openai",
    baseUrl: "https://title.test",
    apiKey: "title-secret",
    requestFormat: "openai-chat",
    activeModels: ["gpt-5-mini"],
  };
  const { mod, captured } = loadCoreTitleModule({
    settings: {
      ...baseSettings,
      customProviders: [provider, titleProvider],
      customSettings: {
        conversationTitleModel: { customProviderId: "provider-2", model: "gpt-5-mini" },
      },
    },
    streamImpl: () => ({ text: "Cheap title" }),
  });

  assert.equal(await mod.generateConversationTitle({ titleSourceText: "hello" }), "Cheap title");
  assert.equal(captured.params.model, "gpt-5-mini");
  assert.equal(captured.params.providerId, "openai");
});

test("core title job returns null for blank source text without calling the model", async () => {
  const { mod, captured } = loadCoreTitleModule({
    settings: baseSettings,
    streamImpl: () => ({ text: "never" }),
  });

  assert.equal(await mod.generateConversationTitle({ titleSourceText: "   " }), null);
  assert.equal(captured.params, undefined);
});

test("frontend title job delegates to the engine command and renames the pending row", async () => {
  const rootLoader = createTsModuleLoader();
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      [rootLoader.resolveLocal("src/lib/backend/client.ts")]: {
        backendFetch: async (command, args) => {
          calls.push({ command, args });
          return { title: "Fast title" };
        },
      },
    },
  });
  const { startConversationTitleJob } = loader.loadModule(
    "src/pages/chat/runtime/conversationTitleJob.ts",
  );

  const historyItemsById = new Map([
    ["conversation-1", { id: "conversation-1", title: "新会话", updatedAt: 1, isPending: true }],
  ]);
  const sidebarStore = {
    peek: (conversationId) => historyItemsById.get(conversationId),
    upsertLocal: (conversation) => historyItemsById.set(conversation.id, conversation),
  };
  const titleJobRef = { current: null };

  const title = await startConversationTitleJob({
    signal: new AbortController().signal,
    conversationId: "conversation-1",
    titleSourceText: "Please build a fast settings drawer.",
    selectedModel: { customProviderId: "provider-1", model: "gpt-5" },
    sidebarStore,
    titleJobRef,
  });
  await titleJobRef.current.promise;

  assert.equal(title, "Fast title");
  assert.deepEqual(calls, [
    {
      command: "conversation_title_generate",
      args: {
        titleSourceText: "Please build a fast settings drawer.",
        selectedModel: { customProviderId: "provider-1", model: "gpt-5" },
      },
    },
  ]);
  assert.equal(historyItemsById.get("conversation-1").title, "Fast title");
});

test("frontend title job swallows engine failures and keeps the default title", async () => {
  const rootLoader = createTsModuleLoader();
  const loader = createTsModuleLoader({
    mocks: {
      [rootLoader.resolveLocal("src/lib/backend/client.ts")]: {
        backendFetch: async () => {
          throw new Error("engine unreachable");
        },
      },
    },
  });
  const { startConversationTitleJob } = loader.loadModule(
    "src/pages/chat/runtime/conversationTitleJob.ts",
  );

  const historyItemsById = new Map([
    ["conversation-1", { id: "conversation-1", title: "新会话", updatedAt: 1, isPending: true }],
  ]);
  const title = await startConversationTitleJob({
    signal: new AbortController().signal,
    conversationId: "conversation-1",
    titleSourceText: "anything",
    sidebarStore: {
      peek: (id) => historyItemsById.get(id),
      upsertLocal: (conversation) => historyItemsById.set(conversation.id, conversation),
    },
    titleJobRef: { current: null },
  });

  assert.equal(title, null);
  assert.equal(historyItemsById.get("conversation-1").title, "新会话");
});
