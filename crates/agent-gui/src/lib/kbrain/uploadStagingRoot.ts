import { invoke } from "@liveagent/app/shims/tauriCore";
import type { KBrainRunOptions } from "./types";

type WorkspaceRoot = NonNullable<KBrainRunOptions["workspace_roots"]>[number];

// 附件暂存区（~/.liveagent/uploads）在工作区之外。消息里会让模型按绝对路径
// Read 附件，因此每次运行都要把暂存区以只读根授权给 K-brain，否则 K-brain 的
// 路径策略会以 "outside the authorized workspace roots" 拒绝读取。
let cached: Promise<string | undefined> | undefined;

function loadUploadStagingRoot(): Promise<string> {
  return invoke<string>("system_upload_staging_base");
}

/** 解析暂存区根；失败（非桌面宿主、命令不可用）时返回 undefined，绝不阻断运行。 */
export function resolveUploadStagingRoot(
  load: () => Promise<string> = loadUploadStagingRoot,
): Promise<string | undefined> {
  if (cached) return cached;
  const pending = load()
    .then((value) => (typeof value === "string" && value.trim() ? value.trim() : undefined))
    .catch(() => undefined);
  cached = pending.then((value) => {
    // 只缓存成功结果，失败时下次运行重试。
    if (value === undefined) cached = undefined;
    return value;
  });
  return cached;
}

export function resetUploadStagingRootCache() {
  cached = undefined;
}

function rootKey(path: string) {
  return path
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/**
 * 把暂存区以只读根追加到运行授权。roots 为空时保持为空：K-brain 在未提供
 * workspace_roots 时默认授权 cwd，只追加暂存区会把这个默认授权挤掉。
 */
export function withUploadStagingRoot(
  roots: readonly WorkspaceRoot[],
  uploadsRoot: string | undefined,
): WorkspaceRoot[] {
  const next = [...roots];
  if (!uploadsRoot?.trim() || next.length === 0) return next;
  const key = rootKey(uploadsRoot.trim());
  if (next.some((root) => rootKey(root.path) === key)) return next;
  next.push({ path: uploadsRoot.trim(), access: "read" });
  return next;
}
