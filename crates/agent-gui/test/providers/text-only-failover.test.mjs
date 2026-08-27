import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const piAiEventStream = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
    import.meta.url,
  ).href
);

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

/** Streams issued through the mocked streamSimpleByApi, in call order. */
const streamCalls = [];
/** Per-test stream factory keyed off the target model's baseUrl. */
let streamImpl = () => {
  throw new Error("streamImpl was not configured for this test");
};

const loader = createTsModuleLoader({
  mocks: {
    [abs("src/lib/providers/runtime/streamByApi.ts")]: {
      streamSimpleByApi: (model, context, options) => {
        streamCalls.push({ model, context, options });
        return streamImpl(model, context, options);
      },
    },
    [abs("src/lib/providers/runtime/requestOptions.ts")]: {
      prepareProviderRequest: async (providerId, runtime) => ({
        baseUrl: runtime.baseUrl,
        headers: { "x-test-provider": providerId },
      }),
      buildProviderRequestMetadata: () => undefined,
      resolveProviderCacheRetention: () => undefined,
      toSimpleStreamReasoning: () => undefined,
    },
    [abs("src/lib/providers/runtime/modelFactory.ts")]: {
      // Deterministic identity carrying baseUrl so tests can tell targets apart.
      createModelFromConfig: (providerId, modelId, baseUrl) => ({
        api: "anthropic-messages",
        provider: providerId,
        id: modelId,
        baseUrl,
      }),
    },
    [abs("src/lib/providers/runtime/payloadPipeline.ts")]: {
      finalizeProviderStreamOptions: ({ options }) => options,
    },
    [abs("src/lib/system/powerActivity.ts")]: {
      withPowerActivity: (_scope, _reason, run) => run(),
    },
    [abs("src/lib/debug/agentDebug.ts")]: {
      buildStreamRequestDebugPayload: () => ({}),
    },
    [abs("src/lib/providers/hostedSearchEvents.ts")]: {
      createHostedSearchProbeId: () => undefined,
      withHostedSearchProbeHeader: (headers) => headers ?? {},
      startHostedSearchFetchProbe: () => ({ finish: async () => {} }),
      createHostedSearchEventAggregator: () => ({
        accept: () => {},
        complete: () => [],
        fail: () => {},
        dispose: () => {},
        getBlocks: () => [],
      }),
    },
  },
});

const { streamAssistantMessage } = loader.loadModule(
  "src/lib/providers/runtime/textOnlyRuntime.ts",
);
const { resetFailoverBreakers } = loader.loadModule(
  "src/lib/providers/runtime/providerFailover.ts",
);

const FAILOVER_CONFIG = { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 };

function makeRuntime(baseUrl) {
  return {
    baseUrl,
    apiKey: "test-key",
    promptCachingEnabled: false,
  };
}

function makeAssistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "claude_code",
    model: "claude-x",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeSourceStream(events) {
  const stream = piAiEventStream.createAssistantMessageEventStream();
  for (const event of events) {
    stream.push(event);
  }
  return stream;
}

function successStream(text) {
  const message = makeAssistantMessage({ content: [{ type: "text", text }] });
  return makeSourceStream([
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "done", reason: "stop", message },
  ]);
}

function uncommittedErrorStream(errorMessage) {
  const message = makeAssistantMessage({ stopReason: "error", errorMessage });
  return makeSourceStream([
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ]);
}

function committedErrorStream(text, errorMessage) {
  const message = makeAssistantMessage({ stopReason: "error", errorMessage });
  return makeSourceStream([
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "error", reason: "error", error: message },
  ]);
}

function makeFailoverParams(overrides = {}) {
  return {
    config: FAILOVER_CONFIG,
    primary: {
      selectedModel: { customProviderId: "p1", model: "claude-x" },
      label: "P1 · claude-x",
    },
    fallbacks: [
      {
        selectedModel: { customProviderId: "p2", model: "claude-x" },
        providerId: "claude_code",
        model: "claude-x",
        label: "P2 · claude-x",
        runtime: makeRuntime("https://fallback.example"),
      },
    ],
    ...overrides,
  };
}

function baseParams(overrides = {}) {
  return {
    providerId: "claude_code",
    model: "claude-x",
    runtime: makeRuntime("https://primary.example"),
    context: { messages: [] },
    onTextDelta: () => {},
    ...overrides,
  };
}

test.beforeEach(() => {
  resetFailoverBreakers();
  streamCalls.length = 0;
});

