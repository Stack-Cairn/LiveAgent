import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2a: K-brain approvals wait without a deadline, "allow and remember" carries the
// scope the backend should store the suggested rules in, and a denial can carry a
// reason for the model.

const loader = createTsModuleLoader();
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
const { requestToolApproval, answerToolApproval, listPendingToolApprovalsForConversation } = approval;

test("timeoutMs null waits without a deadline and never settles on its own", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let settled = null;
  const promise = requestToolApproval({
    toolCallId: "wait-1",
    toolName: "Bash",
    conversationId: "conv-wait",
    timeoutMs: null,
  }).then((value) => {
    settled = value;
  });
  assert.equal(listPendingToolApprovalsForConversation("conv-wait")[0].deadlineAt, null);
  t.mock.timers.tick(60 * 60 * 1000);
  await Promise.resolve();
  assert.equal(settled, null, "an hour later the approval is still pending");
  answerToolApproval("wait-1", "approve");
  await promise;
  assert.deepEqual(settled, { kind: "decided", decision: "approve" });
});

test("callers that pass no timeout keep the three-minute window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const promise = requestToolApproval({ toolCallId: "legacy-1", toolName: "Bash", conversationId: "conv-legacy" });
  assert.equal(typeof listPendingToolApprovalsForConversation("conv-legacy")[0].deadlineAt, "number");
  t.mock.timers.tick(3 * 60 * 1000);
  assert.deepEqual(await promise, { kind: "timeout" });
});

test("remember rules and default scope are listed for the bar", () => {
  const promise = requestToolApproval({
    toolCallId: "rules-1",
    toolName: "Bash",
    conversationId: "conv-rules",
    allowSession: true,
    rememberRules: [" Bash(npm test:*) ", "", "Bash(npm test:*)", "Bash(git push:*)"],
    defaultScope: "project",
    timeoutMs: null,
  });
  const [pending] = listPendingToolApprovalsForConversation("conv-rules");
  assert.deepEqual(pending.rememberRules, ["Bash(npm test:*)", "Bash(git push:*)"]);
  assert.equal(pending.defaultScope, "project");
  answerToolApproval("rules-1", "deny");
  return promise;
});

test("an unknown default scope falls back to session", () => {
  const promise = requestToolApproval({
    toolCallId: "rules-2",
    toolName: "Bash",
    conversationId: "conv-rules-2",
    allowSession: true,
    rememberRules: ["Bash(ls:*)"],
    defaultScope: "global",
    timeoutMs: null,
  });
  assert.equal(listPendingToolApprovalsForConversation("conv-rules-2")[0].defaultScope, "session");
  answerToolApproval("rules-2", "deny");
  return promise;
});

test("approve_session carries a valid scope only when there are rules to remember", async () => {
  const withRules = requestToolApproval({
    toolCallId: "scope-1",
    toolName: "Bash",
    conversationId: "conv-scope",
    allowSession: true,
    rememberRules: ["Bash(npm test:*)"],
    defaultScope: "project",
    timeoutMs: null,
  });
  answerToolApproval("scope-1", "approve_session", { scope: "user" });
  assert.deepEqual(await withRules, { kind: "decided", decision: "approve_session", scope: "user" });

  const badScope = requestToolApproval({
    toolCallId: "scope-2",
    toolName: "Bash",
    conversationId: "conv-scope",
    allowSession: true,
    rememberRules: ["Bash(npm test:*)"],
    timeoutMs: null,
  });
  answerToolApproval("scope-2", "approve_session", { scope: "everywhere" });
  assert.deepEqual(await badScope, { kind: "decided", decision: "approve_session" });

  // A backend without rules (computer session grant) ignores any scope.
  const noRules = requestToolApproval({
    toolCallId: "scope-3",
    toolName: "computer_exec",
    conversationId: "conv-scope",
    allowSession: true,
    sessionScope: "call:click",
    timeoutMs: null,
  });
  answerToolApproval("scope-3", "approve_session", { scope: "project" });
  assert.deepEqual(await noRules, { kind: "decided", decision: "approve_session" });

  // Nothing to remember at all: approve_session is only this once, without a scope.
  const notOffered = requestToolApproval({ toolCallId: "scope-4", toolName: "Bash", conversationId: "conv-scope", timeoutMs: null });
  answerToolApproval("scope-4", "approve_session", { scope: "project" });
  assert.deepEqual(await notOffered, { kind: "decided", decision: "approve" });
});

test("a denial keeps its trimmed reason; other decisions drop it", async () => {
  const denied = requestToolApproval({ toolCallId: "reason-1", toolName: "Write", conversationId: "conv-reason", timeoutMs: null });
  answerToolApproval("reason-1", "deny", { reason: "  edit utils.ts instead  " });
  assert.deepEqual(await denied, { kind: "decided", decision: "deny", reason: "edit utils.ts instead" });

  const blank = requestToolApproval({ toolCallId: "reason-2", toolName: "Write", conversationId: "conv-reason", timeoutMs: null });
  answerToolApproval("reason-2", "deny", { reason: "   " });
  assert.deepEqual(await blank, { kind: "decided", decision: "deny" });

  const approved = requestToolApproval({ toolCallId: "reason-3", toolName: "Write", conversationId: "conv-reason", timeoutMs: null });
  answerToolApproval("reason-3", "approve", { reason: "fine" });
  assert.deepEqual(await approved, { kind: "decided", decision: "approve" });

  const long = requestToolApproval({ toolCallId: "reason-4", toolName: "Write", conversationId: "conv-reason", timeoutMs: null });
  answerToolApproval("reason-4", "deny", { reason: "x".repeat(5000) });
  assert.equal((await long).reason.length, 2000);
});
