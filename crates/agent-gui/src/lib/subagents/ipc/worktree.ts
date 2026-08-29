import { invoke } from "@tauri-apps/api/core";

import type {
  SubagentWorktreeApplyResult,
  SubagentWorktreeCleanupResult,
  SubagentWorktreeInfo,
  SubagentWorktreeStatus,
} from "../types";

export type SubagentWorktreeIpc = {
  create: (input: { workdir: string; label: string }) => Promise<SubagentWorktreeInfo>;
  status: (input: {
    worktreeRoot: string;
    maxDiffChars: number;
  }) => Promise<SubagentWorktreeStatus>;
  apply: (input: {
    parentWorkdir: string;
    worktreeRoot: string;
    /** 父对话检查点上下文;后端在改写父工作区前对 apply 路径捕获前像。 */
    checkpoint?: { conversationId: string; turnId: string };
  }) => Promise<SubagentWorktreeApplyResult>;
  cleanup: (input: {
    worktreeRoot: string;
    branchName?: string;
  }) => Promise<SubagentWorktreeCleanupResult>;
};

// Rust serializes Option::None as null; drop nulls so optional TS fields
// stay absent.
function stripNulls<T extends object>(record: T): T {
  const output = { ...record } as Record<string, unknown>;
  for (const key of Object.keys(output)) {
    if (output[key] === null) delete output[key];
  }
  return output as T;
}

/**
 * 前端侧的最后一道兜底。
 *
 * Rust 侧现在给每次 git 调用加了 120s 硬超时，但单个 worktree 命令可能连续跑多条
 * git（例如 apply 会先 diff 再 apply 再回读状态），累计仍可能很久；而 `invoke()`
 * 不接受 AbortSignal，用户按 Stop 也无法打断一次已经在飞的调用。这里保证 Promise
 * 一定会 settle：超时后子代理 run 会走 failed 分支并报出可读原因，而不是永久 pending
 * 让整轮对话卡住。
 *
 * 注意这只解除前端的等待，后端那次 git 仍在跑到自己的超时为止 —— 这是可接受的：
 * worktree 操作是幂等或可重入的，真正要避免的是 UI 无限期挂住。
 */
const WORKTREE_IPC_TIMEOUT_MS = 180_000;

function withIpcTimeout<T>(label: string, run: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `subagent worktree ${label} did not respond within ${Math.round(
            WORKTREE_IPC_TIMEOUT_MS / 1000,
          )}s`,
        ),
      );
    }, WORKTREE_IPC_TIMEOUT_MS);
    run.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const tauriSubagentWorktreeIpc: SubagentWorktreeIpc = {
  create: async (input) =>
    stripNulls(
      await withIpcTimeout(
        "create",
        invoke<SubagentWorktreeInfo>("subagent_worktree_create", { input }),
      ),
    ),
  status: async (input) =>
    stripNulls(
      await withIpcTimeout(
        "status",
        invoke<SubagentWorktreeStatus>("subagent_worktree_status", { input }),
      ),
    ),
  apply: async (input) =>
    stripNulls(
      await withIpcTimeout(
        "apply",
        invoke<SubagentWorktreeApplyResult>("subagent_worktree_apply", { input }),
      ),
    ),
  cleanup: async (input) =>
    stripNulls(
      await withIpcTimeout(
        "cleanup",
        invoke<SubagentWorktreeCleanupResult>("subagent_worktree_cleanup", {
          input: { ...input, dryRun: false, force: true, deleteBranch: true },
        }),
      ),
    ),
};
