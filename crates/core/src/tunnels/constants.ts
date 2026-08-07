// Shared tunnel types and helpers for the local-tunnel panel. This file is
// byte-copied between the webui and the desktop GUI codebases — keep it free
// of any codebase-specific imports.

export type TunnelTtlSeconds = 0 | 900 | 3600 | 14400;

export const TUNNEL_TTL_OPTIONS: TunnelTtlSeconds[] = [900, 3600, 14400, 0];

export type TunnelHealth = {
  status: "ok" | "failed" | "unknown";
  httpStatus: number;
  error: string;
  checkedAt: number;
  rttMs: number;
};

export type TunnelStatus = {
  id: string;
  slug: string;
  name: string;
  targetUrl: string;
  publicPath: string;
  // 后端给出的完整访问地址，含首访 token。一隧道一端口，所以链接是
  // http://host:<port>/?t=<token>，前端不再拼 baseUrl + publicPath。
  publicUrl: string;
  port: number;
  createdAt: number;
  expiresAt: number;
  activeConnections: number;
  projectPathKey: string;
  local: TunnelHealth | null;
};

export type TunnelStateSnapshot = {
  revision: number;
  agentOnline: boolean;
  relay: TunnelHealth | null;
  tunnels: TunnelStatus[];
};

export type TunnelCreateInput = {
  targetUrl: string;
  name?: string;
  ttlSeconds: TunnelTtlSeconds;
  projectPathKey?: string;
};

export type TunnelUpdateInput = {
  id: string;
  targetUrl: string;
  name?: string;
  // Omitted = keep the current expiry; present = re-bucket from now.
  ttlSeconds?: TunnelTtlSeconds;
  projectPathKey?: string;
};

export interface LocalTunnelClient {
  // Fires immediately with the last known snapshot when available.
  subscribeTunnelState(listener: (snapshot: TunnelStateSnapshot) => void): () => void;
  createTunnel(input: TunnelCreateInput): Promise<void>;
  updateTunnel(input: TunnelUpdateInput): Promise<void>;
  closeTunnel(id: string): Promise<void>;
  checkTunnel(id?: string): Promise<void>;
}

function normalizeTunnelHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isIpv4Address(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255 && String(value) === part;
  });
}

function isIpAddress(hostname: string) {
  if (isIpv4Address(hostname)) return true;
  return hostname.includes(":");
}

export type TunnelValidationError =
  | "target_required"
  | "invalid_url"
  | "localhost_only";

// Returns an error code describing the validation failure, or null when valid.
export function validateLocalHttpTarget(input: string): TunnelValidationError | null {
  const value = input.trim();
  if (!value) return "target_required";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return "invalid_url";
    }
    const hostname = normalizeTunnelHostname(url.hostname);
    if (hostname !== "localhost" && !isIpAddress(hostname)) {
      return "localhost_only";
    }
    if (url.username || url.password || url.hash) {
      return "invalid_url";
    }
  } catch {
    return "invalid_url";
  }
  return null;
}

// 解析一条隧道的可访问链接。
//
// 新后端（P2-30，一隧道一端口）直接给出 `publicUrl`，已含首访 token；
// `baseUrl` 只用于远程访问时替换主机名——后端不知道自己被从哪个地址访问，
// 给出的主机名恒为 127.0.0.1。
//
// 旧 Gateway 中继路径没有 `publicUrl`，只有 `/t/{slug}` 形式的 `publicPath`，
// 要拼在 gateway 地址后面。阶段 6 删 Go 时这个分支一并消失。
export function resolveTunnelUrl(tunnel: TunnelStatus, baseUrl?: string): string {
  const host = baseUrl?.trim().replace(/\/+$/, "");
  const direct = tunnel.publicUrl.trim();
  if (!direct) {
    const path = tunnel.publicPath.trim();
    if (!host || !path) return "";
    return `${host}${path.startsWith("/") ? path : `/${path}`}`;
  }
  if (!host) return direct;
  try {
    const parsed = new URL(direct);
    const override = new URL(host);
    parsed.hostname = override.hostname;
    parsed.protocol = override.protocol;
    return parsed.toString();
  } catch {
    return direct;
  }
}
