import type { ProviderId } from "../settings";
import { LIVEAGENT_USE_SYSTEM_PROXY_HEADER } from "./systemProxy";

// 本地反代已随桌面 Gateway 架构删除（proxy_get_server_info 在删除清单）：
// 反代的存在理由是 WebView 的 fetch 会丢弃 User-Agent/Cookie 等 forbidden
// header names、且系统代理凭据只在 Rust 侧。core 跑在 Node（backend spawn
// 的引擎进程），fetch/undici 没有 forbidden header 限制，请求头直接下发，
// provider 请求直连上游。勾选 useSystemProxy 的供应商打标记头，由
// systemProxy.ts 的 fetch 包装在出网前剥掉并换代理 dispatcher。

export type PreparedProxyRequest = {
  baseUrl: string;
  headers: Record<string, string>;
};

/** 各请求入口共用的 URL 安全校验：绝对地址 + http(s) + 禁内嵌凭据。 */
function parseAbsoluteHttpUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `${label} must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must start with http:// or https://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} cannot include embedded username or password`);
  }
  return parsed;
}

export async function prepareProxyRequest(
  _providerId: ProviderId,
  upstreamBaseUrl: string,
  headers: Record<string, string>,
  options?: { useSystemProxy?: boolean },
): Promise<PreparedProxyRequest> {
  const normalizedUpstream = upstreamBaseUrl.trim();
  if (!normalizedUpstream) {
    throw new Error("Base URL cannot be empty");
  }

  const parsed = parseAbsoluteHttpUrl(normalizedUpstream, "Base URL");
  if (parsed.search || parsed.hash) {
    throw new Error("Base URL cannot include query parameters or fragments");
  }

  return {
    baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`,
    // 标记头最后展开，用户自定义头覆盖不掉进程内信号。
    headers:
      options?.useSystemProxy === true
        ? { ...headers, [LIVEAGENT_USE_SYSTEM_PROXY_HEADER]: "1" }
        : headers,
  };
}