test("text mode fails over to the queued provider before content commits", async () => {
  streamImpl = (model) =>
    model.baseUrl === "https://primary.example"
      ? uncommittedErrorStream("503 service unavailable")
      : successStream("fallback-answer");

  const deltas = [];
  const switched = [];
  const failovers = [];
  const final = await streamAssistantMessage(
    baseParams({
      onTextDelta: (delta) => deltas.push(delta),
      failover: makeFailoverParams({
        onSwitched: (event) => switched.push(event),
        onFailover: (event) => failovers.push(event),
      }),
    }),
  );

  assert.equal(final.content[0].text, "fallback-answer");
  // The discarded primary attempt must stay invisible to the consumer.
  assert.deepEqual(deltas, ["fallback-answer"]);
  assert.equal(failovers.length, 1);
  assert.equal(failovers[0].fromLabel, "P1 · claude-x");
  assert.equal(failovers[0].toLabel, "P2 · claude-x");
  assert.match(failovers[0].errorMessage, /503/);
  assert.equal(switched.length, 1);
  assert.equal(switched[0].target?.selectedModel.customProviderId, "p2");
  assert.equal(streamCalls.length, 2);
  assert.equal(streamCalls[1].model.baseUrl, "https://fallback.example");
});

test("text mode surfaces errors after content committed without switching", async () => {
  streamImpl = (model) =>
    model.baseUrl === "https://primary.example"
      ? committedErrorStream("partial ", "503 mid-stream failure")
      : successStream("unused");

  const deltas = [];
  await assert.rejects(
    streamAssistantMessage(
      baseParams({
        onTextDelta: (delta) => deltas.push(delta),
        failover: makeFailoverParams(),
      }),
    ),
    /503 mid-stream failure/,
  );
  assert.deepEqual(deltas, ["partial "]);
  // Only the primary was attempted; the committed content pins the attempt.
  assert.equal(streamCalls.length, 1);
});

test("text mode never switches on client-request-class errors", async () => {
  streamImpl = (model) =>
    model.baseUrl === "https://primary.example"
      ? uncommittedErrorStream("prompt is too long: 250000 tokens")
      : successStream("unused");

  await assert.rejects(
    streamAssistantMessage(baseParams({ failover: makeFailoverParams() })),
    /prompt is too long/,
  );
  assert.equal(streamCalls.length, 1);
});

test("without failover params the stream goes straight to the primary", async () => {
  streamImpl = () => successStream("plain-answer");
  const final = await streamAssistantMessage(baseParams());
  assert.equal(final.content[0].text, "plain-answer");
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].model.baseUrl, "https://primary.example");
});

test("流内重试回调携带当前候选标签：failover 下备用供应商的重试可归属", async () => {
  streamImpl = (model) =>
    model.baseUrl === "https://primary.example"
      ? uncommittedErrorStream("503 service unavailable")
      : successStream("fallback-answer");

  const retries = [];
  await streamAssistantMessage(
    baseParams({
      onRetryStatus: (attempt, maxAttempts, errorMessage, plannedDelayMs, providerLabel) =>
        retries.push({ attempt, maxAttempts, errorMessage, plannedDelayMs, providerLabel }),
      failover: makeFailoverParams(),
    }),
  );

  // 两个候选各自的 options 必须把自己的标签绑进 streamRetry.onRetry——
  // 直接触发装配好的回调，断言标签逐候选独立而非共享同一个通用回调。
  assert.equal(streamCalls.length, 2);
  streamCalls[0].options.streamRetry.onRetry(1, 5, "boom-primary", 200);
  streamCalls[1].options.streamRetry.onRetry(2, 5, "boom-fallback", 400);
  assert.deepEqual(retries, [
    {
      attempt: 1,
      maxAttempts: 5,
      errorMessage: "boom-primary",
      plannedDelayMs: 200,
      providerLabel: "P1 · claude-x",
    },
    {
      attempt: 2,
      maxAttempts: 5,
      errorMessage: "boom-fallback",
      plannedDelayMs: 400,
      providerLabel: "P2 · claude-x",
    },
  ]);
});

test("text mode exposes the exact provider-boundary prompt before transport setup", async () => {
  streamImpl = () => successStream("answer");
  const starts = [];
  await streamAssistantMessage(
    baseParams({
      context: { systemPrompt: "BASE", messages: [] },
      onRequestStart: (info) => starts.push(info),
    }),
  );

  assert.equal(starts.length, 1);
  assert.match(starts[0].systemSuffix, /text-only mode/);
  assert.equal(starts[0].context.systemPrompt, `BASE\n\n${starts[0].systemSuffix}`);
  assert.equal(streamCalls[0].context.systemPrompt, starts[0].context.systemPrompt);
});

test("DeepSeek title-style text requests preserve explicit thinking-off and workdir", async () => {
  streamImpl = () => successStream("title");

  await streamAssistantMessage(
    baseParams({
      providerId: "deepseek",
      model: "deepseek-reasoner",
      runtime: {
        ...makeRuntime("https://api.deepseek.com/v1"),
        reasoning: "off",
      },
      workdir: "/workspace",
    }),
  );

  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].options.reasoning, undefined);
  assert.equal(streamCalls[0].options.deepSeekThinking, "disabled");
  assert.equal(streamCalls[0].options.workdir, "/workspace");
});
