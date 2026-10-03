import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// 摘要降级梯（summarize.ts）：真实装配链 + 真实 withStreamRetry，只在 pi-ai 协议
// 流处换成假流（计数即"工厂调用次数"）。主请求先经 runAssistantWithTools 真实发出
// 一次并记下配方，fork 必须与它逐字节相同、只多一条指令 user 消息。
// ============================================================================

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const importPiAi = (rel) =>
  import(new URL(`../../node_modules/@earendil-works/pi-ai/dist/${rel}`, import.meta.url).href);
const { createAssistantMessageEventStream } = await importPiAi("utils/event-stream.js");
const realAnthropic = await importPiAi("api/anthropic-messages.js");

const PROXY_SERVER_INFO = { baseUrl: "http://127.0.0.1:18080", token: "proxy-token-secret" };
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const MODEL = "claude-sonnet-4-6";
const MAIN_KEY = "sk-main-key";

// 协议层：每次调用即 withStreamRetry 的一次工厂调用。
const protocolCalls = [];
const behaviors = [];
const sharedMocks = {
  "@tauri-apps/api/core": {
    async invoke(command) {
      if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
      throw new Error(`unexpected tauri invoke: ${command}`);
    },
  },
  "@earendil-works/pi-ai/api/anthropic-messages": {
    stream(model, context, options) {
      const call = { model, context, options };
      protocolCalls.push(call);
      const next = behaviors.shift();
      if (!next) throw new Error("no fake stream queued");
      return next(call);
    },
  },
  [abs("src/lib/system/powerActivity.ts")]: {
    withPowerActivity: (_scope, _reason, run) => run(),
  },
};
// llm.stream 针孔：截获入参（含 streamRetry），再交给另一个加载器里的真实分发。
const { streamSimpleByApi } = createTsModuleLoader({ mocks: sharedMocks }).loadModule(
  "src/lib/providers/runtime/streamByApi.ts",
);
const llmCalls = [];
const loader = createTsModuleLoader({
  mocks: {
    ...sharedMocks,
    [abs("src/lib/providers/runtime/streamByApi.ts")]: {
      streamSimpleByApi(model, context, options) {
        llmCalls.push({ model, context, options });
        return streamSimpleByApi(model, context, options);
      },
    },
  },
});
const { summarize } = loader.loadModule("src/lib/chat/compaction/summarize.ts");
const { resolveCompactionLimits, firstEventBudgetMs } = loader.loadModule(
  "src/lib/chat/compaction/policy.ts",
);
const { TRANSCRIPT_SYSTEM } = loader.loadModule("src/lib/chat/compaction/prompt.ts");
const { runAssistantWithTools } = loader.loadModule("src/lib/chat/runner/agentRunner.ts");

function runtime(overrides = {}) {
  return {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: MAIN_KEY,
    reasoning: "high",
    promptCachingEnabled: true,
    modelConfig: { id: MODEL, contextWindow: 200_000, maxOutputToken: 64_000 },
    ...overrides,
  };
}

function assistantMessage(content, stopReason, extra = {}) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: MODEL,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
    ...extra,
  };
}

const textStream =
  (text, extra = {}) =>
  () => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage([{ type: "text", text }], "stop", extra);
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };

const errorStream = (errorMessage) => () => {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage([], "error", { errorMessage });
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
};

/** 吐完 text 后沉默，直到请求信号中止才以 pi-ai 的 aborted 终止（部分内容保留）。 */
const silentStream =
  (text = "") =>
  ({ options }) => {
    const stream = createAssistantMessageEventStream();
    const content = text ? [{ type: "text", text }] : [];
    const partial = assistantMessage(content, "stop");
    stream.push({ type: "start", partial });
    if (text) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    const finish = () => {
      const aborted = assistantMessage(content, "aborted", { errorMessage: "Request was aborted" });
      stream.push({ type: "error", reason: "aborted", error: aborted });
    };
    if (options.signal?.aborted) finish();
    else options.signal?.addEventListener("abort", finish, { once: true });
    return stream;
  };

