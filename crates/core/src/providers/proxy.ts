import type { ProviderId } from "../settings";

// 本地反代已随桌面 Gateway 架构删除（proxy_get_server_info 在删除清单）：
// 反代的存在理由是 WebView 的 fetch 会丢弃 User-Agent/Cookie 等 forbidden
// header names、且系统代理凭据只在 Rust 侧。core 跑在 Node（backend spawn
// 的引擎进程），fetch/undici 没有 forbidden header 限制，请求头直接下发，
// provider 请求按迁移文档"阶段 3 之后引擎在后端直连 provider"直连上游。

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
  _options?: { useSystemProxy?: boolean },
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
    headers,
  };
}
