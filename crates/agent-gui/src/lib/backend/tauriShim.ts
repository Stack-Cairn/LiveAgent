/**
 * 浏览器环境的 __TAURI_INTERNALS__ polyfill（阶段 4 前端网络化的收口点）。
 *
 * 桌面端（Tauri webview）里 __TAURI_INTERNALS__ 由壳注入，本模块什么都不做。
 * 纯浏览器里则把同一套调用面翻译到 agent-backend 的网络 API：
 *   - invoke(cmd, args)            → POST /api/<cmd>（routes_gen.rs 镜像的 180 个 command）
 *   - plugin:event|listen/unlisten → WS /api/events 订阅（{event, payload} 帧）
 *   - get_backend_endpoint         → 本地配置（URL 参数 / localStorage）
 *
 * 这样 58 个直接 import @tauri-apps/api 的文件不需要任何改动。
 *
 * 端点配置：URL 参数 ?backendHost=&backendPort=&token= 会持久化到 localStorage，
 * 之后可省略。默认 127.0.0.1:8443。
 */

type BackendEndpoint = { host: string; port: number; password: string };

const STORAGE_KEY = "liveagent.backend.endpoint";

// 只存在于 Tauri 壳（src-tauri/src/commands）的命令；阶段 4/5 里它们
// 要么消失（gateway_*）要么留在壳里（app_* 窗口/托盘/更新）。
const SHELL_ONLY_PREFIXES = ["app_", "gateway_"];
const SHELL_ONLY_COMMANDS = new Set(["workspace_watch_set", "system_ensure_builtin_skills"]);

function loadEndpoint(): BackendEndpoint {
  const params = new URLSearchParams(window.location.search);
  let stored: Partial<BackendEndpoint> = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    // 损坏的存档当空处理
  }
  const endpoint: BackendEndpoint = {
    host: params.get("backendHost") ?? stored.host ?? "127.0.0.1",
    port: Number(params.get("backendPort") ?? stored.port ?? 8443),
    password: params.get("token") ?? stored.password ?? "",
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(endpoint));
  } catch {
    // 隐私模式下写不进去也无所谓
  }
  return endpoint;
}

export function isNetworkShimActive(): boolean {
  const internals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  return !!internals && !!(internals as Record<string, unknown>).__LIVEAGENT_NETWORK_SHIM__;
}

export function installTauriShim() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return; // 真 Tauri 壳在场，不干预

  const endpoint = loadEndpoint();
  const httpBase = `http://${endpoint.host}:${endpoint.port}`;

  // ---- 回调注册表（transformCallback 的存储） ----
  let nextCallbackId = 1;
  const callbacks = new Map<number, (payload: unknown) => void>();

  // ---- 事件订阅：event 名 → 该事件的 callback id 集合 ----
  const eventSubscribers = new Map<string, Set<number>>();

  // ---- WS 连接（惰性建立，断线自动重连） ----
  let ws: WebSocket | null = null;
  let wsRetryDelay = 500;

  function ensureWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = new URL(`ws://${endpoint.host}:${endpoint.port}/api/events`);
    url.searchParams.set("token", endpoint.password);
    const socket = new WebSocket(url.toString());
    ws = socket;

    socket.onopen = () => {
      wsRetryDelay = 500;
    };
    socket.onmessage = (msg) => {
      let frame: { event?: string; payload?: unknown };
      try {
        frame = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!frame.event) return;
      const subs = eventSubscribers.get(frame.event);
      if (!subs) return;
      // Tauri event 回调收到的是完整 Event 对象 {event, id, payload}
      const eventObj = { event: frame.event, id: 0, payload: frame.payload };
      for (const id of subs) {
        callbacks.get(id)?.(eventObj);
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      // 还有订阅者才重连
      if (eventSubscribers.size > 0) {
        setTimeout(ensureWebSocket, wsRetryDelay);
        wsRetryDelay = Math.min(wsRetryDelay * 2, 10_000);
      }
    };
  }

  async function httpInvoke(cmd: string, args: unknown): Promise<unknown> {
    const response = await fetch(`${httpBase}/api/${cmd}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.password}`,
      },
      body: JSON.stringify(args ?? {}),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Backend call failed for "${cmd}": HTTP ${response.status} - invalid JSON`);
    }
    if (!response.ok) {
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        const errorValue = (parsed as { error: unknown }).error;
        throw typeof errorValue === "string" ? new Error(errorValue) : errorValue;
      }
      throw new Error(`Backend call failed for "${cmd}": HTTP ${response.status}`);
    }
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      return (parsed as { ok: unknown }).ok;
    }
    return parsed;
  }

  function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    // 事件插件：本地翻译成 WS 订阅
    if (cmd === "plugin:event|listen") {
      const eventName = String(args?.event);
      const handlerId = Number(args?.handler);
      let subs = eventSubscribers.get(eventName);
      if (!subs) {
        subs = new Set();
        eventSubscribers.set(eventName, subs);
      }
      subs.add(handlerId);
      ensureWebSocket();
      return Promise.resolve(handlerId);
    }
    if (cmd === "plugin:event|unlisten") {
      const eventName = String(args?.event);
      const handlerId = Number(args?.eventId);
      const subs = eventSubscribers.get(eventName);
      if (subs) {
        subs.delete(handlerId);
        if (subs.size === 0) eventSubscribers.delete(eventName);
      }
      callbacks.delete(handlerId);
      return Promise.resolve();
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      // 前端本地事件：直接分发给本地订阅者
      const eventName = String(args?.event);
      const subs = eventSubscribers.get(eventName);
      if (subs) {
        const eventObj = { event: eventName, id: 0, payload: args?.payload };
        for (const id of subs) callbacks.get(id)?.(eventObj);
      }
      return Promise.resolve();
    }
    // Tauri 壳专属命令：浏览器里由 shim 直接回答
    if (cmd === "get_backend_endpoint") {
      return Promise.resolve({ ...endpoint });
    }
    // 壳专属命令（窗口/托盘/更新/gateway 镜像等）在浏览器没有对应物，
    // 本地拒绝，不打到后端制造 404 噪音。调用方都有 catch。
    if (SHELL_ONLY_PREFIXES.some((p) => cmd.startsWith(p)) || SHELL_ONLY_COMMANDS.has(cmd)) {
      return Promise.reject(new Error(`Shell-only command not available in browser: ${cmd}`));
    }
    // 其他插件命令（窗口/托盘/opener 等）浏览器没有对应物
    if (cmd.startsWith("plugin:")) {
      return Promise.reject(new Error(`Tauri plugin command not available in browser: ${cmd}`));
    }
    return httpInvoke(cmd, args);
  }

  w.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback: (payload: unknown) => void, _once?: boolean) {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc(filePath: string, protocol = "asset") {
      return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
    },
    // 标记这是网络 shim，便于调试与个别 UI 判定
    __LIVEAGENT_NETWORK_SHIM__: true,
  };

  // @tauri-apps/api 的 event.js `_unlisten` 会直接调
  // window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener——同样要垫上。
  // 真正的清理在 plugin:event|unlisten 分支里做，这里只需存在即可。
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event: string, eventId: number) {
      callbacks.delete(eventId);
    },
  };
}

// 模块副作用安装：必须是 main.tsx 的第一个 import，
// 保证任何模块作用域的 invoke/listen 之前 shim 已就位。
installTauriShim();
