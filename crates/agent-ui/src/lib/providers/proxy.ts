import type { ProviderId } from "@liveagent/app/lib/settings";
import { invoke } from "@liveagent/app/shims/tauriCore";

export const LIVEAGENT_PROXY_TOKEN_HEADER = "x-liveagent-proxy-token";
export const LIVEAGENT_UPSTREAM_ORIGIN_HEADER = "x-liveagent-upstream-origin";
// 上游头覆盖包：base64(utf8(JSON))。WebView 的 fetch 会静默丢弃 User-Agent /
// Cookie / Referer 等 forbidden header names，SDK 也可能自行注入同名头，所以最终
// 头集经这一条通道下发，由本地反代在转发前作为最后一步覆盖写入上游请求——
// “自定义头覆盖内置默认头”的唯一裁决点就在那里。
export const LIVEAGENT_UPSTREAM_HEADERS_HEADER = "x-liveagent-upstream-headers";
// 布尔标记头：声明该请求经系统代理出网。代理地址/凭据只存于桌面 Rust 侧，
// 由本地反代按此头选择带代理的 client（x-liveagent-* 头不会转发给上游）。
export const LIVEAGENT_USE_SYSTEM_PROXY_HEADER = "x-liveagent-use-system-proxy";

// 鉴权头不进覆盖包：它们不属浏览器禁止名（常规通道必然送达），且是保留头用户
// 改不了，没有覆盖需求——不必把密钥再复制一份进旁路通道。
const UPSTREAM_HEADER_OVERRIDE_EXCLUDED_KEYS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);
const UPSTREAM_HEADER_OVERRIDE_MAX_BYTES = 8 * 1024;

type ProxyServerInfo = {
  baseUrl: string;
  token: string;
};

export type PreparedProxyRequest = {
  baseUrl: string;
  headers: Record<string, string>;
};

export function encodeUpstreamHeaderOverrides(headers: Record<string, string>): string | undefined {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (UPSTREAM_HEADER_OVERRIDE_EXCLUDED_KEYS.has(key.toLowerCase())) continue;
    if (key.toLowerCase().startsWith("x-liveagent-")) continue;
    overrides[key] = value;
  }
  if (Object.keys(overrides).length === 0) return undefined;

  // base64 而非裸 JSON：既杜绝取值里的 CR/LF 造成 header 注入，也免去引号与逗号
  // 在 header 值里的解析歧义。
  const encoded = new TextEncoder().encode(JSON.stringify(overrides));
  if (encoded.byteLength > UPSTREAM_HEADER_OVERRIDE_MAX_BYTES) {
    throw new Error(
      `Custom request headers are too large (${encoded.byteLength} bytes, limit ${UPSTREAM_HEADER_OVERRIDE_MAX_BYTES}). Trim the provider's custom request headers.`,
    );
  }
  let binary = "";
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

export function buildProxyBaseUrl(
  providerId: ProviderId,
  upstreamBaseUrl: string,
  proxyServerBaseUrl: string,
): { baseUrl: string; upstreamOrigin: string } {
  const normalizedUpstream = upstreamBaseUrl.trim();
  if (!normalizedUpstream) {
    throw new Error("Base URL cannot be empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUpstream);
  } catch (error) {
    throw new Error(
      `Base URL must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("Base URL cannot include embedded username or password");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Base URL cannot include query parameters or fragments");
  }

  const normalizedProxyServerBaseUrl = proxyServerBaseUrl.trim().replace(/\/+$/, "");
  const pathname = parsed.pathname.replace(/\/+$/, "");

  return {
    baseUrl: `${normalizedProxyServerBaseUrl}/proxy/${providerId}${pathname}`,
    upstreamOrigin: parsed.origin,
  };
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

/** 本地反代的路径段仅用于区分链路（Rust 侧不校验取值），hub = 商店类出网。 */
const HUB_PROXY_ROUTE = "hub";

/**
 * 把任意完整上游 URL 改写为经本地反代的请求：路径与查询原样保留，
 * origin 移入 upstream-origin 头。恒带 use-system-proxy —— 反代按应用代理
 * 配置出网（未启用=直连，配置异常 502 fail fast，绝不静默降级为直连）。
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

export async function prepareProxyRequest(
  providerId: ProviderId,
  upstreamBaseUrl: string,
  headers: Record<string, string>,
  options?: { useSystemProxy?: boolean },
): Promise<PreparedProxyRequest> {
  const proxyServerInfo = await getProxyServerInfo();
  const { baseUrl, upstreamOrigin } = buildProxyBaseUrl(
    providerId,
    upstreamBaseUrl,
    proxyServerInfo.baseUrl,
  );
  const upstreamHeaderOverrides = encodeUpstreamHeaderOverrides(headers);

  return {
    baseUrl,
    headers: {
      ...headers,
      ...(upstreamHeaderOverrides
        ? { [LIVEAGENT_UPSTREAM_HEADERS_HEADER]: upstreamHeaderOverrides }
        : {}),
      [LIVEAGENT_UPSTREAM_ORIGIN_HEADER]: upstreamOrigin,
      [LIVEAGENT_PROXY_TOKEN_HEADER]: proxyServerInfo.token,
      ...(options?.useSystemProxy ? { [LIVEAGENT_USE_SYSTEM_PROXY_HEADER]: "1" } : {}),
    },
  };
}
