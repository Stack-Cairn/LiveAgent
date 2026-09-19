// 端点地址的主机解析：预设归属、方言推导与网关 quirks 推导共用同一条规则，
// 避免三处各自 new URL() 时 host / hostname、有无 scheme 的口径不一。

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function parseEndpointUrl(url: string | undefined): URL | undefined {
  const trimmed = url?.trim() ?? "";
  if (!trimmed) return undefined;
  try {
    // 用户可能只粘贴 "relay.example/v1"；没有 scheme 时按 https 解析，只取主机。
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
}

/** 小写 hostname（不含端口）；无法解析返回空串。比较主机归属时用这个。 */
export function endpointHostOf(url: string | undefined): string {
  return parseEndpointUrl(url)?.hostname.toLowerCase() ?? "";
}

/** 小写 host（含非默认端口）；无法解析返回空串。 */
export function endpointHostWithPort(url: string | undefined): string {
  return parseEndpointUrl(url)?.host.toLowerCase() ?? "";
}

/**
 * 主机归属键：公网主机按 hostname 比较；本地回环地址（Ollama / LM Studio 等按端口
 * 区分服务）保留端口。
 */
export function endpointHostKey(url: string | undefined): string {
  const parsed = parseEndpointUrl(url);
  if (!parsed) return "";
  const hostname = parsed.hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname) ? parsed.host.toLowerCase() : hostname;
}