/** 先写 text 再发起工具调用；没被中止就以 toolUse 正常结束。 */
const toolCallStream =
  (text) =>
  ({ options }) => {
    const stream = createAssistantMessageEventStream();
    const toolCall = { type: "toolCall", id: "call_1", name: "Read", arguments: {} };
    const partial = assistantMessage([{ type: "text", text }], "stop");
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    stream.push({ type: "toolcall_start", contentIndex: 1, partial });
    const settle = () => {
      if (options.signal?.aborted) {
        const aborted = assistantMessage([{ type: "text", text }], "aborted");
        stream.push({ type: "error", reason: "aborted", error: aborted });
      } else {
        const message = assistantMessage([{ type: "text", text }, toolCall], "toolUse");
        stream.push({ type: "done", reason: "toolUse", message });
      }
    };
    setTimeout(settle, 20);
    return stream;
  };

/** 真实 anthropic 协议实现构造请求体，onPayload 链尾截获后中断，网络零触碰。 */
async function captureWire({ model, context, options }) {
  let captured;
  const stream = realAnthropic.stream(model, context, {
    ...options,
    signal: undefined,
    onPayload: async (payload, payloadModel) => {
      captured = options.onPayload
        ? ((await options.onPayload(payload, payloadModel)) ?? payload)
        : payload;
      throw new Error("__capture_stop__");
    },
  });
  await stream.result().catch(() => undefined);
  assert.ok(captured, "expected a wire payload");
  return JSON.parse(JSON.stringify(captured));
}

function lastText(context) {
  const content = context.messages.at(-1).content;
  return typeof content === "string" ? content : content[0].text;
}

function kindOf(call) {
  if (call.context.systemPrompt?.startsWith(TRANSCRIPT_SYSTEM)) return "transcript";
  return lastText(call.context).startsWith("[CONTEXT CHECKPOINT") ? "fork" : "main";
}

function reset(...queued) {
  protocolCalls.length = 0;
  llmCalls.length = 0;
  behaviors.length = 0;
  behaviors.push(...queued);
}

