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
  listPendingToolApprovalsForConversation,
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

test("approve_session 只在后端提供会话授权时透传,并携带授权范围", async () => {
  const offered = requestToolApproval({
    toolCallId: "c2",
    toolName: "computer_exec",
    conversationId: "conv2",
    allowSession: true,
    sessionScope: " call:click ",
  });
  assert.deepEqual(
    listPendingToolApprovalsForConversation("conv2").map(({ allowSession, sessionScope }) => ({
      allowSession,
      sessionScope,
    })),
    [{ allowSession: true, sessionScope: "call:click" }],
  );
  answerToolApproval("c2", "approve_session");
  assert.deepEqual(await offered, { kind: "decided", decision: "approve_session" });

  // 后端不会记住时(未提供 allow_always),远端/旧入口发来的 approve_session 只算本次放行。
  const notOffered = requestToolApproval({
    toolCallId: "c2b",
    toolName: "Bash",
    conversationId: "conv2",
  });
  assert.equal(listPendingToolApprovalsForConversation("conv2")[0].allowSession, false);
  answerToolApproval("c2b", "approve_session");
  assert.deepEqual(await notOffered, { kind: "decided", decision: "approve" });
});

test("sessionWide 透传到待审批摘要,缺省为 false", async () => {
  const wide = requestToolApproval({
    toolCallId: "c2w",
    toolName: "computer_exec",
    conversationId: "conv2w",
    sessionScope: "call:click",
    sessionWide: true,
  });
  const plain = requestToolApproval({ toolCallId: "c2p", toolName: "Bash", conversationId: "conv2w" });
  assert.deepEqual(
    listPendingToolApprovalsForConversation("conv2w").map((item) => [item.toolCallId, item.sessionWide]),
    [["c2w", true], ["c2p", false]],
  );
  answerToolApproval("c2w", "approve");
  answerToolApproval("c2p", "approve");
  assert.deepEqual(await wide, { kind: "decided", decision: "approve" });
  await plain;
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

test("会话取消:挂起审批落定为 cancelled", async () => {
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
