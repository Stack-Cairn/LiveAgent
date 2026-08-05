/**
 * 后端的显式调用面：不经 `invoke()` 的那批调用点（chat_send、
 * tool_approval_respond、conversation_live 快照）直接用这里。
 *
 * 阶段 4 之后它只是 transport.ts 的一层薄命名——端点解析、鉴权、WS 连接
 * 全部在 transport 里，所以整个前端只有一条 WS、一份重连退避。
 */

import {
  backendGet,
  backendInvoke,
  disconnectBackendEvents,
  subscribeAllBackendEvents,
} from "./transport";

export async function backendFetch<T = unknown>(
  command: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return backendInvoke<T>(command, args, { signal });
}

/**
 * GET 型后端调用：参数走 query string。engine_proxy 的快照类端点
 * （如 conversation_live）是 GET，与命令式 POST 路由不同。
 */
export async function backendFetchGet<T = unknown>(
  command: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  return backendGet<T>(command, params, signal);
}

type EventHandler = (event: { event: string; payload: unknown }) => void;

export function subscribeEvents(handler: EventHandler): () => void {
  return subscribeAllBackendEvents(handler);
}

export function disconnectWebSocket(): void {
  disconnectBackendEvents();
}
