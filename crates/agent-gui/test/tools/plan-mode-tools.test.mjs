import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadModules() {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  return {
    shared: loader.loadModule("@liveagent/ui/lib/chat/planMode.ts"),
    tools: loader.loadModule("src/lib/tools/planModeTools.ts"),
  };
}

const PLAN = "## 目标\n\n1. 改 A\n2. 验证 B\n";

function createToolCall(argumentsValue, id = "call-plan-1") {
  return { type: "toolCall", id, name: "ExitPlanMode", arguments: argumentsValue };
}

test("ExitPlanMode schema accepts a markdown plan", () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-1" });
  const tool = bundle.tools.find((candidate) => candidate.name === "ExitPlanMode");
  assert.ok(tool);
  const args = validateToolArguments(tool, createToolCall({ plan: PLAN }));
  assert.equal(args.plan, PLAN);
});

test("shared helpers sanitize plans and resolve decisions", () => {
  const { shared } = loadModules();

  assert.equal(shared.sanitizePlanMarkdown("  x  "), "x");
  assert.equal(shared.sanitizePlanMarkdown(42), "");
  const oversized = "a".repeat(shared.EXIT_PLAN_MODE_PLAN_MAX_LENGTH + 10);
  assert.equal(
    shared.sanitizePlanMarkdown(oversized).length,
    shared.EXIT_PLAN_MODE_PLAN_MAX_LENGTH,
  );

  assert.equal(shared.resolvePlanDecisionAnswer(null), null);
  assert.equal(shared.resolvePlanDecisionAnswer({ decision: "maybe" }), null);
  assert.deepEqual(shared.resolvePlanDecisionAnswer({ decision: "approve" }), {
    decision: "approve",
  });
  assert.deepEqual(shared.resolvePlanDecisionAnswer({ decision: "reject", feedback: " 改一下 " }), {
    decision: "reject",
    feedback: "改一下",
  });
  const longFeedback = "b".repeat(shared.EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH + 5);
  assert.equal(
    shared.resolvePlanDecisionAnswer({ decision: "reject", feedback: longFeedback }).feedback
      .length,
    shared.EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH,
  );

  // details 解析：kind/plan 缺失即 null；可选字段按需保留。
  assert.equal(shared.parseExitPlanModeResultDetails({ kind: "other", plan: "p" }), null);
  assert.deepEqual(
    shared.parseExitPlanModeResultDetails({
      kind: "exit_plan_mode",
      plan: "p",
      decision: "reject",
      feedback: "f",
    }),
    { kind: "exit_plan_mode", plan: "p", decision: "reject", feedback: "f" },
  );
});

test("execute rejects an empty plan without suspending", async () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-1" });
  const result = await bundle.executeToolCall(createToolCall({ plan: "   " }, "call-plan-empty"));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /plan is required/);
  assert.equal(tools.hasPendingPlanDecision("call-plan-empty"), false);
});

test("approve settles the pending plan and fires onPlanApproved", async () => {
  const { tools } = loadModules();
  const approvals = [];
  const bundle = tools.createExitPlanModeTools({
    conversationId: "conv-1",
    onPlanApproved: (input) => approvals.push(input.plan),
  });
  const resultPromise = bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-approve"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tools.hasPendingPlanDecision("call-plan-approve"), true);

  // 非法决定被拒，不消解挂起。
  const invalid = tools.answerPlanDecision("call-plan-approve", { decision: "maybe" });
  assert.equal(invalid.ok, false);
  assert.equal(tools.hasPendingPlanDecision("call-plan-approve"), true);

  // 串会话应答被拒。
  const wrongConversation = tools.answerPlanDecision(
    "call-plan-approve",
    { decision: "approve" },
    { conversationId: "conv-other" },
  );
  assert.equal(wrongConversation.ok, false);

  const accepted = tools.answerPlanDecision(
    "call-plan-approve",
    { decision: "approve" },
    { conversationId: "conv-1" },
  );
  assert.equal(accepted.ok, true);
  const result = await resultPromise;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /APPROVED/);
  assert.equal(result.details.kind, "exit_plan_mode");
  assert.equal(result.details.decision, "approve");
  assert.deepEqual(approvals, [PLAN.trim()]);
  // 获批调用进入终止标记集(runner 据此结束本轮);拒绝/超时路径不标记。
  assert.equal(tools.isPlanApprovalToolCall("call-plan-approve"), true);
  // 已落定后再次应答被拒。
  assert.equal(tools.answerPlanDecision("call-plan-approve", { decision: "approve" }).ok, false);
});

