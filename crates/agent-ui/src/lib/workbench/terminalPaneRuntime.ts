import type { TerminalClient, TerminalSession } from "../terminal/types";
import type { TerminalPaneBindingStore } from "./terminalPaneBindingStore";
import type { TerminalWorkbenchSurface, WorkbenchLayout } from "./types";

let terminalSurfaceIdCounter = 0;

/** 布局内稳定的终端 Surface 身份;与 useWindowWorkbench 的 paneId 生成风格一致。 */
export function createTerminalSurfaceId(): string {
  terminalSurfaceIdCounter += 1;
  return `term-${Date.now().toString(36)}-${terminalSurfaceIdCounter.toString(36)}`;
}

/** SSH 建连返回交互提示(host key/认证)时抛出;Pane 内无法应答,需在项目工具面板完成。 */
export class TerminalPaneSshPromptError extends Error {
  constructor() {
    super("SSH session requires an interactive prompt.");
    this.name = "TerminalPaneSshPromptError";
  }
}

/**
 * 自动建会话授权集(窗口级内存):记录本窗口已经显式创建或重启过的
 * surfaceId。当前恢复路径默认按 launchSpec 自动重建;该集合仍由拖入事务
 * 写入并供窗口级运行时协调使用。
 */
export function createTerminalPaneAutoLaunchRegistry() {
  const authorized = new Set<string>();
  return {
    authorize(surfaceId: string): void {
      const key = surfaceId.trim();
      if (key) authorized.add(key);
    },
    isAuthorized(surfaceId: string): boolean {
      return authorized.has(surfaceId.trim());
    },
  };
}

export type TerminalPaneAutoLaunchRegistry = ReturnType<
  typeof createTerminalPaneAutoLaunchRegistry
>;

/**
 * 应用退出护栏:退出流程会先关闭全部终端再退出进程,期间广播的 `closed`
 * 事件不代表用户关闭了单个终端。若照常联动关 Pane,退出前的布局落盘会把
 * 所有终端 Pane 剔除,重启后无法按 launchSpec 恢复。退出确认后置位,
 * closed→关 Pane 的联动随之停摆;失败时复位,应用继续可用。
 */
export function createTerminalAppExitGuard() {
  let exiting = false;
  return {
    mark(): void {
      exiting = true;
    },
    reset(): void {
      exiting = false;
    },
    isExiting(): boolean {
      return exiting;
    },
  };
}

export type EnsureTerminalPaneSessionDeps = {
  client: TerminalClient;
  bindings: Pick<TerminalPaneBindingStore, "set">;
  /** 测试注入;省略时使用模块级共享表。 */
  inflight?: Map<string, Promise<TerminalSession>>;
};

const sharedEnsureInflight = new Map<string, Promise<TerminalSession>>();

/**
 * 按 launchSpec 建立终端会话并写入绑定,返回创建的会话记录(调用方可在
 * `terminal:event` 尚未送达前直接渲染)。同一 surfaceId 的并发调用
 * (StrictMode 双挂载、快速重试)复用同一个 in-flight Promise,保证不会
 * 创建两个 PTY。失败的 Promise 结算后从表中移除,后续重试可再次发起。
 */
export function ensureTerminalPaneSession(
  surface: TerminalWorkbenchSurface,
  deps: EnsureTerminalPaneSessionDeps,
): Promise<TerminalSession> {
  const inflight = deps.inflight ?? sharedEnsureInflight;
  const surfaceId = surface.surfaceId.trim();
  const existing = inflight.get(surfaceId);
  if (existing) return existing;

  const run = (async (): Promise<TerminalSession> => {
    if (surface.kind === "localTerminal") {
      const snapshot = await deps.client.create({
        cwd: surface.launchSpec.cwd,
        projectPathKey: surface.project.projectPathKey,
        shell: surface.launchSpec.shell,
        title: surface.launchSpec.title,
      });
      deps.bindings.set(surfaceId, snapshot.session.id);
      return snapshot.session;
    }
    const result = await deps.client.createSsh({
      cwd: surface.launchSpec.cwd,
      projectPathKey: surface.project.projectPathKey,
      hostId: surface.launchSpec.sshHostId,
      title: surface.launchSpec.title,
      sftpEnabled: surface.launchSpec.sftpEnabled,
    });
    if (!result.snapshot) {
      throw new TerminalPaneSshPromptError();
    }
    deps.bindings.set(surfaceId, result.snapshot.session.id);
    return result.snapshot.session;
  })();

  const tracked = run.finally(() => {
    if (inflight.get(surfaceId) === tracked) {
      inflight.delete(surfaceId);
    }
  });
  inflight.set(surfaceId, tracked);
  return tracked;
}

export type FindTerminalPaneForSessionDeps = {
  bindings: Pick<TerminalPaneBindingStore, "get">;
  layout: Pick<WorkbenchLayout, "panes">;
};

/**
 * 会话被显式关闭(registry `closed` 事件)时定位持有它的终端 Pane。
 * 用绑定而非租约查找:拖入事务先写绑定后开 Pane,宿主取得租约前的
 * "connecting" 窗口也必须命中,否则该窗口内的关闭会留下一个按
 * launchSpec 复活新 PTY 的孤儿 Pane。
 */
export function findTerminalPaneForSession(
  sessionId: string,
  deps: FindTerminalPaneForSessionDeps,
): string | null {
  const key = sessionId.trim();
  if (!key) return null;
  for (const pane of Object.values(deps.layout.panes)) {
    const surface = pane.surface;
    if (surface.kind !== "localTerminal" && surface.kind !== "sshTerminal") continue;
    if (deps.bindings.get(surface.surfaceId) === key) return pane.paneId;
  }
  return null;
}

export type ResolveLiveTerminalSurfaceIdsDeps = {
  client: Pick<TerminalClient, "list">;
  bindings: Pick<TerminalPaneBindingStore, "reconcile" | "surfaceIds">;
};

/**
 * 恢复期对账:用后端存活会话清理死绑定,返回仍然存活的 surfaceId 集合。
 * webview reload 时后端终端注册表仍在,这些 surfaceId 对应的 Pane 直接
 * 重挂会话;绑定被清掉的 Pane 按 launchSpec 自动重建。list 失败
 * 返回 null,绑定保持原样——宿主会在会话列表就绪后清理指向消失会话的
 * 陈旧绑定并自动重建,恢复流程不被阻塞。
 */
export async function resolveLiveTerminalSurfaceIds(
  deps: ResolveLiveTerminalSurfaceIdsDeps,
): Promise<ReadonlySet<string> | null> {
  try {
    const sessions = await deps.client.list();
    const liveSessionIds = new Set(sessions.map((session) => session.id));
    deps.bindings.reconcile(liveSessionIds);
    return new Set(deps.bindings.surfaceIds());
  } catch {
    return null;
  }
}
