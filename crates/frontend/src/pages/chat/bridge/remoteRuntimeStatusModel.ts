export type RemoteRuntimeStatus = {
  online: boolean;
  enabled: boolean;
  configured: boolean;
  remoteUrl?: string | null;
  sessionId?: string | null;
  connectedSince?: number | null;
  lastHeartbeat?: number | null;
  lastError?: string | null;
};

/**
 * 远程设置里已经没有「连到哪个 Backend」了，拿不到运行时状态时只能当离线。
 */
export const OFFLINE_REMOTE_STATUS: RemoteRuntimeStatus = {
  online: false,
  enabled: false,
  configured: false,
  remoteUrl: null,
  sessionId: null,
  connectedSince: null,
  lastHeartbeat: null,
  lastError: null,
};