test("reject keeps plan mode and returns the feedback", async () => {
  const { tools } = loadModules();
  const approvals = [];
  const bundle = tools.createExitPlanModeTools({
    conversationId: "conv-1",
    onPlanApproved: (input) => approvals.push(input.plan),
  });
  const resultPromise = bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-reject"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const accepted = tools.answerPlanDecision("call-plan-reject", {
    decision: "reject",
    feedback: "拆成两步",
  });
  assert.equal(accepted.ok, true);
  const result = await resultPromise;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /REJECTED/);
  assert.match(result.content[0].text, /拆成两步/);
  assert.equal(result.details.decision, "reject");
  assert.equal(result.details.feedback, "拆成两步");
  assert.deepEqual(approvals, []);
  assert.equal(tools.isPlanApprovalToolCall("call-plan-reject"), false);
});

test("timeout settles as not-approved (no callback)", async () => {
  const { tools } = loadModules();
  const approvals = [];
  const bundle = tools.createExitPlanModeTools({
    conversationId: "conv-1",
    onPlanApproved: (input) => approvals.push(input.plan),
    timeoutMs: 20,
  });
  const result = await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-timeout"));
  assert.equal(result.isError, false);
  assert.equal(result.details.timedOut, true);
  assert.equal(result.details.decision, undefined);
  assert.match(result.content[0].text, /NOT approved/);
  assert.deepEqual(approvals, []);
});

test("abort settles a pending plan as cancelled", async () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-1" });
  const controller = new AbortController();
  const resultPromise = bundle.executeToolCall(
    createToolCall({ plan: PLAN }, "call-plan-abort"),
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.isError, true);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /Do not assume approval/);
});

test("cancelPendingPlanDecisionsForConversation settles only that conversation", async () => {
  const { tools } = loadModules();
  const bundleA = tools.createExitPlanModeTools({ conversationId: "conv-a" });
  const bundleB = tools.createExitPlanModeTools({ conversationId: "conv-b" });
  const promiseA = bundleA.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-a"));
  const promiseB = bundleB.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-b"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  tools.cancelPendingPlanDecisionsForConversation("conv-a");
  const resultA = await promiseA;
  assert.equal(resultA.details.cancelled, true);
  assert.equal(tools.hasPendingPlanDecision("call-plan-b"), true);

  tools.answerPlanDecision("call-plan-b", { decision: "approve" });
  const resultB = await promiseB;
  assert.equal(resultB.details.decision, "approve");
});

test("getPendingPlanDecisionToolCallId resolves the conversation's pending plan", async () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-pending" });
  assert.equal(tools.getPendingPlanDecisionToolCallId("conv-pending"), null);
  const resultPromise = bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-pending"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tools.getPendingPlanDecisionToolCallId("conv-pending"), "call-plan-pending");
  assert.equal(tools.getPendingPlanDecisionToolCallId("conv-other"), null);
  // 挂起时输入消息即"退回并附反馈"的落点:reject 后挂起消解。
  tools.answerPlanDecision("call-plan-pending", { decision: "reject", feedback: "改" });
  await resultPromise;
  assert.equal(tools.getPendingPlanDecisionToolCallId("conv-pending"), null);
});

test("gateway deadline preset is reused by execute", async () => {
  const { tools, shared } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-1" });
  const preset = tools.ensureExitPlanModeDeadlineAt("call-plan-deadline");
  assert.ok(preset > Date.now());
  assert.ok(preset <= Date.now() + shared.EXIT_PLAN_MODE_TIMEOUT_MS);

  const resultPromise = bundle.executeToolCall(
    createToolCall({ plan: PLAN }, "call-plan-deadline"),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 挂起后读取到的权威截止时间与预置一致。
  assert.equal(tools.getExitPlanModeDeadlineAt("call-plan-deadline"), preset);
  tools.answerPlanDecision("call-plan-deadline", { decision: "approve" });
  await resultPromise;
});

test("isPlanModeAllowedTool admits read-only, plan, and collaboration tools only", () => {
  const { tools } = loadModules();
  assert.equal(tools.isPlanModeAllowedTool("Read", { isReadOnly: true }), true);
  assert.equal(tools.isPlanModeAllowedTool("ExitPlanMode", { isReadOnly: true }), true);
  assert.equal(tools.isPlanModeAllowedTool("Agent", { isReadOnly: false }), true);
  assert.equal(tools.isPlanModeAllowedTool("SendMessage", { isReadOnly: false }), true);
  assert.equal(tools.isPlanModeAllowedTool("Bash", { isReadOnly: false }), false);
  assert.equal(tools.isPlanModeAllowedTool("Write", { isReadOnly: false }), false);
  assert.equal(tools.isPlanModeAllowedTool("mcp_srv_tool", undefined), false);
});
