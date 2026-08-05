import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import {
  resolveTunnelUrl,
  type TunnelHealth,
  type TunnelStateSnapshot,
  type TunnelStatus,
  type TunnelTtlSeconds,
} from "../tunnels/constants";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

export type TunnelChangeAction = "create" | "close" | "check";

export type TunnelManagerChange = {
  action: TunnelChangeAction;
  projectPathKey?: string;
};

type TunnelManagerAction = "list" | "create" | "close" | "check";

type TunnelManagerDetails = {
  kind: "tunnel_manager";
  action: TunnelManagerAction;
  tunnels?: TunnelStatus[];
  tunnel?: TunnelStatus;
};

const TUNNEL_MANAGER_TOOL: Tool = {
  name: "TunnelManager",
  description:
    "Manage temporary HTTP/WebSocket/SSE tunnels to local services. Use list to inspect active tunnels and their health, create to expose a localhost or IPv4/IPv6 http service, check to re-run health probes, and close to revoke a tunnel. Each tunnel gets its own port; the returned public URL already contains the access token.",
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("list"), Type.Literal("create"), Type.Literal("close"), Type.Literal("check")],
      {
        description: "Tunnel action to perform.",
      },
    ),
    targetUrl: Type.Optional(
      Type.String({
        description:
          "Required for action=create. HTTP target, e.g. http://localhost:3000, http://127.0.0.1:5173/app, or http://192.168.1.5:8080.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description: "Optional display name for a created tunnel.",
      }),
    ),
    ttlSeconds: Type.Optional(
      Type.Union([Type.Literal(0), Type.Literal(900), Type.Literal(3600), Type.Literal(14400)], {
        description: "Optional tunnel lifetime. Use 0 for unlimited. Defaults to 3600 seconds.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Tunnel id. Required for action=close. Optional for action=check (omit to check all tunnels).",
      }),
    ),
  }),
};

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeAction(value: unknown): TunnelManagerAction {
  if (value === "list" || value === "create" || value === "close" || value === "check") {
    return value;
  }
  throw new Error('TunnelManager.action must be "list", "create", "close", or "check".');
}

function normalizeTtlSeconds(value: unknown): TunnelTtlSeconds {
  if (value === undefined || value === null) {
    return 3600;
  }
  if (value === 0 || value === 900 || value === 3600 || value === 14400) {
    return value;
  }
  throw new Error("TunnelManager.ttlSeconds must be 0, 900, 3600, or 14400.");
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function formatRemaining(expiresAt: number) {
  if (!expiresAt) return "unlimited";
  const seconds = Math.max(0, Math.floor(expiresAt - Date.now() / 1000));
  if (seconds <= 0) return "expired";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return minutes > 0 && minutes < 60 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatHealth(health: TunnelHealth | null | undefined) {
  if (!health || health.status === "unknown") return "unknown";
  const parts: string[] = [health.status];
  if (health.httpStatus > 0) parts.push(`HTTP ${health.httpStatus}`);
  if (health.status === "ok" && health.rttMs > 0) parts.push(`${health.rttMs}ms`);
  if (health.status === "failed" && health.error) parts.push(health.error);
  return parts.join(" ");
}

function formatSnapshotHealthLines(snapshot: TunnelStateSnapshot) {
  return [`link: ${snapshot.agentOnline ? "online" : "offline"}`];
}

function formatTunnelLine(tunnel: TunnelStatus, publicBaseUrl: string) {
  const name = tunnel.name.trim() || tunnel.targetUrl;
  const publicUrl = resolveTunnelUrl(tunnel, publicBaseUrl);
  const lines = [`- ${name}`, `  id: ${tunnel.id}`, `  target: ${tunnel.targetUrl}`];
  if (publicUrl) {
    lines.push(`  public: ${publicUrl}`);
  }
  lines.push(`  service: ${formatHealth(tunnel.local)}`);
  lines.push(`  ttl: ${formatRemaining(tunnel.expiresAt)}`);
  return lines.join("\n");
}

function okResult(params: {
  toolCall: ToolCall;
  action: TunnelManagerAction;
  text: string;
  tunnels?: TunnelStatus[];
  tunnel?: TunnelStatus;
}): ToolResultMessage {
  const details: TunnelManagerDetails = {
    kind: "tunnel_manager",
    action: params.action,
    ...(params.tunnels ? { tunnels: params.tunnels } : {}),
    ...(params.tunnel ? { tunnel: params.tunnel } : {}),
  };
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text: params.text }],
    details,
    isError: false,
    timestamp: Date.now(),
  };
}

function errorResult(
  toolCall: ToolCall,
  message: string,
  action: TunnelManagerAction = "list",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: `TunnelManager failed: ${message}` }],
    details: {
      kind: "tunnel_manager",
      action,
      errors: [message],
    },
    isError: true,
    timestamp: Date.now(),
  };
}

async function fetchTunnelState() {
  return invoke<TunnelStateSnapshot>("tunnel_state");
}

