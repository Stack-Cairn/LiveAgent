/**
 * MCP OAuth 桥接（docs/design/mcp-oauth.md §5）。
 *
 * 授权流仅桌面端可发起（系统浏览器在桌面弹出）：WebUI 的 tauriCore shim 不实现
 * 这些命令，调用方须用 `isGatewayWebuiRuntime()` 先行隐藏入口。token 本体永不
 * 过前端边界——这里只搬状态与元数据。
 */
import { invoke } from "@liveagent/app/shims/tauriCore";
import type { McpServerConfig } from "../settings/types";

export type McpOauthState = "none" | "authorized" | "expired";

export type McpOauthStatus = {
  state: McpOauthState;
  refreshable: boolean;
  /** "keychain" | "file" | "unknown"（file = Linux 无 secret-service 的降级存储）。 */
  storage: string;
  expiresAtMs?: number;
  issuer?: string;
  scope?: string;
};

export function isOauthServer(server: McpServerConfig): boolean {
  return (
    (server.transport === "http" || server.transport === "sse") && server.auth?.type === "oauth"
  );
}

/** 交互授权：弹系统浏览器并阻塞至回调/超时（5 分钟）。仅由用户手势调用。 */
export function mcpOauthAuthorize(server: McpServerConfig): Promise<McpOauthStatus> {
  return invoke<McpOauthStatus>("mcp_oauth_authorize", { server });
}

export function mcpOauthStatus(server: McpServerConfig): Promise<McpOauthStatus> {
  return invoke<McpOauthStatus>("mcp_oauth_status", { server });
}

/** 断开授权/删除 server 时清理 keychain 条目。 */
export function mcpOauthClear(serverId: string): Promise<void> {
  return invoke<void>("mcp_oauth_clear", { server_id: serverId });
}
