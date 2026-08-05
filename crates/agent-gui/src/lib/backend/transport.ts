/**
 * 前端到后端的唯一传输层：HTTP 打命令，WS 收事件。
 *
 * 上面盖着两层壳：
 *   - lib/backend/tauriCore.ts / tauriEvent.ts —— 业务代码的 invoke/listen
 *   - lib/backend/client.ts —— backendFetch/subscribeEvents 这套显式 API
 * 两条路都落到这里，所以整个前端只有一条 WS 连接、一份端点解析。
 */

import {
  type BackendEndpoint,
  httpBaseUrl,
  resolveEndpoint,
  wsBaseUrl,
} from "./endpoint";

/** 密码不对。登录页据此提示，而不是笼统地说「连接失败」。 */
export class UnauthorizedError extends Error {
  constructor(message = "后端拒绝了这个密码（401）") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

async function parseResponse<T>(command: string, response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Backend call failed for "${command}": HTTP ${response.status} - invalid JSON`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new UnauthorizedError();
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const errorValue = (parsed as { error: unknown }).error;
      throw typeof errorValue === "string" ? new Error(errorValue) : errorValue;
    }
    throw new Error(`Backend call failed for "${command}": HTTP ${response.status}`);
  }

  // routes_gen 的 respond() 统一包 {ok: ...}；engine_proxy 的快照类 GET 不包。
  // 有就拆，没有就原样给——比「没有 ok 字段就报错」少一类假故障。
  if (parsed && typeof parsed === "object" && "ok" in parsed) {
    return (parsed as { ok: T }).ok;
  }
  return parsed as T;
}

/** POST /api/<command>，命令式调用。 */
export async function backendInvoke<T = unknown>(
  command: string,
  args?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const endpoint = await resolveEndpoint();
  const response = await fetch(`${httpBaseUrl(endpoint)}/api/${command}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.password}`,
    },
    body: JSON.stringify(args ?? {}),
    signal: options?.signal,
  });
  return parseResponse<T>(command, response);
}

/** GET /api/<command>?...，快照类调用。 */
export async function backendGet<T = unknown>(
  command: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const endpoint = await resolveEndpoint();
  const url = new URL(`${httpBaseUrl(endpoint)}/api/${command}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${endpoint.password}` },
    signal,
  });
  return parseResponse<T>(command, response);
}

// ---------------------------------------------------------------------------
// 事件：一条 WS，按事件名分发
// ---------------------------------------------------------------------------

export type BackendEvent = { event: string; payload: unknown };
type EventHandler = (event: BackendEvent) => void;

const byName = new Map<string, Set<EventHandler>>();
const wildcard = new Set<EventHandler>();

let socket: WebSocket | null = null;
let connecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 500;

function hasSubscribers(): boolean {
  return byName.size > 0 || wildcard.size > 0;
}

function dispatch(frame: BackendEvent) {
  for (const handler of byName.get(frame.event) ?? []) {
    try {
      handler(frame);
    } catch (error) {
      console.error(`事件处理器抛错（${frame.event}）`, error);
    }
  }
  for (const handler of wildcard) {
    try {
      handler(frame);
    } catch (error) {
      console.error(`事件处理器抛错（${frame.event}）`, error);
    }
  }
}

function ensureSocket() {
  if (connecting || reconnectTimer !== null) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connecting = true;

  void resolveEndpoint()
    .then((endpoint: BackendEndpoint) => {
      // 浏览器的 WebSocket API 设不了 Authorization header，后端 ws_handler
      // 因此接受 ?token=。
      const url = new URL(`${wsBaseUrl(endpoint)}/api/events`);
      url.searchParams.set("token", endpoint.password);
      const next = new WebSocket(url.toString());
      socket = next;
      connecting = false;

      next.onopen = () => {
        retryDelay = 500;
      };
      next.onmessage = (message) => {
        let frame: Partial<BackendEvent>;
        try {
          frame = JSON.parse(String(message.data)) as Partial<BackendEvent>;
        } catch {
          return;
        }
        if (typeof frame.event !== "string") return;
        dispatch({ event: frame.event, payload: frame.payload });
      };
      next.onclose = () => {
        if (socket === next) socket = null;
        scheduleReconnect();
      };
      next.onerror = () => {
        // onclose 紧随其后，重连逻辑只写一处
      };
    })
    .catch((error) => {
      connecting = false;
      console.warn("后端事件 WS 连接失败", error);
      scheduleReconnect();
    });
}

/**
 * 退避重连。全局只允许一个待触发的定时器：订阅者有十几个（每个 listen 都会
 * 调 ensureSocket），每次失败也会调一次——不去重的话退避链会成倍增长，
 * 后端没起来时前端会拿几十条重连打自己。
 */
function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  if (!hasSubscribers()) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 10_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, delay);
}

/** 订阅某个后端事件，返回取消函数。 */
export function subscribeBackendEvent(event: string, handler: EventHandler): () => void {
  let handlers = byName.get(event);
  if (!handlers) {
    handlers = new Set();
    byName.set(event, handlers);
  }
  handlers.add(handler);
  ensureSocket();

  return () => {
    const current = byName.get(event);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) byName.delete(event);
  };
}

/** 订阅全部后端事件（lib/backend/client.ts 的 subscribeEvents 用）。 */
export function subscribeAllBackendEvents(handler: EventHandler): () => void {
  wildcard.add(handler);
  ensureSocket();
  return () => {
    wildcard.delete(handler);
  };
}

/** 本地事件回环：前端 emit 的事件不上网，直接分发给本地订阅者。 */
export function dispatchLocalEvent(event: string, payload: unknown): void {
  dispatch({ event, payload });
}

/** 登出 / 换端点时断开，让下一次订阅用新凭据立刻重连（不带着旧的退避）。 */
export function disconnectBackendEvents(): void {
  const current = socket;
  socket = null;
  retryDelay = 500;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  current?.close();
}
