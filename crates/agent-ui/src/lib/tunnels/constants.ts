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
  gatewayUnsupported?: boolean;
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

// Returns an i18n key describing the validation failure, or null when valid.
export function validateLocalHttpTarget(input: string): string | null {
  const value = input.trim();
  if (!value) return "projectTools.tunnelTargetRequired";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return "projectTools.tunnelInvalidUrl";
    }
    const hostname = normalizeTunnelHostname(url.hostname);
    if (hostname !== "localhost" && !isIpAddress(hostname)) {
      return "projectTools.tunnelLocalhostOnly";
    }
    if (url.username || url.password || url.hash) {
      return "projectTools.tunnelInvalidUrl";
    }
  } catch {
    return "projectTools.tunnelInvalidUrl";
  }
  return null;
}

export function composePublicUrl(baseUrl: string, publicPath: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const path = publicPath.trim();
  if (!base || !path) return "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
