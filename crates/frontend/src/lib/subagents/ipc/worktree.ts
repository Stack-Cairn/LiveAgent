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

export const tauriSubagentWorktreeIpc: SubagentWorktreeIpc = {
  create: async (input) =>
    stripNulls(await invoke<SubagentWorktreeInfo>("subagent_worktree_create", { input })),
  status: async (input) =>
    stripNulls(await invoke<SubagentWorktreeStatus>("subagent_worktree_status", { input })),
  apply: async (input) =>
    stripNulls(await invoke<SubagentWorktreeApplyResult>("subagent_worktree_apply", { input })),
  cleanup: async (input) =>
    stripNulls(
      await invoke<SubagentWorktreeCleanupResult>("subagent_worktree_cleanup", {
        input: { ...input, dryRun: false, force: true, deleteBranch: true },
      }),
    ),
};
