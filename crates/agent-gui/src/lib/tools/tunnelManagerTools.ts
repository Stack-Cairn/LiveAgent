import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  composePublicUrl,
  type TunnelHealth,
  type TunnelStateSnapshot,
  type TunnelStatus,
  type TunnelTtlSeconds,
} from "@liveagent/ui/lib/tunnels/constants";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
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

// Health checks run asynchronously on the agent; after triggering one we wait
// briefly before sampling the state snapshot so fresh results can land.
const CHECK_SETTLE_DELAY_MS = 2500;

const TUNNEL_MANAGER_TOOL: Tool = {
  name: "TunnelManager",
  description:
    "Manage temporary Remote HTTP/WebSocket/SSE tunnels through the Gateway. Use list to inspect active tunnels and their health, create to expose a localhost or IPv4/IPv6 http service, check to re-run health probes, and close to revoke a tunnel. Mutations also work while the gateway link is offline; they take effect once the link is restored.",
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
  const lines = [
    `link: ${snapshot.agentOnline ? "online" : "offline"}`,
    `relay: ${formatHealth(snapshot.relay)}`,
  ];
  if (snapshot.gatewayUnsupported === true) {
    lines.push("gateway: connected gateway does not support tunnels (no public URLs)");
  }
  return lines;
}

function formatTunnelLine(tunnel: TunnelStatus, publicBaseUrl: string) {
  const name = tunnel.name.trim() || tunnel.targetUrl;
  const publicUrl = composePublicUrl(publicBaseUrl, tunnel.publicPath);
  const lines = [`- ${name}`, `  id: ${tunnel.id}`, `  target: ${tunnel.targetUrl}`];
  if (publicUrl) {
    lines.push(`  public: ${publicUrl}`);
  } else if (tunnel.publicPath) {
    lines.push(`  publicPath: ${tunnel.publicPath}`);
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
  return invoke<TunnelStateSnapshot>("gateway_tunnel_state");
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
      await invoke<void>("gateway_tunnel_create", { input });
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
      await invoke<void>("gateway_tunnel_close", { tunnel_id: id });
      await notifyChange("close");
      return okResult({ toolCall, action, text: `Closed Remote tunnel ${id}.` });
    }

    // action === "check"
    const id = normalizeOptionalText(args.id) || undefined;
    await invoke<void>("gateway_tunnel_check", { tunnel_id: id });
    // Probes run asynchronously; wait briefly before sampling the state.
    await delay(CHECK_SETTLE_DELAY_MS, signal);
    const snapshot = await fetchTunnelState();
    const checkedTunnels = id
      ? snapshot.tunnels.filter((tunnel) => tunnel.id === id)
      : snapshot.tunnels;
    if (id && checkedTunnels.length === 0) {
      throw new Error(`No tunnel found for id "${id}".`);
    }
    await notifyChange("check");
    const text = [
      "Tunnel health (sampled ~2.5s after triggering checks; probes are async and may still be settling):",
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
