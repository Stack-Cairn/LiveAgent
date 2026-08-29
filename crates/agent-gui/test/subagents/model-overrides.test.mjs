import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import {
  createAgentToolCall,
  createModelOptions,
  createRecordingActivity,
  createSubagentHarness,
} from "./harness.mjs";

const loader = createTsModuleLoader();
const validate = loader.loadModule("src/lib/subagents/validate.ts");

const LEVELS_BY_MODEL = {
  "gpt-5": ["off", "low", "medium", "high"],
  "gpt-5-mini": ["off", "low"],
};

function parse(args, modelOptions) {
  return validate.parseSubagentBatch(args, {
    identities: new Map(),
    templates: [],
    modelOptions,
  });
}

function defaultModelOptions(overrides = {}) {
  return {
    models: overrides.models ?? ["gpt-5", "gpt-5-mini"],
    thinkingLevelsFor: (model) => LEVELS_BY_MODEL[model] ?? [],
    parentModel: overrides.parentModel ?? "gpt-5",
  };
}

test("omitting model and thinking leaves the spec inheriting the parent", () => {
  const result = parse({ agents: [{ id: "a", prompt: "go" }] }, defaultModelOptions());
  assert.equal(result.ok, true);
  const { spec } = result.batch.agents[0];
  assert.equal(spec.model, undefined);
  assert.equal(spec.reasoning, undefined);
});

test("a valid model and thinking pair resolves onto the spec", () => {
  const result = parse(
    { agents: [{ id: "a", prompt: "go", model: "gpt-5-mini", thinking: "low" }] },
    defaultModelOptions(),
  );
  assert.equal(result.ok, true);
  const { spec } = result.batch.agents[0];
  assert.equal(spec.model, "gpt-5-mini");
  assert.equal(spec.reasoning, "low");
});

test("an override without a runtime option space is rejected, never silently dropped", () => {
  // 静默忽略最坏：模型会以为自己成功换了个更强的模型，然后按错误的预期分派任务。
  const result = parse({ agents: [{ id: "a", prompt: "go", model: "gpt-5-mini" }] }, undefined);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /not available in this runtime/);
});

test("an unknown model is rejected with the allowed list", () => {
  const result = parse(
    { agents: [{ id: "a", prompt: "go", model: "claude-opus-5" }] },
    defaultModelOptions(),
  );
  assert.equal(result.ok, false);
  const [issue] = result.issues;
  assert.match(issue.message, /Unknown model "claude-opus-5"/);
  assert.match(issue.message, /gpt-5, gpt-5-mini/);
});

test("thinking is validated against the requested model, not the parent model", () => {
  // gpt-5 支持 high，gpt-5-mini 不支持。拿父模型的档位表去校验会一路放过，
  // 然后在请求期被静默 clamp——用户以为自己开了 high。
  const result = parse(
    { agents: [{ id: "a", prompt: "go", model: "gpt-5-mini", thinking: "high" }] },
    defaultModelOptions({ parentModel: "gpt-5" }),
  );
  assert.equal(result.ok, false);
  const [issue] = result.issues;
  assert.match(issue.message, /thinking must be one of off, low/);
  assert.match(issue.message, /gpt-5-mini/);
});

test("thinking alone is validated against the parent model", () => {
  const ok = parse({ agents: [{ id: "a", prompt: "go", thinking: "high" }] }, defaultModelOptions());
  assert.equal(ok.ok, true);
  assert.equal(ok.batch.agents[0].spec.reasoning, "high");

  const rejected = parse(
    { agents: [{ id: "a", prompt: "go", thinking: "high" }] },
    defaultModelOptions({ parentModel: "gpt-5-mini" }),
  );
  assert.equal(rejected.ok, false);
});

test("a model with no thinking levels rejects thinking instead of ignoring it", () => {
  const result = parse(
    { agents: [{ id: "a", prompt: "go", thinking: "low" }] },
    defaultModelOptions({ parentModel: "some-non-reasoning-model" }),
  );
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /does not expose thinking levels/);
});

test("the override reaches the provider runtime and the run mirror", async () => {
  const activity = createRecordingActivity();
  const modelOptions = createModelOptions();
  const harness = await createSubagentHarness({
    activity: activity.sink,
    modelOptions: modelOptions.options,
  });

  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "cheap", prompt: "mechanical job", model: "gpt-5-mini", thinking: "low" },
        { id: "default", prompt: "inherit everything" },
      ],
      concurrency: 1,
    }),
  );
  assert.equal(result.isError, false);

  // runner 必须收到覆盖后的模型与重建过的 runtime（modelConfig 跟着换）。
  const cheapCall = harness.runnerCalls.find((call) => call.model === "gpt-5-mini");
  assert.ok(cheapCall, "expected the overridden agent to run on gpt-5-mini");
  assert.equal(cheapCall.runtime.reasoning, "low");
  assert.deepEqual(cheapCall.runtime.modelConfig, { id: "gpt-5-mini" });

  // 未覆盖的 agent 一律沿用父 runtime 对象本身，不该白跑一次目录查找。
  const inheritedCall = harness.runnerCalls.find((call) => call.model === "gpt-5");
  assert.ok(inheritedCall, "expected the untouched agent to stay on the parent model");
  assert.equal(modelOptions.createdRuntimes.length, 1);

  const cheapStart = activity.started.find((entry) => entry.agentId === "cheap");
  assert.equal(cheapStart.model, "gpt-5-mini");
  assert.equal(cheapStart.reasoning, "low");
  const inheritedStart = activity.started.find((entry) => entry.agentId === "default");
  assert.equal(inheritedStart.model, "gpt-5");

  // 落盘的 run summary 记录生效模型，否则 resume 会把这个 agent 拽回父模型。
  const cheapRun = harness.storeIpc.appliedSaves.find((save) => save.run.agentId === "cheap");
  assert.equal(cheapRun.run.model, "gpt-5-mini");
});

