import { clearGatewayUrl, loadGatewayUrl, saveGatewayUrl } from "./storage";

// agent-mobile is a Tauri shell: window.location.origin is the app's internal
// asset origin (e.g. tauri://localhost), never the remote Gateway. The
// configured origin below is the single source of truth for every Gateway
// request; window.location.origin is only a fallback for same-origin/browser
// testing where no origin has been configured yet.
function normalizeGatewayOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("请输入 Gateway 地址。");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Gateway 地址无效，请输入完整的 http(s) 地址。");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Gateway 地址必须以 http:// 或 https:// 开头。");
  }

  return parsed.origin;
}

let configuredOrigin = (() => {
  try {
    return loadGatewayUrl().trim() ? normalizeGatewayOrigin(loadGatewayUrl()) : "";
  } catch {
    return "";
  }
})();

export function getGatewayOrigin(): string {
  if (configuredOrigin) {
    return configuredOrigin;
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}

export function setGatewayOrigin(input: string): string {
  const normalized = normalizeGatewayOrigin(input);
  configuredOrigin = normalized;
  saveGatewayUrl(normalized);
  return normalized;
}

export function clearGatewayOrigin(): void {
  configuredOrigin = "";
  clearGatewayUrl();
}
