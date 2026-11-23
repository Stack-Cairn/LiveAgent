const TOKEN_KEY = "liveagent.gateway.token";

export function loadToken(): string {
  return window.localStorage.getItem(TOKEN_KEY) ?? "";
}

export function saveToken(token: string): void {
  // Never persist pasted surrounding whitespace (a trailing newline breaks auth).
  window.localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}
