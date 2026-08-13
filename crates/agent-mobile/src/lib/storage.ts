const TOKEN_KEY = "liveagent.gateway.token";
const GATEWAY_URL_KEY = "liveagent.gateway.url";

export function loadToken(): string {
  return window.localStorage.getItem(TOKEN_KEY) ?? "";
}

export function saveToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function loadGatewayUrl(): string {
  return window.localStorage.getItem(GATEWAY_URL_KEY) ?? "";
}

export function saveGatewayUrl(url: string): void {
  window.localStorage.setItem(GATEWAY_URL_KEY, url);
}

export function clearGatewayUrl(): void {
  window.localStorage.removeItem(GATEWAY_URL_KEY);
}
