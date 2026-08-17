import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback } from "react";
import type { WorkspaceProject } from "../../../lib/settings";
import { listWorkspaceRootGrants } from "../../../lib/workspaceRootGrants";

// 桌面端传输层:检查点数据只存在于桌面本机,直接走 Tauri invoke。
// WebUI 的对应实现在 GatewayAppView(经网关 checkpoint 直通臂中继到同一批命令)。
const desktopCheckpointRewindClient: CheckpointRewindClient = {
  list: (conversationId) => invoke("checkpoint_list", { conversation_id: conversationId }),
  preview: ({ conversationId, turnSeq, authorizedRoots }) =>
    invoke("checkpoint_diff_stats", {
      conversation_id: conversationId,
      turn_seq: turnSeq,
      authorized_roots: authorizedRoots,
    }),
  rewind: ({ conversationId, turnSeq, authorizedRoots, expected }) =>
    invoke("checkpoint_rewind_code", {
      conversation_id: conversationId,
      turn_seq: turnSeq,
      authorized_roots: authorizedRoots,
      expected,
    }),
};

export function DesktopCheckpointRewindProvider(props: {
  children: ReactNode;
  conversationId: string;
  /** 当前会话的工作区根：授权集合的基准项。 */
  workspaceRoot?: string;
  /** 当前激活项目：用于取额外授权根（workspace root grants）。 */
  project?: Pick<WorkspaceProject, "id" | "path"> | null;
  disabled?: boolean;
  /** 回退完成后回调(通知/转录记录由宿主页面处理)。 */
  onRewound?: (info: CheckpointRewoundInfo) => void;
}) {
  const { children, conversationId, workspaceRoot, project, disabled, onRewound } = props;

  // 回退授权的唯一来源：当前会话工作区根 + 仍处于 active 且可写的额外授权根。
  // 后端只认这个集合里的 root，记录里存的绝对路径本身不构成授权。
  //
  // access 必须一并过滤：回退是写操作（覆盖/删除），只读根不该被写。普通
  // 文件工具把 access 一路带到 pathUtils 的 canMutate 门禁上拦，而这里只往
  // 后端传路径、access 当场就丢了，所以这道门只能在这一步补上。
  const resolveAuthorizedRoots = useCallback(async () => {
    const roots: string[] = [];
    const push = (raw?: string | null) => {
      const value = raw?.trim();
      if (value && !roots.includes(value)) roots.push(value);
    };
    push(workspaceRoot);
    if (project) {
      try {
        const grants = await listWorkspaceRootGrants(project);
        for (const grant of grants) {
          if (grant.state === "active" && grant.access === "write") push(grant.canonicalPath);
        }
      } catch {
        // 取不到额外授权根时只保留工作区根：宁可少回退，不可越权写入。
      }
    }
    return roots;
  }, [project, workspaceRoot]);

  return (
    <CheckpointRewindProvider
      client={desktopCheckpointRewindClient}
      conversationId={conversationId}
      disabled={disabled}
      resolveAuthorizedRoots={resolveAuthorizedRoots}
      onRewound={onRewound}
    >
      {children}
    </CheckpointRewindProvider>
  );
}
