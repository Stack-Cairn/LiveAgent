import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  // 待决/已批准的合成标记读取(WebUI 参数盖章)。
  assert.equal(shared.readPlanPendingMarker({ __exitPlanModePending: true }), true);
  assert.equal(shared.readPlanPendingMarker({}), false);
  assert.equal(shared.readPlanApprovedMarker({ __exitPlanModeApproved: true }), true);

  // details 解析：kind/plan 缺失即 null。
  assert.equal(shared.parseExitPlanModeResultDetails({ kind: "other", plan: "p" }), null);
  assert.deepEqual(shared.parseExitPlanModeResultDetails({ kind: "exit_plan_mode", plan: "p" }), {
    kind: "exit_plan_mode",
    plan: "p",
  });
});

test("isPlanApprovalMessage accepts pure approval phrases only", () => {
  const { tools } = loadModules();
  for (const yes of ["同意", "  开始吧。", "OK", "ok!", "Go ahead", "lgtm", "开干"]) {
    assert.equal(tools.isPlanApprovalMessage(yes), true, yes);
  }
  for (const no of ["同意,但第二步改一下", "先等等", "保存到 plan.md 再执行", "", "  "]) {
    assert.equal(tools.isPlanApprovalMessage(no), false, no);
  }
});

test("execute rejects an empty plan without registering", async () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-1" });
  const result = await bundle.executeToolCall(createToolCall({ plan: "   " }, "call-plan-empty"));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /plan is required/);
  assert.equal(tools.getPendingPlanForConversation("conv-1"), null);
});

test("submission returns immediately and registers the pending plan", async () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-submit" });
  // 对话式范式:execute 不挂起——立即 resolve,不需要任何应答。
  const result = await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-submit-1"));
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /this turn ends here/);
  assert.deepEqual(result.details, { kind: "exit_plan_mode", plan: PLAN.trim() });
  assert.deepEqual(tools.getPendingPlanForConversation("conv-submit"), {
    toolCallId: "call-submit-1",
    plan: PLAN.trim(),
  });
  assert.equal(tools.isPlanDecisionPending("call-submit-1"), true);

  // 新提交覆盖旧登记:旧调用不再待决。
  await bundle.executeToolCall(createToolCall({ plan: "# v2" }, "call-submit-2"));
  assert.equal(tools.isPlanDecisionPending("call-submit-1"), false);
  assert.equal(tools.getPendingPlanForConversation("conv-submit").toolCallId, "call-submit-2");
  tools.cancelPendingPlanDecisionsForConversation("conv-submit");
});

