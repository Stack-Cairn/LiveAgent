// 应用出站代理（core/Node 侧）。
//
// 旧桌面架构里代理连接由 Rust 反代完成；core 直连上游后，勾选了
// useSystemProxy 的供应商请求改在本进程内走代理。语义与 Rust 侧
// system_proxy.rs 对齐：未启用=直连；启用但配置无效=当场报错（fail
// fast，绝不静默降级为直连）；环回地址恒直连（与 NO_PROXY 注入一致）。
//
// 链路：prepareProxyRequest 给请求打上 x-liveagent-use-system-proxy 标记头，
// installSystemProxyFetch 包装 globalThis.fetch 作为唯一裁决点——剥掉标记头
// （绝不下发上游），按当前代理配置选 dispatcher 出网。代理凭据只存在本进程
// 配置快照里，不进请求头。

import { socksDispatcher } from "fetch-socks";
import { type Dispatcher, fetch as undiciFetch, ProxyAgent } from "undici";

import type { SystemProxyConfig } from "../settings";

export const LIVEAGENT_USE_SYSTEM_PROXY_HEADER = "x-liveagent-use-system-proxy";

// 与 Rust 侧 NO_PROXY_DEFAULT("localhost,127.0.0.1,::1")保持一致。
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let currentConfig: SystemProxyConfig | null = null;
let currentKey = "";
let cachedDispatcher: Dispatcher | null = null;

function configKey(config: SystemProxyConfig): string {
  return JSON.stringify([
    config.enabled,
    config.type,
    config.host,
    config.port,
    config.username,
    config.password,
  ]);
}

/** 设置加载路径统一调用；配置真实变化才重建 dispatcher（对齐 Rust revision 语义）。 */
export function updateSystemProxyConfig(config: SystemProxyConfig): void {
  const key = configKey(config);
  if (key === currentKey) return;
  currentKey = key;
  currentConfig = config;
  const stale = cachedDispatcher;
  cachedDispatcher = null;
  // 旧 dispatcher 允许在途请求收尾后关闭连接池。
  void stale?.close().catch(() => {});
}

function buildDispatcher(config: SystemProxyConfig): Dispatcher {
  if (config.type === "socks5") {
    return socksDispatcher({
      type: 5,
      host: config.host,
      port: config.port,
      userId: config.username || undefined,
      password: config.password || undefined,
    });
  }
  return new ProxyAgent({
    uri: `http://${config.host}:${config.port}`,
    token: config.username
      ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
      : undefined,
  });
}

/**
 * 当前应有的出网 dispatcher。null = 直连（代理未启用）。
 * 启用但配置无效时抛错——与 Rust cached_client() 的 Invalid 分支同语义。
 */
function resolveDispatcher(): Dispatcher | null {
  const config = currentConfig;
  if (!config || !config.enabled) return null;
  if (!config.host || config.port === 0) {
    throw new Error("应用代理已启用，但地址、端口或类型无效");
  }
  if (!cachedDispatcher) {
    cachedDispatcher = buildDispatcher(config);
  }
  return cachedDispatcher;
}

let installed = false;

/**
 * 包装 globalThis.fetch：带标记头的请求剥掉标记后按代理配置出网，
 * 其余请求原样透传。进程启动时装一次；hostedSearchEvents 的探针包装
 * 在其外层，互不影响。
 */
export function installSystemProxyFetch(): void {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  const baseFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // 标准归一：Request 构造器合并 input 与 init，标记头只需查一处。
    const request = new Request(input, init);
    if (!request.headers.has(LIVEAGENT_USE_SYSTEM_PROXY_HEADER)) {
      return baseFetch(input, init);
    }

    // 标记头是进程内信号，绝不下发上游。
    const headers = new Headers(request.headers);
    headers.delete(LIVEAGENT_USE_SYSTEM_PROXY_HEADER);

    const dispatcher = LOOPBACK_HOSTS.has(new URL(request.url).hostname)
      ? null
      : resolveDispatcher();

    const forwardInit = {
      method: request.method,
      // 数组形态同时满足全局与 undici 两套 HeadersInit 类型。
      headers: Array.from(headers) as [string, string][],
      body: request.body,
      signal: request.signal,
      ...(request.body ? { duplex: "half" as const } : {}),
    };
    if (!dispatcher) {
      return baseFetch(request.url, forwardInit as RequestInit);
    }
    // 走 npm undici 的 fetch：bundled fetch 不认外部 dispatcher。
    return (await undiciFetch(request.url, {
      ...forwardInit,
      dispatcher,
    })) as unknown as Response;
  }) as typeof globalThis.fetch;
}
