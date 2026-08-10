// 分享链接公开访问地址的单一装配点：GUI 与 WebUI 的两个分享弹窗都从这里
// 拼最终 origin。端口语义与桌面端 WS 连接一致（src-tauri
// services/gateway/ws_transport.rs build_ws_url）：设置里的 gateway_port
// 非零时覆盖基址自带的端口；http:80 / https:443 由 URL 规则自然省略。

function getBrowserOrigin() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin;
}

function isValidGatewayPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535;
}

export function resolveShareOrigin(explicitOrigin?: string, gatewayPort?: number) {
  const hasExplicitOrigin = explicitOrigin !== undefined;
  const rawOrigin = hasExplicitOrigin ? explicitOrigin : getBrowserOrigin();
  const trimmed = rawOrigin.trim();
  if (!trimmed) {
    return "";
  }

  const schemeMatch = /^(https?|wss?):(.*)$/i.exec(trimmed);
  const withScheme = schemeMatch
    ? [
        schemeMatch[1].toLowerCase(),
        ":",
        schemeMatch[2].startsWith("//")
          ? schemeMatch[2]
          : `//${schemeMatch[2].replace(/^\/+/, "")}`,
      ].join("")
    : `https://${trimmed}`;
  const httpUrl = withScheme.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");

  try {
    const url = new URL(httpUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.hostname === "http" ||
      url.hostname === "https"
    ) {
      return "";
    }
    // 浏览器 origin 本身已含端口，只有显式传入的网关基址才需要补端口。
    if (hasExplicitOrigin && isValidGatewayPort(gatewayPort)) {
      url.port = String(gatewayPort);
    }
    return url.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function buildShareUrl(token: string, origin: string) {
  const normalizedToken = token.trim();
  if (!normalizedToken || !origin) {
    return "";
  }
  return `${origin}/share/${encodeURIComponent(normalizedToken)}`;
}
