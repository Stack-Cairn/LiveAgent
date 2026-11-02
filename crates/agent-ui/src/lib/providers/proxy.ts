import { invoke } from "@liveagent/app/shims/tauriCore";

export const LIVEAGENT_PROXY_TOKEN_HEADER = "x-liveagent-proxy-token";
export const LIVEAGENT_UPSTREAM_ORIGIN_HEADER = "x-liveagent-upstream-origin";
// Hub/registry 请求通过本地宿主代理出网；模型请求统一交给 K-brain。
export const LIVEAGENT_UPSTREAM_URL_HEADER = "x-liveagent-upstream-url";
export const LIVEAGENT_UPSTREAM_HEADERS_HEADER = "x-liveagent-upstream-headers";
export const LIVEAGENT_USE_SYSTEM_PROXY_HEADER = "x-liveagent-use-system-proxy";

type ProxyServerInfo = {
  baseUrl: string;
  token: string;
};

let proxyServerInfoPromise: Promise<ProxyServerInfo> | null = null;

function normalizeProxyServerInfo(info: ProxyServerInfo): ProxyServerInfo {
  const baseUrl = String(info.baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const token = String(info.token ?? "").trim();

  if (!baseUrl) {
    throw new Error("Local proxy base URL is empty");
  }
  if (!token) {
    throw new Error("Local proxy token is empty");
  }

  return {
    baseUrl,
    token,
  };
}

async function getProxyServerInfo(): Promise<ProxyServerInfo> {
  if (!proxyServerInfoPromise) {
    proxyServerInfoPromise = invoke<ProxyServerInfo>("proxy_get_server_info")
      .then(normalizeProxyServerInfo)
      .catch((error) => {
        proxyServerInfoPromise = null;
        throw new Error(
          `Failed to get local proxy info: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  return proxyServerInfoPromise;
}

/** 各代理入口共用的 URL 安全校验：绝对地址 + http(s) + 禁内嵌凭据。 */
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

export function buildImageProxyUrl(imageUrl: string, proxyServerBaseUrl: string): string {
  const normalizedImageUrl = imageUrl.trim();
  if (!normalizedImageUrl) {
    throw new Error("Image URL cannot be empty");
  }

  const parsed = parseAbsoluteHttpUrl(normalizedImageUrl, "Image URL");

  const normalizedProxyServerBaseUrl = proxyServerBaseUrl.trim().replace(/\/+$/, "");
  if (!normalizedProxyServerBaseUrl) {
    throw new Error("Local proxy base URL is empty");
  }
  return `${normalizedProxyServerBaseUrl}/image-proxy?url=${encodeURIComponent(parsed.toString())}`;
}

export async function prepareImageProxyUrl(imageUrl: string): Promise<string> {
  const proxyServerInfo = await getProxyServerInfo();
  return buildImageProxyUrl(imageUrl, proxyServerInfo.baseUrl);
}

export type PreparedUpstreamProxyRequest = {
  url: string;
  headers: Record<string, string>;
};

/** 本地反代仅服务 hub/registry 资源，模型请求统一由 K-brain 执行。 */
const HUB_PROXY_ROUTE = "hub";

/**
 * 把任意完整资源 URL 改写为经本地反代的 hub 请求：路径与查询原样保留，
 * origin 移入 upstream-origin 头。模型供应商 URL 不得使用此入口。
 */
export async function prepareUpstreamProxyRequest(
  targetUrl: string,
): Promise<PreparedUpstreamProxyRequest> {
  const parsed = parseAbsoluteHttpUrl(targetUrl, "Upstream URL");
  // “//” 开头的 pathname 会被 Rust 侧 Url::join 当作 scheme-relative 引用
  // 改写上游主机，必须拒绝（Rust build_target_url 另有同款后盾）。
  if (parsed.pathname.startsWith("//")) {
    throw new Error("Upstream URL path must not begin with //");
  }

  const proxyServerInfo = await getProxyServerInfo();
  // 根路径映射为空串：/proxy/hub/ 不匹配任何反代路由（{*rest} 要求非空），
  // /proxy/hub 才会被 build_target_url 还原成上游的 “/”。
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  return {
    url: `${proxyServerInfo.baseUrl}/proxy/${HUB_PROXY_ROUTE}${pathname}${parsed.search}`,
    headers: {
      [LIVEAGENT_UPSTREAM_ORIGIN_HEADER]: parsed.origin,
      [LIVEAGENT_PROXY_TOKEN_HEADER]: proxyServerInfo.token,
      [LIVEAGENT_USE_SYSTEM_PROXY_HEADER]: "1",
    },
  };
}
