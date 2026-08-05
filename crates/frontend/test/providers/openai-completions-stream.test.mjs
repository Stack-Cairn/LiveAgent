import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

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

function createAssistant(content, errorMessage = "Stream ended without finish_reason") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "compatible-model",
    usage: createUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: 1,
  };
}

function createErrorSource(assistant, events = []) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...assistant, content: [] } };
      for (const event of events) yield event;
      yield { type: "error", reason: "error", error: assistant };
    },
    async result() {
      return assistant;
    },
  };
}

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function createModel() {
  return {
    id: "compatible-model",
    name: "compatible-model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "http://127.0.0.1:18080/proxy/codex/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

test("openai-completions: compatible endpoint recovers usable text missing finish_reason", async () => {
  const assistant = createAssistant([{ type: "text", text: "complete answer" }]);
  const loader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/openai-completions": {
        stream() {
          return createErrorSource(assistant, [
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "complete answer",
              partial: assistant,
            },
            {
              type: "text_end",
              contentIndex: 0,
              content: "complete answer",
              partial: assistant,
            },
          ]);
        },
      },
    },
  });
  const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");

  const stream = streamSimpleByApi(createModel(), { messages: [] }, {
    recoverMissingFinishReason: true,
    streamRetry: { disabled: true },
  });
  const events = await collectEvents(stream);
  const result = await stream.result();

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_delta", "text_end", "done"],
  );
  assert.equal(result.stopReason, "stop");
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.content[0].text, "complete answer");
});

test("openai-completions: empty stream still fails when finish_reason is missing", async () => {
  const loader = createTsModuleLoader();
  const { recoverOpenAICompletionsMissingFinishReason } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  const assistant = createAssistant([]);
  const stream = recoverOpenAICompletionsMissingFinishReason(createErrorSource(assistant));
  const events = await collectEvents(stream);

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "error"],
  );
  assert.equal((await stream.result()).stopReason, "error");
});

test("openai-completions: unrelated errors are never recovered", async () => {
  const loader = createTsModuleLoader();
  const { recoverOpenAICompletionsMissingFinishReason } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  const assistant = createAssistant(
    [{ type: "text", text: "partial" }],
    "503 service unavailable",
  );
  const stream = recoverOpenAICompletionsMissingFinishReason(createErrorSource(assistant));
  const events = await collectEvents(stream);

  assert.equal(events.at(-1).type, "error");
  assert.equal((await stream.result()).stopReason, "error");
});

test("openai-completions: recovered tool calls retain truncation guard coverage", async () => {
  const loader = createTsModuleLoader();
  const { recoverOpenAICompletionsMissingFinishReason } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  const { wrapStreamWithToolCallArgumentGuard } = loader.loadModule(
    "src/lib/chat/runner/toolCallArgumentGuard.ts",
  );
  const toolCall = {
    type: "toolCall",
    id: "call_1",
    name: "read_file",
    arguments: { path: "/tmp" },
  };
  const assistant = createAssistant([toolCall]);
  const source = createErrorSource(assistant, [
    { type: "toolcall_start", contentIndex: 0, partial: assistant },
    {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"/tmp',
      partial: assistant,
    },
    { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant },
  ]);
  const incomplete = [];
  const recovered = recoverOpenAICompletionsMissingFinishReason(source);
  const guarded = wrapStreamWithToolCallArgumentGuard(recovered, (call, reason) => {
    incomplete.push({ call, reason });
  });
  const events = await collectEvents(guarded);
  const result = await guarded.result();

  assert.equal(events.at(-1).type, "done");
  assert.equal(result.stopReason, "toolUse");
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].call.id, "call_1");
  assert.match(incomplete[0].reason, /before it was complete/);
});

test("openai-completions: compatibility is enabled only for non-official endpoints", () => {
  const loader = createTsModuleLoader();
  const { finalizeProviderStreamOptions } = loader.loadModule(
    "src/lib/providers/runtime/payloadPipeline.ts",
  );
  const model = createModel();

  const compatible = finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://relay.example.com/v1",
    options: {},
    model,
  });
  const official = finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    options: {},
    model,
  });
  const explicitStrict = finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://relay.example.com/v1",
    options: { recoverMissingFinishReason: false },
    model,
  });

  assert.equal(compatible.recoverMissingFinishReason, true);
  assert.equal(official.recoverMissingFinishReason, undefined);
  assert.equal(explicitStrict.recoverMissingFinishReason, false);
});
