import { getGatewayOrigin } from "./gatewayOrigin";
import type { SharedHistoryDetail } from "./gatewayTypes";

const SHARE_PATH_PREFIX = "/share/";

export function normalizeHistoryTimestampMs(timestamp?: number | null) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  if (timestamp < 100_000_000_000) {
    return timestamp * 1000;
  }
  if (timestamp < 100_000_000_000_000) {
    return timestamp;
  }
  if (timestamp < 100_000_000_000_000_000) {
    return Math.floor(timestamp / 1000);
  }
  return Math.floor(timestamp / 1_000_000);
}

export function formatSharedHistoryTimestamp(timestamp?: number | null) {
  const normalized = normalizeHistoryTimestampMs(timestamp);
  if (normalized === null) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(normalized));
}

function getWindowLocationPathname() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.pathname;
}

function getWindowLocationOrigin() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin;
}

export function parseHistoryShareToken(pathname = getWindowLocationPathname()) {
  const normalized = pathname.trim();
  if (!normalized.startsWith(SHARE_PATH_PREFIX)) {
    return null;
  }

  const rest = normalized.slice(SHARE_PATH_PREFIX.length);
  if (!rest || rest.includes("/")) {
    return null;
  }

  try {
    const token = decodeURIComponent(rest).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function buildHistoryShareUrl(token: string, origin = getWindowLocationOrigin()) {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return "";
  }
  return `${origin.replace(/\/$/, "")}${SHARE_PATH_PREFIX}${encodeURIComponent(normalizedToken)}`;
}

export async function fetchSharedHistory(token: string): Promise<SharedHistoryDetail> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    throw new Error("分享链接无效");
  }

  const response = await fetch(
    `${getGatewayOrigin()}/api/public/history-shares/${encodeURIComponent(normalizedToken)}`,
    {
      credentials: "omit",
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    let message = response.status === 404 ? "分享链接不存在或已关闭" : "读取分享会话失败";
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) {
        message = payload.error.trim();
      }
    } catch {
      // Keep the status-derived message.
    }
    throw new Error(message);
  }

  return (await response.json()) as SharedHistoryDetail;
}