// —— 主请求：真实发出一次，记下配方 ——
reset(textStream("main answer"));
const recipes = [];
await runAssistantWithTools({
  providerId: "claude_code",
  model: MODEL,
  runtime: runtime(),
  context: {
    systemPrompt: "Base system prompt",
    messages: [{ role: "user", content: "Read a.txt and explain", timestamp: 1 }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  },
  workdir: "/tmp/liveagent-summarize",
  sessionId: SESSION_ID,
  async executeToolCall() {
    throw new Error("no tool calls expected");
  },
  onTextDelta() {},
  onRequestPrepared: (recipe) => recipes.push(recipe),
});
const [recipe] = recipes;
const [mainProtocolCall] = protocolCalls;
const [mainLlmCall] = llmCalls;
assert.equal(recipes.length, 1);

const SUMMARY = "<summary>\n## Goal\nExplain a.txt\n</summary>";

function makeInput(overrides = {}) {
  const progress = [];
  const logged = [];
  return {
    progress,
    logged,
    input: {
      providerId: "claude_code",
      model: MODEL,
      runtime: runtime(),
      sessionId: SESSION_ID,
      recipe,
      messages: recipe.messages,
      previousSummary: "## Goal\nold goal",
      segmentMessages: [{ role: "user", content: "Read a.txt and explain", timestamp: 1 }],
      startAt: "fork",
      automatic: true,
      mustProgress: false,
      tokensBefore: 1_000,
      limits: resolveCompactionLimits({ contextWindow: 200_000, maxOutputToken: 64_000 }),
      deadlineAt: Date.now() + 600_000,
      signal: new AbortController().signal,
      onProgress: (text) => progress.push(text),
      debugLogger: {
        enabled: true,
        logRequest() {},
        logResponse() {},
        logResult: (payload) => logged.push(payload),
        logError() {},
        flush: async () => {},
      },
      ...overrides,
    },
  };
}

function stages(logged) {
  return logged
    .filter((entry) => entry.event === "compaction_stage")
    .map((entry) => [entry.stage, entry.outcome]);
}

async function waitFor(predicate) {
  for (let index = 0; index < 200 && !predicate(); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "condition never became true");
}

test("fork replays the recorded main request byte-for-byte plus one instruction, on a fresh transport", async () => {
  reset(textStream(SUMMARY, { usage: { ...assistantMessage([], "stop").usage, input: 120, output: 40, cacheRead: 900 } }));
  const { input } = makeInput({ runtime: runtime({ apiKey: "sk-rotated-key" }) });
  const result = await summarize(input);

  assert.deepEqual(result, {
    ok: {
      summaryText: "## Goal\nExplain a.txt",
      promptVersion: "summary-v4",
      providerId: "claude_code",
      model: MODEL,
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 900 },
    },
  });
  assert.equal(protocolCalls.length, 1);
  const [forkCall] = protocolCalls;
  assert.equal(kindOf(forkCall), "fork");

  // 传输现取：轮换后的 key 生效，旧 key 不出现在 fork 里。
  assert.equal(forkCall.options.apiKey, "sk-rotated-key");
  assert.equal(JSON.stringify(llmCalls[0].options).includes(MAIN_KEY), false);

  // llm.stream 入参：除逐次句柄与凭证外，选项与主请求逐字段相同（max_tokens 不设上限）。
  const strip = ({ onPayload, signal, streamRetry, apiKey, headers, ...rest }) => rest;
  assert.deepEqual(strip(llmCalls[0].options), strip(mainLlmCall.options));
  assert.deepEqual(llmCalls[0].model, mainLlmCall.model);
  const { streamRetry } = llmCalls[0].options;
  assert.deepEqual(
    [streamRetry.maxAttempts, streamRetry.firstEventTimeoutMs, streamRetry.idleTimeoutMs, streamRetry.retryOnStall],
    [3, firstEventBudgetMs(1_000, "high"), 180_000, false],
  );

  // 线上请求体：其余逐字节相同，messages 恰好多出末尾一条指令 user 消息。
  const mainWire = await captureWire(mainProtocolCall);
  const { messages: forkMessages, ...forkRest } = await captureWire(forkCall);
  const { messages: mainMessages, ...mainRest } = mainWire;
  assert.deepEqual(forkRest, mainRest);
  assert.equal(forkMessages.length, mainMessages.length + 1);
  assert.deepEqual(forkMessages.slice(0, -1), mainMessages);
  assert.equal(forkMessages.at(-1).role, "user");
  assert.match(forkMessages.at(-1).content[0].text, /^\[CONTEXT CHECKPOINT/);
  // 推理开着：指令不要求 <analysis> 草稿。
  assert.match(forkMessages.at(-1).content[0].text, /Reason privately/);
});

test("ladder: an invalid fork falls through to the transcript (fresh text request, low reasoning)", async () => {
  reset(textStream("no tags at all"), textStream("## Goal\ntranscript summary"));
  const { input, logged, progress } = makeInput();
  const result = await summarize(input);

  assert.equal(result.ok.promptVersion, "summary-v4-transcript");
  assert.equal(result.ok.summaryText, "## Goal\ntranscript summary");
  assert.deepEqual(protocolCalls.map(kindOf), ["fork", "transcript"]);
  assert.deepEqual(stages(logged), [
    ["fork", "invalid"],
    ["transcript", "ok"],
  ]);

  const transcriptCall = protocolCalls[1];
  assert.equal(transcriptCall.context.messages.length, 1);
  const content = lastText(transcriptCall.context);
  assert.match(content, /^<conversation>\n\[User\]\nRead a\.txt and explain\n<\/conversation>\n\n\[CONTEXT CHECKPOINT/);
  assert.match(content, /Reason privately/);
  assert.equal(transcriptCall.options.cacheRetention, "none");
  assert.ok(transcriptCall.options.maxTokens <= 32_000);
  assert.equal(llmCalls[1].options.streamRetry.retryOnStall, true);
  assert.equal(llmCalls[1].options.streamRetry.maxAttempts, 3);
  assert.ok(progress.some((text) => text.startsWith("→ transcript · ")));
});

test("a forced tool choice in the recipe is relaxed to auto so the fork can answer in text", async () => {
  reset(textStream(SUMMARY));
  const forced = { ...recipe, options: { ...recipe.options, toolChoice: { type: "tool", name: "Read" } } };
  const result = await summarize(makeInput({ recipe: forced }).input);

  assert.ok("ok" in result);
  assert.equal(llmCalls[0].options.toolChoice, "auto");
  assert.deepEqual(forced.options.toolChoice, { type: "tool", name: "Read" });
});

test("overflow starts at the transcript and is never retried; no recipe also skips the fork", async () => {
  reset(errorStream("prompt is too long: 205031 tokens > 200000 maximum"));
  const { input } = makeInput({ startAt: "transcript" });
  const result = await summarize(input);
  assert.equal(result.failure.kind, "overflow");
  assert.deepEqual(protocolCalls.map(kindOf), ["transcript"]);

  reset(textStream("## Goal\nfrom transcript"));
  const noRecipe = await summarize(makeInput({ recipe: null }).input);
  assert.equal(noRecipe.ok.promptVersion, "summary-v4-transcript");
  assert.deepEqual(protocolCalls.map(kindOf), ["transcript"]);

  // 配方属于别的模型：同样不可用。
  reset(textStream("## Goal\nfrom transcript"));
  await summarize(makeInput({ recipe: { ...recipe, modelId: "claude-opus-4-1" } }).input);
  assert.deepEqual(protocolCalls.map(kindOf), ["transcript"]);

  // 同轮 failover 后配方出自同 vendor 同模型的 fallback：只有 targetKey 不同，同样不可用。
  assert.equal(recipe.targetKey, `claude_code::${MODEL}`);
  reset(textStream("## Goal\nfrom transcript"));
  await summarize(makeInput({ recipe: { ...recipe, targetKey: `p-backup::${MODEL}` } }).input);
  assert.deepEqual(protocolCalls.map(kindOf), ["transcript"]);
});

test("the transcript may fail over and reports the target that actually served", async () => {
  reset(errorStream("401 Unauthorized: invalid x-api-key"), textStream("## Goal\nfrom backup"));
  const switched = [];
  const { input } = makeInput({
    recipe: null,
    failover: {
      config: { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 },
      primary: { selectedModel: { customProviderId: "p-main", model: MODEL }, label: "main" },
      fallbacks: [
        {
          selectedModel: { customProviderId: "p-backup", model: "claude-haiku-4-5" },
          providerId: "claude_code",
          model: "claude-haiku-4-5",
          label: "backup",
          runtime: runtime({ baseUrl: "https://relay.example.com/anthropic", apiKey: "sk-backup" }),
        },
      ],
      onSwitched: (event) => switched.push(event.target?.label),
    },
  });
  const result = await summarize(input);
  assert.equal(result.ok.model, "claude-haiku-4-5");
  assert.equal(result.ok.providerId, "claude_code");
  assert.deepEqual(switched, ["backup"]);
  assert.deepEqual(
    protocolCalls.map((call) => [kindOf(call), call.options.apiKey]),
    [
      ["transcript", MAIN_KEY],
      ["transcript", "sk-backup"],
    ],
  );
});

test("a first-event stall on the fork goes straight to the transcript without a fork retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  reset(silentStream(), textStream("## Goal\nafter stall"));
  const { input, logged } = makeInput({ deadlineAt: Date.now() + 600_000 });
  const pending = summarize(input);
  await waitFor(() => protocolCalls.length === 1);

  t.mock.timers.tick(firstEventBudgetMs(1_000, "high"));
  const result = await pending;

  assert.equal(result.ok.promptVersion, "summary-v4-transcript");
  assert.deepEqual(protocolCalls.map(kindOf), ["fork", "transcript"]);
  assert.equal(stages(logged)[0][1], "stall");
});

test("the deadline is a failure, not an abort; a closed summary written before it is salvaged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  // 总时限只剩 30s（不足 45s）：fork 被它结束后不再进入 transcript。
  const runUntilDeadline = async (stream) => {
    reset(stream);
    const { input, logged } = makeInput({ deadlineAt: Date.now() + 30_000 });
    const pending = summarize(input);
    await waitFor(() => protocolCalls.length === 1);
    t.mock.timers.tick(30_000);
    return { result: await pending, logged };
  };

  const { result, logged } = await runUntilDeadline(silentStream());
  assert.equal(result.failure.kind, "deadline");
  assert.deepEqual(protocolCalls.map(kindOf), ["fork"]);
  assert.deepEqual(stages(logged), [["fork", "deadline"]]);

  const { result: salvaged } = await runUntilDeadline(
    silentStream("<summary>## Goal\nsalvaged</summary>\n(still writing"),
  );
  assert.equal(salvaged.ok.promptVersion, "summary-v4");
  assert.equal(salvaged.ok.summaryText, "## Goal\nsalvaged");
});