test("the run id is generated once and shared by report, mirror and persistence", async () => {
  const activity = createRecordingActivity();
  const harness = await createSubagentHarness({ activity: activity.sink });

  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "solo", prompt: "go" }] }),
  );
  const [report] = result.details.agents;
  assert.equal(activity.started.length, 1);
  assert.equal(activity.started[0].runId, report.runId);
  assert.equal(activity.finished[0].runId, report.runId);
  assert.equal(activity.finished[0].outcome.status, "completed");
  const saved = harness.storeIpc.appliedSaves.find((save) => save.run.agentId === "solo");
  assert.equal(saved.run.id, report.runId);
});

test("per-agent stop cancels only that agent", async () => {
  const activity = createRecordingActivity();
  let releaseSlow;
  const slowStarted = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const harness = await createSubagentHarness({
    activity: activity.sink,
    runner: async (params) => {
      const agentId = params.sessionId?.includes("slow") ? "slow" : "fast";
      if (agentId !== "slow") {
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "fast done" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5",
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
        };
        return { assistant, messages: [assistant], emittedMessages: [assistant] };
      }
      releaseSlow();
      // 等这个 agent 自己的 signal 被 abort；父回合的 signal 从未被触发。
      await new Promise((_resolve, reject) => {
        params.signal.addEventListener("abort", () => reject(new Error("Cancelled")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    },
  });

  const pending = harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "slow", prompt: "runs forever" },
        { id: "fast", prompt: "returns immediately" },
      ],
      concurrency: 2,
    }),
  );

  await slowStarted;
  const slowStart = activity.started.find((entry) => entry.agentId === "slow");
  assert.ok(slowStart.stop, "expected a per-agent stop handle");
  slowStart.stop();

  const result = await pending;
  const byId = new Map(result.details.agents.map((report) => [report.id, report]));
  assert.equal(byId.get("slow").status, "cancelled");
  assert.equal(byId.get("fast").status, "completed");
});

// --- 用户在设置里钉死子代理模型 -------------------------------------------
// 语义是硬约束而非建议：钉了之后模型不能再自行换模型，否则「把机械活交给便宜
// 模型」这个诉求根本落不了地。

const PINNED = {
  providerId: "claude_code",
  model: "claude-haiku-4-5",
  reasoning: "low",
  runtime: {
    baseUrl: "https://anthropic.example.test/v1",
    apiKey: "pinned-key",
    modelConfig: { id: "claude-haiku-4-5" },
    reasoning: "low",
  },
  label: "claude-haiku-4-5 · low",
};

test("a pinned model rejects any per-agent override and names who pinned it", () => {
  const result = parse(
    { agents: [{ id: "a", prompt: "go", model: "gpt-5" }] },
    { ...defaultModelOptions(), pinnedLabel: PINNED.label },
  );
  assert.equal(result.ok, false);
  const [issue] = result.issues;
  // 说清「谁定的」，模型才不会换个写法再试一次。
  assert.match(issue.message, /The user pinned every subagent to claude-haiku-4-5 · low/);
  assert.match(issue.message, /omitted/);
});

test("a pinned model still accepts calls that omit model and thinking", () => {
  const result = parse(
    { agents: [{ id: "a", prompt: "go" }] },
    { ...defaultModelOptions(), pinnedLabel: PINNED.label },
  );
  assert.equal(result.ok, true);
  assert.equal(result.batch.agents[0].spec.model, undefined);
});

test("the pin drives provider, model and runtime for every agent", async () => {
  const activity = createRecordingActivity();
  const modelOptions = createModelOptions({ pinned: PINNED });
  const harness = await createSubagentHarness({
    activity: activity.sink,
    modelOptions: modelOptions.options,
  });

  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "one", prompt: "first" },
        { id: "two", prompt: "second" },
      ],
      concurrency: 2,
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(harness.runnerCalls.length, 2);

  for (const call of harness.runnerCalls) {
    // 跨供应商钉选：providerId 与 runtime 都必须跟着走，光换 model 会把请求发到
    // 父会话的 baseUrl 上。
    assert.equal(call.providerId, "claude_code");
    assert.equal(call.model, "claude-haiku-4-5");
    assert.equal(call.runtime.baseUrl, "https://anthropic.example.test/v1");
    assert.equal(call.runtime.apiKey, "pinned-key");
    assert.equal(call.runtime.reasoning, "low");
  }
  // 钉选自带 runtime，不该再走 createRuntime 派生。
  assert.equal(modelOptions.createdRuntimes.length, 0);

  for (const entry of activity.started) {
    assert.equal(entry.providerId, "claude_code");
    assert.equal(entry.model, "claude-haiku-4-5");
    assert.equal(entry.reasoning, "low");
  }

  // 落盘的 run summary 也记录钉选后的供应商与模型，resume 才不会跳回父会话。
  const saved = harness.storeIpc.appliedSaves.find((save) => save.run.agentId === "one");
  assert.equal(saved.run.providerId, "claude_code");
  assert.equal(saved.run.model, "claude-haiku-4-5");
});

test("a pinned batch that tries to override starts no agents at all", async () => {
  const harness = await createSubagentHarness({
    modelOptions: createModelOptions({ pinned: PINNED }).options,
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "ok", prompt: "fine" },
        { id: "bad", prompt: "greedy", model: "gpt-5" },
      ],
    }),
  );
  // 批次校验是全有或全无：一个条目违规就不该有任何 agent 跑起来。
  assert.equal(result.isError, true);
  assert.equal(harness.runnerCalls.length, 0);
});
