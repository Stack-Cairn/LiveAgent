import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("conversation title job disables thinking, caching, and native web search", async () => {
  const rootLoader = createTsModuleLoader();
  const llmModulePath = rootLoader.resolveLocal("src/lib/providers/llm.ts");
  let capturedParams = null;
  const llmMock = {
    assistantMessageToText: (assistant) => assistant.text,
    streamAssistantMessage: async (params) => {
      capturedParams = params;
      params.onTextDelta("Fast title");
      return { text: "Fast title" };
    },
    toModelValue: (customProviderId, model) => `${customProviderId}::${model}`,
  };
  const loader = createTsModuleLoader({
    mocks: {
      "../../../lib/providers/llm": llmMock,
      [llmModulePath]: llmMock,
    },
  });
  const { buildConversationTitleRuntime, startConversationTitleJob } = loader.loadModule(
    "src/pages/chat/runtime/conversationTitleJob.ts",
  );
  const runtime = {
    baseUrl: "https://example.test",
    apiKey: "secret",
    requestFormat: "openai-responses",
    reasoning: "xhigh",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: true,
    modelConfig: { id: "gpt-5", reasoning: true },
  };

  assert.deepEqual(buildConversationTitleRuntime(runtime), {
    ...runtime,
    reasoning: "off",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
  });

  const historyItemsById = new Map([
    [
      "conversation-1",
      {
        id: "conversation-1",
        title: "新会话",
        updatedAt: 1,
        isPending: true,
      },
    ],
  ]);
  const sidebarStore = {
    peek: (conversationId) => historyItemsById.get(conversationId),
    upsertLocal: (conversation) => {
      historyItemsById.set(conversation.id, conversation);
    },
  };
  const titleJobRef = { current: null };
  const forwardedTitles = [];

  const title = await startConversationTitleJob({
    providerId: "codex",
    model: "gpt-5",
    runtime,
    signal: new AbortController().signal,
    conversationId: "conversation-1",
    titleSourceText: "Please build a fast settings drawer.",
    content: "Please build a fast settings drawer.",
    sidebarStore,
    titleJobRef,
    gatewayBridgeEvents: {
      queueTitle: (nextTitle) => forwardedTitles.push(nextTitle),
    },
  });

  assert.equal(title, "Fast title");
  assert.equal(runtime.reasoning, "xhigh");
  assert.equal(runtime.promptCachingEnabled, true);
  assert.equal(runtime.nativeWebSearchEnabled, true);
  assert.equal(capturedParams.runtime.reasoning, "off");
  assert.equal(capturedParams.runtime.promptCachingEnabled, false);
  assert.equal(capturedParams.runtime.nativeWebSearchEnabled, false);
  assert.equal(capturedParams.nativeWebSearch, false);
  assert.equal(capturedParams.cacheRetention, "none");
  assert.equal(historyItemsById.get("conversation-1").title, "Fast title");
  assert.equal(forwardedTitles[0], "Fast title");
});
