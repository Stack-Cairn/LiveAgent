// Match Desktop's build_ws_url: the separately configured port wins, and a
// reverse proxy's path prefix is retained. Default ports are normalized by URL.
export function buildGatewayPublicBaseUrl(gatewayUrl: string, gatewayPort?: number): string {
  if (!gatewayUrl.trim()) return "";
  try {
    const url = new URL(gatewayUrl.trim());
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (gatewayPort !== undefined && gatewayPort !== 0) {
      if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) return "";
      url.port = String(gatewayPort);
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}
