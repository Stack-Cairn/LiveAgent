import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");

const {
  requestToolApproval,
  answerToolApproval,
  hasPendingToolApproval,
  getPendingToolApproval,
  getToolApprovalVersion,
  subscribeToolApprovals,
  isSessionApproved,
  cancelPendingToolApprovalsForConversation,
} = approval;

test("approve 决定使门放行,并从挂起表移除", async () => {
  const promise = requestToolApproval({
    toolCallId: "c1",
    toolName: "Bash",
    conversationId: "conv",
  });
  assert.equal(hasPendingToolApproval("c1"), true);
  const outcome = answerToolApproval("c1", "approve");
  assert.equal(outcome.ok, true);
  const settlement = await promise;
  assert.deepEqual(settlement, { kind: "decided", decision: "approve" });
  assert.equal(hasPendingToolApproval("c1"), false);
});

test("approve_session 记住本会话该工具,后续 isSessionApproved 为真", async () => {
  const promise = requestToolApproval({
    toolCallId: "c2",
    toolName: "Bash",
    conversationId: "conv2",
  });
  answerToolApproval("c2", "approve_session");
  await promise;
  assert.equal(isSessionApproved("conv2", "Bash"), true);
  assert.equal(isSessionApproved("conv2", "Write"), false);
  assert.equal(isSessionApproved("other", "Bash"), false);
});

test("deny 决定返回 decided/deny", async () => {
  const promise = requestToolApproval({
    toolCallId: "c3",
    toolName: "Delete",
    conversationId: "conv3",
  });
  answerToolApproval("c3", "deny");
  assert.deepEqual(await promise, { kind: "decided", decision: "deny" });
});

test("超时落定为 timeout", async () => {
  const settlement = await requestToolApproval({
    toolCallId: "c4",
    toolName: "Bash",
    conversationId: "conv4",
    timeoutMs: 10,
  });
  assert.deepEqual(settlement, { kind: "timeout" });
  assert.equal(hasPendingToolApproval("c4"), false);
});

test("很长的超时窗口 ≈ 永不:挂起等待用户决定,不在测试窗口内自动落定", async () => {
  const promise = requestToolApproval({
    toolCallId: "c-long-window",
    toolName: "Bash",
    conversationId: "conv-long-window",
    timeoutMs: 60 * 60 * 1000, // 1 小时
  });
  assert.equal(hasPendingToolApproval("c-long-window"), true);
  const pending = getPendingToolApproval("c-long-window");
  assert.ok(pending && pending.deadlineAt > Date.now() + 60 * 60 * 1000 - 60_000);
  // 等一拍，确认不会自动 timeout。
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hasPendingToolApproval("c-long-window"), true);
  // 用户决定后才落定。
  answerToolApproval("c-long-window", "approve");
  assert.deepEqual(await promise, { kind: "decided", decision: "approve" });
  assert.equal(hasPendingToolApproval("c-long-window"), false);
});

test("AbortSignal 触发 → cancelled;已 aborted 的信号立即 cancelled", async () => {
  const controller = new AbortController();
  const promise = requestToolApproval({
    toolCallId: "c5",
    toolName: "Bash",
    conversationId: "conv5",
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await promise, { kind: "cancelled" });

  const pre = new AbortController();
  pre.abort();
  const immediate = await requestToolApproval({
    toolCallId: "c6",
    toolName: "Bash",
    conversationId: "conv6",
    signal: pre.signal,
  });
  assert.deepEqual(immediate, { kind: "cancelled" });
});

test("串会话应答被拒;正确会话应答通过", async () => {
  const promise = requestToolApproval({
    toolCallId: "c7",
    toolName: "Bash",
    conversationId: "convA",
  });
  const wrong = answerToolApproval("c7", "approve", { conversationId: "convB" });
  assert.equal(wrong.ok, false);
  assert.equal(hasPendingToolApproval("c7"), true);
  const right = answerToolApproval("c7", "approve", { conversationId: "convA" });
  assert.equal(right.ok, true);
  await promise;
});

test("会话取消:挂起审批落定为 cancelled 并清理免审集合", async () => {
  const promise = requestToolApproval({
    toolCallId: "c8",
    toolName: "Bash",
    conversationId: "convX",
  });
  const pending = getPendingToolApproval("c8");
  assert.ok(pending && pending.deadlineAt > Date.now());
  cancelPendingToolApprovalsForConversation("convX");
  assert.deepEqual(await promise, { kind: "cancelled" });
  assert.equal(hasPendingToolApproval("c8"), false);
});

test("订阅版本号在挂起出现/落定时变化", async () => {
  let notified = 0;
  const unsubscribe = subscribeToolApprovals(() => {
    notified += 1;
  });
  const before = getToolApprovalVersion();
  const promise = requestToolApproval({
    toolCallId: "c9",
    toolName: "Bash",
    conversationId: "convV",
  });
  assert.ok(getToolApprovalVersion() > before);
  answerToolApproval("c9", "approve");
  await promise;
  assert.ok(notified >= 2);
  unsubscribe();
});
