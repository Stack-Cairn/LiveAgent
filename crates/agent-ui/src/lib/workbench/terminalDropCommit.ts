import { terminalSessionBelongsToProject } from "../terminal/sessionStore";
import type { TerminalSession } from "../terminal/types";
import type { WorkbenchDropTarget, WorkbenchMoveTarget, WorkbenchOpenTarget } from "./index";
import type { TerminalPaneBindingStore } from "./terminalPaneBindingStore";
import type { TerminalPaneLeaseStore } from "./terminalPaneLeaseStore";
import type { ProjectRef, TerminalWorkbenchSurface, WorkbenchLayout } from "./types";
import type { WorkbenchDragPayload } from "./useWorkbenchDragSession";

export type TerminalDropPayload = Extract<
  WorkbenchDragPayload,
  { kind: "terminalSession" } | { kind: "newTerminal" }
>;

export type TerminalDropDeps = {
  layout: WorkbenchLayout;
  sessions: readonly TerminalSession[];
  lease: Pick<TerminalPaneLeaseStore, "paneIdFor" | "acquire">;
  bindings: Pick<TerminalPaneBindingStore, "set" | "delete">;
  /** newTerminal 需要真实 cwd;ProjectRef 只有 pathKey,由调用方解析回项目路径。 */
  resolveProjectPath(project: ProjectRef): string | null;
  createSurfaceId(): string;
  /** 本窗口显式创建的 surface 授权自动建会话;恢复的 Pane 无此授权走休眠占位。 */
  authorizeAutoLaunch(surfaceId: string): void;
  openTerminalSurface(
    surface: TerminalWorkbenchSurface,
    target: WorkbenchOpenTarget,
  ): { paneId: string } | null;
  movePane(paneId: string, target: WorkbenchMoveTarget): boolean;
  focusPane(paneId: string): unknown;
};

export type TerminalDropResult =
  | { action: "moved" | "focused"; paneId: string }
  | { action: "opened"; paneId: string; surfaceId: string }
  | { action: "ignored" };

/** 从既有会话记录构造可持久化的启动规格;sessionId 本身绝不进入 Surface。 */
export function terminalSurfaceForSession(
  session: TerminalSession,
  surfaceId: string,
  project: ProjectRef,
): TerminalWorkbenchSurface {
  if (session.kind === "ssh" && session.ssh?.hostId) {
    return {
      kind: "sshTerminal",
      surfaceId,
      project,
      launchSpec: {
        cwd: session.cwd,
        sshHostId: session.ssh.hostId,
        title: session.title || undefined,
        sftpEnabled: session.ssh.sftpEnabled || undefined,
      },
    };
  }
  return {
    kind: "localTerminal",
    surfaceId,
    project,
    launchSpec: {
      cwd: session.cwd,
      shell: session.shell || undefined,
      title: session.title || undefined,
    },
  };
}

/**
 * 终端拖拽的 drop 事务(设计文档"几何先行"):布局立即提交,PTY 由
 * TerminalPaneHost 挂载后异步保障。既有会话拖入时先写绑定再开 Pane,
 * 让宿主直接复用会话而不是新建;已在画板中的会话只移动/聚焦。
 */
export function commitTerminalDrop(
  payload: TerminalDropPayload,
  target: WorkbenchDropTarget,
  deps: TerminalDropDeps,
): TerminalDropResult {
  // 非 pane 拖拽在命中归一化中已被自动贴靠,pane-center 到这里只能是陈旧命中。
  if (target.kind === "pane-center") return { action: "ignored" };

  if (payload.kind === "terminalSession") {
    const leasedPaneId = deps.lease.paneIdFor(payload.sessionId);
    if (leasedPaneId && deps.layout.panes[leasedPaneId]) {
      if (target.kind === "canvas-empty") {
        deps.focusPane(leasedPaneId);
        return { action: "focused", paneId: leasedPaneId };
      }
      return deps.movePane(leasedPaneId, target)
        ? { action: "moved", paneId: leasedPaneId }
        : { action: "ignored" };
    }
    const session = deps.sessions.find((entry) => entry.id === payload.sessionId);
    if (!session) return { action: "ignored" };
    // 跨项目投放:会话的 project 与目标窗口的 project 不同源时拒绝,否则
    // 会造出一个「project 声称 A、cwd 实际在 B」的 surface。后端建会话时
    // 还会独立复核,这里只是让越界在投放阶段就无声失败而非留下坏 Pane。
    if (!terminalSessionBelongsToProject(session, payload.project.projectPathKey)) {
      return { action: "ignored" };
    }
    const surfaceId = deps.createSurfaceId();
    const surface = terminalSurfaceForSession(session, surfaceId, payload.project);
    // 先绑定后开 Pane:宿主挂载即可命中既有会话,不触发 ensure 新建。
    deps.bindings.set(surfaceId, session.id);
    const opened = deps.openTerminalSurface(surface, target);
    if (!opened) {
      deps.bindings.delete(surfaceId);
      return { action: "ignored" };
    }
    // 同步占住租约,让 Right Dock 在同一次渲染里卸掉视口,避免画板宿主
    // 挂载时与 dock 的 XTermViewport 双 attach。宿主随后 acquire 幂等。
    try {
      deps.lease.acquire(payload.sessionId, opened.paneId);
    } catch {
      // 已被其它 Pane 占用时仍打开布局;宿主会进入 lease 错误态。
    }
    return { action: "opened", paneId: opened.paneId, surfaceId };
  }

  const cwd = deps.resolveProjectPath(payload.project);
  if (!cwd) return { action: "ignored" };
  const surfaceId = deps.createSurfaceId();
  // 用户显式拖入"新建终端":授权宿主挂载后自动建 PTY(几何先行,创建异步)。
  deps.authorizeAutoLaunch(surfaceId);
  const opened = deps.openTerminalSurface(
    {
      kind: "localTerminal",
      surfaceId,
      project: payload.project,
      launchSpec: { cwd },
    },
    target,
  );
  return opened ? { action: "opened", paneId: opened.paneId, surfaceId } : { action: "ignored" };
}
