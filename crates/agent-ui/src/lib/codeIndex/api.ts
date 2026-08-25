// Code-index 命令的类型化 invoke 绑定（docs/design/code-index.md）。
// memory/api.ts 同款：走 tauriCore shim——桌面端直达 Rust；WebUI shim 对
// code_index_* 抛“桌面端专属”错误，调用方按能力降级（状态区显示提示）。

import { invoke } from "@liveagent/app/shims/tauriCore";

export type CodeIndexJobSnapshot = {
  jobId: string;
  workdir: string;
  phase:
    | "queued"
    | "downloading-model"
    | "walking"
    | "chunking"
    | "embedding"
    | "done"
    | "cancelled"
    | "error"
    | string;
  totalFiles: number;
  processedFiles: number;
  indexedChunks: number;
  message?: string | null;
  error?: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number | null;
};

export type CodeIndexStatus = {
  indexed: boolean;
  fileCount: number;
  chunkCount: number;
  dbSizeBytes: number;
  lastFullIndexAt?: number | null;
  embeddingModel?: string | null;
  activeJob?: CodeIndexJobSnapshot | null;
};

export function codeIndexEnable(workdir: string): Promise<CodeIndexJobSnapshot> {
  return invoke<CodeIndexJobSnapshot>("code_index_enable", { args: { workdir } });
}

export function codeIndexDisable(workdir: string): Promise<void> {
  return invoke<void>("code_index_disable", { args: { workdir } });
}

export function codeIndexRebuild(workdir: string): Promise<CodeIndexJobSnapshot> {
  return invoke<CodeIndexJobSnapshot>("code_index_rebuild", { args: { workdir } });
}

export function codeIndexStatus(workdir: string): Promise<CodeIndexStatus> {
  return invoke<CodeIndexStatus>("code_index_status", { args: { workdir } });
}

export function codeIndexJobStatus(jobId: string): Promise<CodeIndexJobSnapshot> {
  return invoke<CodeIndexJobSnapshot>("code_index_job_status", { args: { jobId } });
}

export function codeIndexJobCancel(jobId: string): Promise<CodeIndexJobSnapshot> {
  return invoke<CodeIndexJobSnapshot>("code_index_job_cancel", { args: { jobId } });
}

export function formatCodeIndexDbSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}
