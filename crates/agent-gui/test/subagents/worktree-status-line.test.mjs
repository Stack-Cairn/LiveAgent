import assert from "node:assert/strict";
import test from "node:test";
import { createAgentToolCall, createRecordingContext, createSubagentHarness } from "./harness.mjs";

/**
 * worktree provision 失败时的状态行收口。
 *
 * 回归背景：`run.ts` 在调 `worktree.create` 前设过一行
 * 「Creating isolated worktree for …」，而清理它的语句在 `settleWorktree` 末尾；
 * 那个函数首行是 `if (!worktree) return`，create 失败时直接返回，够不到清理。
 * 结果子代理早已失败返回，UI 却一直停在那句状态上直到整轮结束由 clearToolStatus
 * 兜底 —— 用户看到的就是「一直转圈、没有回应」。
 *
 * 这组测试锁死两件事：失败路径必须把状态行摘回 null，且报告必须是终态而非悬挂。
 */

const WORKTREE_AGENT = {
  id: "builder-a",
  prompt: "Apply the change in an isolated worktree.",
  name: "Builder",
  mode: "worktree",
};

function lastStatus(emittedStatuses) {
  return emittedStatuses.at(-1);
}

test("worktree create failure clears the provisioning status line", async () => {
  const harness = await createSubagentHarness({
    worktreeOptions: { createError: new Error("fatal: could not create work tree dir") },
  });
  const parentToolCall = createAgentToolCall({ agents: [WORKTREE_AGENT] });
  const recording = createRecordingContext(parentToolCall);

  const result = await harness.bundle.executeToolCall(
    parentToolCall,
    undefined,
    recording.context,
  );

  // 状态行必须被摘掉：null 是「没有进行中的操作」的唯一表示。
  assert.equal(
    lastStatus(recording.emittedStatuses),
    null,
    "create 失败后状态行必须回到 null，否则 UI 会一直显示正在创建 worktree",
  );
  // 而且确实设过那一行——否则这个测试就是空转。
  assert.ok(
    recording.emittedStatuses.some(
      (status) => typeof status === "string" && status.includes("worktree"),
    ),
    "应当先设过 worktree provisioning 状态行",
  );

  // 报告必须是终态，不能悬挂。
  const report = result.details.agents[0];
  assert.equal(report.status, "failed");
  assert.match(report.error, /work tree|worktree/i);
});

test("worktree happy path also ends with a cleared status line", async () => {
  const harness = await createSubagentHarness();
  const parentToolCall = createAgentToolCall({ agents: [WORKTREE_AGENT] });
  const recording = createRecordingContext(parentToolCall);

  const result = await harness.bundle.executeToolCall(
    parentToolCall,
    undefined,
    recording.context,
  );

  assert.equal(result.details.agents[0].status, "completed");
  assert.equal(
    lastStatus(recording.emittedStatuses),
    null,
    "成功路径同样必须把状态行摘回 null",
  );
});
