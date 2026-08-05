/**
 * 后端端点的来源与凭据存储。
 *
 * 两种运行形态，一个数据结构，一条解析链：
 *   - 存档端点（URL 参数 / localStorage，由登录页或连接页写入）永远优先。
 *   - 桌面壳在存档为空时落回壳注入的内嵌后端端点（`get_backend_endpoint`
 *     走原生 IPC 拿 host/port/随机密码），开箱零配置。
 *   - 纯浏览器没有兜底：存档为空就进登录页。
 *
 * 「本地」和「远程」的差别到此为止就只剩这三个字段了。
 */

export type BackendEndpoint = {
  host: string;
  port: number;
  password: string;
  /** true 表示 https/wss。浏览器连远程后端时需要。 */
  secure?: boolean;
};

const STORAGE_KEY = "liveagent.backend.endpoint";

/** 旧 Gateway 时代残留的 token。它的存在说明这台机器上跑过 v1。 */
const LEGACY_GATEWAY_TOKEN_KEY = "liveagent.gateway.token";

type TauriInternals = {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
  __LIVEAGENT_NETWORK_SHIM__?: boolean;
};

/**
 * 真 Tauri 壳注入的 internals，如果在的话。
 *
 * 注意这里**只读不写**：Tauri v2 的初始化脚本用 `Object.defineProperty` 定义
 * `window.__TAURI_INTERNALS__` 及其 invoke/transformCallback，全部
 * non-writable + non-configurable（见 tauri 2.x scripts/core.js）。壳内没有
 * 任何办法替换掉 invoke——所以壳内的分流靠模块层（vite alias 到
 * lib/backend/tauriCore.ts），不靠改 internals。
 */
export function getNativeInternals(): TauriInternals | null {
  const internals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as
    | TauriInternals
    | undefined;
  if (!internals || typeof internals.invoke !== "function") return null;
  // 我们自己在浏览器里装的 polyfill 不算「壳」。
  if (internals.__LIVEAGENT_NETWORK_SHIM__) return null;
  return internals;
}

/** 跑在 Tauri 桌面壳里？（决定是否需要登录页） */
export function isDesktopShell(): boolean {
  return getNativeInternals() !== null;
}

/** 凭据缺失。登录页据此判断「该让用户输密码了」，而不是当成网络故障。 */
export class MissingCredentialsError extends Error {
  constructor() {
    super("尚未配置后端地址与密码");
    this.name = "MissingCredentialsError";
  }
}

function readStoredEndpoint(): BackendEndpoint | null {
  let stored: Partial<BackendEndpoint> = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<BackendEndpoint>;
  } catch {
    // 损坏的存档当空处理
  }

  // URL 参数优先并顺手持久化：?backendHost=&backendPort=&token=&secure=
  // 让「发一条链接就能连上远程后端」这件事不需要先过登录页。
  const params = new URLSearchParams(window.location.search);
  const host = params.get("backendHost") ?? stored.host;
  const port = Number(params.get("backendPort") ?? stored.port);
  const password = params.get("token") ?? stored.password;
  const secure = params.has("secure")
    ? params.get("secure") !== "false"
    : (stored.secure ?? window.location.protocol === "https:");

  if (!host || !Number.isFinite(port) || port <= 0 || !password) return null;

  const endpoint: BackendEndpoint = { host, port, password, secure };
  if (params.has("backendHost") || params.has("token")) storeEndpoint(endpoint);
  return endpoint;
}

export function storeEndpoint(endpoint: BackendEndpoint): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(endpoint));
  } catch {
    // 隐私模式下写不进去：这一次会话仍然可用，下次要重新登录
  }
}

export function clearStoredEndpoint(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}

/** 存档里的端点，登录页用来预填。 */
export function peekStoredEndpoint(): BackendEndpoint | null {
  return readStoredEndpoint();
}

export function httpBaseUrl(endpoint: BackendEndpoint): string {
  return `${endpoint.secure ? "https" : "http"}://${endpoint.host}:${endpoint.port}`;
}

export function wsBaseUrl(endpoint: BackendEndpoint): string {
  return `${endpoint.secure ? "wss" : "ws"}://${endpoint.host}:${endpoint.port}`;
}

let cached: BackendEndpoint | null = null;
let pending: Promise<BackendEndpoint> | null = null;

/**
 * 壳内向 Rust 要端点。内嵌后端是 setup 里 spawn 起来的，前端跑起来时它可能
 * 还没监听——命令会返回「后端服务尚未启动」。这里退避重试到拿到为止：
 * shim 的安装必须是同步的，但所有真正的调用都 await 这个 Promise，
 * 于是「端点未就绪期间的调用」自然排成队列，不需要额外的队列结构。
 */
async function askShellForEndpoint(internals: TauriInternals): Promise<BackendEndpoint> {
  let delay = 50;
  let waited = 0;
  for (;;) {
    try {
      return (await internals.invoke("get_backend_endpoint")) as BackendEndpoint;
    } catch (error) {
      if (waited >= 30_000) {
        throw new Error(
          `内嵌后端启动超时（30s）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      waited += delay;
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

export function resolveEndpoint(): Promise<BackendEndpoint> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;

  pending = (async () => {
    // 解析链：用户手填/URL 注入的存档端点 > 壳内嵌后端。壳内用户在连接页
    // 填了远程地址就走存档；没填过存档为空，落回内嵌后端。浏览器没有壳，
    // 存档为空就是凭据缺失。
    const internals = getNativeInternals();
    const endpoint =
      readStoredEndpoint() ?? (internals ? await askShellForEndpoint(internals) : null);
    if (!endpoint) throw new MissingCredentialsError();
    cached = endpoint;
    return endpoint;
  })();

  // 失败不缓存：登录页重试或后端稍后起来都应该能重新解析。
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/** 登录成功 / 换端点后调用：丢掉缓存，下一次调用重新解析。 */
export function resetEndpoint(endpoint?: BackendEndpoint): void {
  cached = endpoint ?? null;
  pending = null;
  if (endpoint) storeEndpoint(endpoint);
}

/** 这台机器上有旧 Gateway(v1) 的痕迹吗？用于登录页给迁移提示。 */
export function hasLegacyGatewayLeftovers(): boolean {
  try {
    return (localStorage.getItem(LEGACY_GATEWAY_TOKEN_KEY) ?? "").trim() !== "";
  } catch {
    return false;
  }
}