test("a user stop throws AbortError and runs no further stage", async () => {
  reset(silentStream());
  const controller = new AbortController();
  const pending = summarize(makeInput({ signal: controller.signal, mustProgress: true }).input);
  await waitFor(() => protocolCalls.length === 1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(protocolCalls.length, 1);
});

test("toolcall_start before a closed </summary> aborts the fork; after it the summary stands", async () => {
  reset(toolCallStream("Let me read the file first."), textStream("## Goal\nvia transcript"));
  const { input, logged } = makeInput();
  const result = await summarize(input);
  assert.equal(result.ok.promptVersion, "summary-v4-transcript");
  assert.deepEqual(stages(logged)[0], ["fork", "tool-call"]);

  reset(toolCallStream("<summary>## Goal\nwritten first</summary>"));
  const kept = await summarize(makeInput().input);
  assert.equal(kept.ok.promptVersion, "summary-v4");
  assert.equal(kept.ok.summaryText, "## Goal\nwritten first");
  assert.equal(protocolCalls.length, 1);
});

test("network retries stay within 3 attempts per stage and honour a disabled policy", async () => {
  const overloaded = errorStream("503 Service Unavailable");
  reset(overloaded, overloaded, overloaded, textStream("## Goal\nrecovered"));
  const { input, progress } = makeInput();
  const result = await summarize(input);
  assert.equal(result.ok.promptVersion, "summary-v4-transcript");
  assert.deepEqual(protocolCalls.map(kindOf), ["fork", "fork", "fork", "transcript"]);
  assert.ok(progress.some((text) => text.startsWith("↻1/2 · ")));
  assert.ok(progress.some((text) => text.startsWith("↻2/2 · ")));

  reset(overloaded, textStream("## Goal\nrecovered"));
  await summarize(makeInput({ runtime: runtime({ retryPolicy: { mode: "off" } }) }).input);
  assert.deepEqual(protocolCalls.map(kindOf), ["fork", "transcript"]);
});

test("late progress after the run has settled is dropped", async () => {
  reset(textStream(SUMMARY));
  const { input, progress } = makeInput();
  await summarize(input);
  const published = progress.length;
  assert.ok(published > 0);
  // withStreamRetry 的泵独立于消费者：结束后迟到的重试回调不得重新点亮状态。
  llmCalls[0].options.streamRetry.onRetry(1, 2, "late");
  assert.equal(progress.length, published);
});

test("progress refreshes locally every 2s; the wire only gets changes and the 20s heartbeat", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  reset(silentStream("<summary>## Goal"));
  const events = [];
  const stop = new AbortController();
  const pending = summarize(
    makeInput({ signal: stop.signal, onProgress: (text, wire) => events.push([text, wire]) })
      .input,
  );
  await waitFor(() => events.length === 2);
  // 进档与开始写作两个变化点都上线。
  assert.deepEqual(events[0], ["0:00", true]);
  assert.match(events[1][0], /^\d+ · 0:00$/);
  assert.equal(events[1][1], true);

  t.mock.timers.tick(2_000);
  assert.match(events.at(-1)[0], /^\d+ · 0:02$/);
  assert.equal(events.at(-1)[1], false);
  t.mock.timers.tick(16_000);
  assert.deepEqual(
    events.map(([, wire]) => wire),
    [true, true, ...Array(9).fill(false)],
  );
  t.mock.timers.tick(2_000);
  assert.match(events.at(-1)[0], / · 0:20$/);
  assert.equal(events.at(-1)[1], true);

  stop.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("deterministic only for automatic, mustProgress, non-fatal failures", async () => {
  // 不可重试、非鉴权的错误：每档一次。
  const rejected = errorStream("400 Bad Request: malformed thinking block");
  const allFail = () => reset(rejected, rejected);

  allFail();
  const manual = await summarize(makeInput({ automatic: false, mustProgress: true }).input);
  assert.equal(manual.failure.kind, "transient");

  allFail();
  const optional = await summarize(makeInput({ mustProgress: false }).input);
  assert.equal(optional.failure.kind, "transient");

  allFail();
  const { input, progress } = makeInput({ mustProgress: true });
  const degraded = await summarize(input);
  assert.equal(degraded.ok.promptVersion, "summary-v4-deterministic");
  assert.deepEqual(degraded.ok.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  assert.match(degraded.degraded, /^transcript transient: /);
  assert.match(
    degraded.ok.summaryText,
    /^## Goal\nold goal\n\n## Unsummarized activity\n\n\(Automatic summary unavailable: transcript transient: [^\n]*; re-read files as needed\.\)\n\n\[User\]\nRead a\.txt and explain$/,
  );
  assert.ok(progress.at(-1).startsWith("→ deterministic · "));

  const fatal = errorStream("401 Unauthorized: invalid x-api-key");
  reset(fatal, fatal);
  const denied = await summarize(makeInput({ mustProgress: true }).input);
  assert.equal(denied.failure.kind, "fatal");
  assert.deepEqual(protocolCalls.map(kindOf), ["fork", "transcript"]);
});