test("approve routes to the host handler and settles the pending plan", async () => {
  const { tools } = loadModules();
  const approvals = [];
  const rejections = [];
  tools.registerPlanDecisionHandlers({
    onApprove: (input) => approvals.push(input),
    onReject: (input) => rejections.push(input),
  });
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-approve" });
  await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-approve-1"));

  // 非法决定被拒。
  assert.equal(tools.answerPlanDecision("call-approve-1", { decision: "maybe" }).ok, false);
  // 串会话应答被拒。
  assert.equal(
    tools.answerPlanDecision(
      "call-approve-1",
      { decision: "approve" },
      { conversationId: "conv-other" },
    ).ok,
    false,
  );

  const outcome = tools.answerPlanDecision(
    "call-approve-1",
    { decision: "approve" },
    { conversationId: "conv-approve" },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(approvals, [{ conversationId: "conv-approve", plan: PLAN.trim() }]);
  assert.deepEqual(rejections, []);
  assert.equal(tools.isPlanApprovalToolCall("call-approve-1"), true);
  assert.equal(tools.getPendingPlanForConversation("conv-approve"), null);
  // 已落定后再次应答被拒(结构化 code 供远端卡片落定而非报错)。
  const settled = tools.answerPlanDecision("call-approve-1", { decision: "approve" });
  assert.equal(settled.ok, false);
  assert.equal(settled.code, "not_pending");
  tools.registerPlanDecisionHandlers(null);
  // 批准态也随会话清理:批准时 pending 已删,清理不得依赖 pending 反查——
  // 否则 approvedToolCallIds 随进程无限增长。
  tools.cancelPendingPlanDecisionsForConversation("conv-approve");
  assert.equal(tools.isPlanApprovalToolCall("call-approve-1"), false);
});

test("reject requires feedback and routes it to the host as a message", async () => {
  const { tools } = loadModules();
  const approvals = [];
  const rejections = [];
  tools.registerPlanDecisionHandlers({
    onApprove: (input) => approvals.push(input),
    onReject: (input) => rejections.push(input),
  });
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-reject" });
  await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-reject-1"));

  // 缺反馈的 reject 被拒(引导直接打字)。
  assert.equal(tools.answerPlanDecision("call-reject-1", { decision: "reject" }).ok, false);
  assert.equal(tools.isPlanDecisionPending("call-reject-1"), true);

  const outcome = tools.answerPlanDecision("call-reject-1", {
    decision: "reject",
    feedback: "拆成两步",
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(rejections, [{ conversationId: "conv-reject", feedback: "拆成两步" }]);
  assert.deepEqual(approvals, []);
  // 反馈发出后旧计划失效(模型将修订重提)。
  assert.equal(tools.isPlanDecisionPending("call-reject-1"), false);
  assert.equal(tools.isPlanApprovalToolCall("call-reject-1"), false);
  tools.registerPlanDecisionHandlers(null);
});

test("cancel clears the conversation's pending plan and approval mark", async () => {
  const { tools } = loadModules();
  tools.registerPlanDecisionHandlers({ onApprove: () => {}, onReject: () => {} });
  const bundleA = tools.createExitPlanModeTools({ conversationId: "conv-a" });
  const bundleB = tools.createExitPlanModeTools({ conversationId: "conv-b" });
  await bundleA.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-a"));
  await bundleB.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-b"));

  tools.cancelPendingPlanDecisionsForConversation("conv-a");
  assert.equal(tools.getPendingPlanForConversation("conv-a"), null);
  // 其他会话不受影响。
  assert.equal(tools.isPlanDecisionPending("call-plan-b"), true);
  tools.cancelPendingPlanDecisionsForConversation("conv-b");
  tools.registerPlanDecisionHandlers(null);
});

test("subscription notifies on register/approve/supersede", async () => {
  const { tools } = loadModules();
  tools.registerPlanDecisionHandlers({ onApprove: () => {}, onReject: () => {} });
  let notifications = 0;
  const unsubscribe = tools.subscribePlanDecisions(() => {
    notifications += 1;
  });
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-sub" });
  await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-sub-1"));
  const afterRegister = notifications;
  assert.ok(afterRegister >= 1);
  tools.answerPlanDecision("call-sub-1", { decision: "approve" });
  assert.ok(notifications > afterRegister);
  unsubscribe();
  tools.registerPlanDecisionHandlers(null);
  tools.cancelPendingPlanDecisionsForConversation("conv-sub");
});

test("phrase approval in ChatPage is gated on the live plan switch", () => {
  // 待决计划跨 run 存活(设计如此),但短语批准必须要求 plan 开关仍开着:
  // 用户关掉 pill 弃置计划后,之后随口一句"好的/ok"不得把陈旧计划复活成
  // 执行续轮。显式批准仍走卡片按钮,不受开关限制。
  const chatPageSource = readFileSync(
    new URL("../../src/pages/ChatPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    chatPageSource,
    /planModeEnabledRef\.current =\s*settings\.chatRuntimeControls\.planModeEnabled === true/,
  );
  assert.match(chatPageSource, /if \(conversationId && planModeEnabledRef\.current\) \{/);
  // 短语批准分支整体处于开关前置之内(前置判断先于 pending 查询出现)。
  assert.ok(
    chatPageSource.indexOf("conversationId && planModeEnabledRef.current") <
      chatPageSource.indexOf("getPendingPlanForConversation(conversationId)"),
  );
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

test("plan-mode prompt routes every complete answer through ExitPlanMode without unbounded pressure", () => {
  const { tools } = loadModules();
  const section = tools.buildPlanModeSystemPromptSection();
  // 覆盖面:所有完整答案(不只实现计划)都经 ExitPlanMode 提交。
  assert.match(section, /Submit every complete answer through ExitPlanMode/);
  assert.match(section, /architecture summaries, research findings, Q&A/);
  assert.match(section, /instead of plain assistant text/);
  // 反空转:引导"够用即停",并点明重复读取只会得到 unchanged 桩。
  assert.match(section, /Stop researching once you can produce the deliverable/);
  assert.match(section, /unchanged stub/);
  // 高压措辞已移除:它抬高提交门槛,诱导无限调研。
  assert.doesNotMatch(section, /You MUST call/);
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-prompt" });
  const tool = bundle.tools.find((candidate) => candidate.name === "ExitPlanMode");
  assert.match(tool.description, /every finished answer, not only implementation plans/);
  assert.match(tool.description, /Submitting ends this turn immediately/);
});

// ---------------------------------------------------------------------------
// 运行策略:有界升级状态机
// ---------------------------------------------------------------------------

function textAssistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
}

function planToolResultMessage(toolCallId, isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "ExitPlanMode",
    content: [{ type: "text", text: "ok" }],
    isError,
    timestamp: 1,
  };
}

test("run policy: auto during research, one forced nudge, then text fallback registers the plan", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy" });

  // 研究阶段:不强制 tool_choice,熔断线为研究上限。
  assert.equal(policy.resolveToolChoice(), undefined);
  assert.equal(policy.maxRounds(), tools.PLAN_MODE_MAX_RESEARCH_ROUNDS);
  assert.equal(
    policy.resolveToolTermination({ type: "toolCall", id: "c1", name: "ExitPlanMode" }),
    true,
  );
  assert.equal(policy.resolveToolTermination({ type: "toolCall", id: "c2", name: "Read" }), false);

  // 第一次 run 以文本收尾且未提交 → 补提交一轮(定向强制 + 提醒文案)。
  const first = policy.decideAfterRun({ emittedMessages: [textAssistantMessage("plan text")] });
  assert.equal(first.kind, "nudge");
  assert.equal(first.reminderText, tools.PLAN_MODE_NUDGE_REMINDER);
  assert.deepEqual(policy.resolveToolChoice(), { type: "tool", name: "ExitPlanMode" });
  assert.equal(policy.maxRounds(), tools.PLAN_MODE_MAX_NUDGE_ROUNDS);

  // 补提交仍未产出 → 文本兜底。
  const second = policy.decideAfterRun({ emittedMessages: [textAssistantMessage("plan text")] });
  assert.equal(second.kind, "fallback");

  const fallback = policy.registerFallbackPlan({ planText: "## 兜底计划\n\n1. A\n" });
  assert.ok(fallback);
  assert.equal(fallback.toolCall.name, "ExitPlanMode");
  assert.equal(fallback.toolResult.toolCallId, fallback.toolCall.id);
  assert.equal(fallback.toolResult.isError, false);
  assert.deepEqual(fallback.toolResult.details, {
    kind: "exit_plan_mode",
    plan: "## 兜底计划\n\n1. A",
  });
  // 与真实提交同构:登记待决计划,审批入口零改动复用。
  assert.deepEqual(tools.getPendingPlanForConversation("conv-policy"), {
    toolCallId: fallback.toolCall.id,
    plan: "## 兜底计划\n\n1. A",
  });
  assert.equal(tools.isPlanDecisionPending(fallback.toolCall.id), true);
  tools.cancelPendingPlanDecisionsForConversation("conv-policy");
});

test("run policy: a successful ExitPlanMode submission settles the run immediately", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-ok" });
  const decision = policy.decideAfterRun({
    emittedMessages: [planToolResultMessage("call-ok-1")],
  });
  assert.equal(decision.kind, "submitted");
  // 提交成功后不进入补提交态。
  assert.equal(policy.resolveToolChoice(), undefined);
});

test("run policy: an errored ExitPlanMode result does not count as submission", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-err" });
  const decision = policy.decideAfterRun({
    emittedMessages: [planToolResultMessage("call-err-1", true)],
  });
  assert.equal(decision.kind, "nudge");
});

test("run policy: fallback with empty text registers nothing and the turn just ends", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-empty" });
  policy.decideAfterRun({ emittedMessages: [] });
  policy.decideAfterRun({ emittedMessages: [] });
  assert.equal(policy.registerFallbackPlan({ planText: "   " }), null);
  assert.equal(tools.getPendingPlanForConversation("conv-policy-empty"), null);
});

test("run policy: repeated identical research calls are blocked past the limit", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-repeat" });
  const read = (id) => ({
    type: "toolCall",
    id,
    name: "Read",
    // 键序不同也算同一调用(稳定序列化)。
    arguments: id === "r2" ? { limit: 5, path: "a.ts" } : { path: "a.ts", limit: 5 },
  });

  assert.equal(policy.guardRepeatedToolCall(read("r1")).allow, true);
  assert.equal(policy.guardRepeatedToolCall(read("r2")).allow, true);
  const blocked = policy.guardRepeatedToolCall(read("r3"));
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /already made this exact Read call/);
  assert.match(blocked.reason, /ExitPlanMode/);

  // 参数不同的调用不受影响。
  assert.equal(
    policy.guardRepeatedToolCall({
      type: "toolCall",
      id: "r4",
      name: "Read",
      arguments: { path: "b.ts" },
    }).allow,
    true,
  );
  // ExitPlanMode 永不被重复守卫拦截(修订后的重提不能被卡死)。
  for (const id of ["p1", "p2", "p3", "p4"]) {
    assert.equal(
      policy.guardRepeatedToolCall({
        type: "toolCall",
        id,
        name: "ExitPlanMode",
        arguments: { plan: "same" },
      }).allow,
      true,
    );
  }
});
