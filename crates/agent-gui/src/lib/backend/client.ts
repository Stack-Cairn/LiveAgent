import { invoke } from "@tauri-apps/api/core";

type BackendEndpoint = {
  host: string;
  port: number;
  password: string;
};

let cachedEndpoint: BackendEndpoint | null = null;
let endpointPromise: Promise<BackendEndpoint> | null = null;

async function getBackendEndpoint(): Promise<BackendEndpoint> {
  if (cachedEndpoint) {
    return cachedEndpoint;
  }

  if (endpointPromise) {
    return endpointPromise;
  }

  endpointPromise = (async () => {
    try {
      const result = await invoke<{
        host: string;
        port: number;
        password: string;
      }>("get_backend_endpoint");
      cachedEndpoint = result;
      return result;
    } catch (error) {
      endpointPromise = null;
      throw new Error(
        `Failed to get backend endpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  return endpointPromise;
}

export async function backendFetch<T = unknown>(
  command: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const endpoint = await getBackendEndpoint();
  const url = `http://${endpoint.host}:${endpoint.port}/api/${command}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.password}`,
    },
    body: JSON.stringify(args),
    signal,
  });

  return parseBackendResponse<T>(command, response);
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
  const endpoint = await getBackendEndpoint();
  const url = new URL(`http://${endpoint.host}:${endpoint.port}/api/${command}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${endpoint.password}` },
    signal,
  });

  return parseBackendResponse<T>(command, response);
}

async function parseBackendResponse<T>(command: string, response: Response): Promise<T> {
  const text = await response.text();

  // 解析响应，处理空 body
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error(
      `Backend call failed for "${command}": HTTP ${response.status} - invalid JSON response`,
    );
  }

  if (!response.ok) {
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const errorValue = (parsed as any).error;
      if (typeof errorValue === "string") {
        throw new Error(errorValue);
      }
      throw errorValue;
    }
    throw new Error(`Backend call failed for "${command}": HTTP ${response.status}`);
  }

  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    throw new Error(
      `Backend call failed for "${command}": HTTP ${response.status} - missing ok field in response`,
    );
  }

  return (parsed as { ok: T }).ok;
}

type EventHandler = (event: { event: string; payload: unknown }) => void;

let wsConnection: WebSocket | null = null;
let wsConnecting: Promise<WebSocket> | null = null;
const eventHandlers = new Set<EventHandler>();

async function connectWebSocket(): Promise<WebSocket> {
  if (wsConnection) {
    return wsConnection;
  }

  if (wsConnecting) {
    return wsConnecting;
  }

  wsConnecting = (async () => {
    const endpoint = await getBackendEndpoint();
    const wsUrl = new URL(`ws://${endpoint.host}:${endpoint.port}/api/events`);
    wsUrl.searchParams.set("token", endpoint.password);
    const ws = new WebSocket(wsUrl.toString());

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        wsConnection = ws;
        wsConnecting = null;
        resolve();
      };

      ws.onerror = (error) => {
        clearTimeout(timeout);
        wsConnecting = null;
        reject(error);
      };
    });

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.event && typeof message.event === "string") {
          eventHandlers.forEach((handler) => {
            try {
              handler({ event: message.event, payload: message.payload });
            } catch (error) {
              console.error("Event handler error", error);
            }
          });
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message", error);
      }
    };

    ws.onclose = () => {
      wsConnection = null;
      wsConnecting = null;
    };

    ws.onerror = () => {
      wsConnection = null;
      wsConnecting = null;
    };

    return ws;
  })();

  return wsConnecting;
}

export function subscribeEvents(handler: EventHandler): () => void {
  eventHandlers.add(handler);

  // 异步连接 WebSocket，错误只 console.warn，不中断订阅
  connectWebSocket().catch((error) => {
    console.warn("Failed to connect to backend events WebSocket", error);
  });

  // 返回取消订阅函数
  return () => {
    eventHandlers.delete(handler);
  };
}

export function disconnectWebSocket(): void {
  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }
}