async function executeTunnelManager(
  toolCall: ToolCall,
  params: {
    projectPathKey?: string;
    publicBaseUrl?: string;
    onTunnelsChanged?: (change: TunnelManagerChange) => void | Promise<void>;
  },
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  if (signal?.aborted) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Cancelled" }],
      details: {},
      isError: true,
      timestamp: Date.now(),
    };
  }

  const publicBaseUrl = params.publicBaseUrl?.trim() ?? "";
  const projectPathKey = params.projectPathKey?.trim() || undefined;
  const notifyChange = (action: TunnelChangeAction) =>
    params.onTunnelsChanged?.({ action, projectPathKey });

  try {
    const args = asArgs(toolCall.arguments);
    const action = normalizeAction(args.action);

    if (action === "list") {
      const snapshot = await fetchTunnelState();
      const text =
        snapshot.tunnels.length === 0
          ? [
              "No Remote tunnels are currently registered.",
              ...formatSnapshotHealthLines(snapshot),
            ].join("\n")
          : [
              "Remote tunnels:",
              ...formatSnapshotHealthLines(snapshot),
              ...snapshot.tunnels.map((tunnel) => formatTunnelLine(tunnel, publicBaseUrl)),
            ].join("\n");
      return okResult({ toolCall, action, text, tunnels: snapshot.tunnels });
    }

    if (action === "create") {
      const targetUrl = normalizeOptionalText(args.targetUrl);
      if (!targetUrl) {
        throw new Error("TunnelManager.targetUrl is required for action=create.");
      }
      const input = {
        targetUrl,
        name: normalizeOptionalText(args.name) || undefined,
        ttlSeconds: normalizeTtlSeconds(args.ttlSeconds),
        ...(projectPathKey ? { projectPathKey } : {}),
      };
      const knownIds = new Set<string>();
      try {
        for (const tunnel of (await fetchTunnelState()).tunnels) {
          knownIds.add(tunnel.id);
        }
      } catch {
        // Best-effort: the created tunnel is diffed against the pre-create ids.
      }
      await invoke<void>("tunnel_create", { input });
      const snapshot = await fetchTunnelState();
      const created = snapshot.tunnels
        .filter((tunnel) => !knownIds.has(tunnel.id))
        .sort((a, b) => b.createdAt - a.createdAt);
      const tunnel =
        created.find((candidate) => candidate.targetUrl === targetUrl) ?? created[0] ?? null;
      await notifyChange("create");
      const text = [
        "Created Remote tunnel:",
        ...(tunnel ? [formatTunnelLine(tunnel, publicBaseUrl)] : []),
        ...formatSnapshotHealthLines(snapshot),
      ].join("\n");
      return okResult({ toolCall, action, text, ...(tunnel ? { tunnel } : {}) });
    }

    if (action === "close") {
      const id = normalizeOptionalText(args.id);
      if (!id) {
        throw new Error("TunnelManager.id is required for action=close.");
      }
      await invoke<void>("tunnel_close", { tunnel_id: id });
      await notifyChange("close");
      return okResult({ toolCall, action, text: `Closed Remote tunnel ${id}.` });
    }

    // action === "check"
    const id = normalizeOptionalText(args.id) || undefined;
    // tunnel_check 同步等探活跑完才返回（旧实现是异步的，只能 sleep 2.5s
    // 再取样碰运气）。返回后快照一定是新的。
    await invoke<void>("tunnel_check", { tunnel_id: id });
    const snapshot = await fetchTunnelState();
    const checkedTunnels = id
      ? snapshot.tunnels.filter((tunnel) => tunnel.id === id)
      : snapshot.tunnels;
    if (id && checkedTunnels.length === 0) {
      throw new Error(`No tunnel found for id "${id}".`);
    }
    await notifyChange("check");
    const text = [
      "Tunnel health:",
      ...formatSnapshotHealthLines(snapshot),
      ...checkedTunnels.map((tunnel) => formatTunnelLine(tunnel, publicBaseUrl)),
    ].join("\n");
    return okResult({
      toolCall,
      action,
      text,
      ...(id ? { tunnel: checkedTunnels[0] } : { tunnels: checkedTunnels }),
    });
  } catch (err) {
    const args = asArgs(toolCall.arguments);
    const action =
      args.action === "create" ||
      args.action === "close" ||
      args.action === "check" ||
      args.action === "list"
        ? args.action
        : undefined;
    return errorResult(toolCall, asErrorMessage(err), action);
  }
}

export function createTunnelManagerTools(params: {
  enabled: boolean;
  runtimeScope: "chat" | "cron_auto_prompt";
  projectPathKey?: string;
  publicBaseUrl?: string;
  onTunnelsChanged?: (change: TunnelManagerChange) => void | Promise<void>;
}): BuiltinToolBundle {
  const tools = params.enabled && params.runtimeScope === "chat" ? [TUNNEL_MANAGER_TOOL] : [];
  return {
    groupId: "system",
    tools,
    executeToolCall: (toolCall, signal) =>
      executeTunnelManager(
        toolCall,
        {
          projectPathKey: params.projectPathKey,
          publicBaseUrl: params.publicBaseUrl,
          onTunnelsChanged: params.onTunnelsChanged,
        },
        signal,
      ),
    metadataByName: createBuiltinMetadataMap(
      tools.map((tool) => [
        tool.name,
        {
          groupId: "system" as const,
          kind: "tunnel_manager",
          isReadOnly: false,
          displayCategory: "system" as const,
        },
      ]),
    ),
  };
}
