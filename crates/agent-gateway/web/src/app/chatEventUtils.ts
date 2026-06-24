import type {
  AgentStatus,
  ChatControlEvent,
  ChatEvent,
  GatewaySelectedModel,
} from "@/lib/gatewayTypes";
import type { AppSettings, SelectedModel } from "@/lib/settings";

import {
  CHAT_RUNTIME_READY_STATUS_TTL_MS,
  HISTORY_LIST_MIN_LOADING_MS,
  SECONDS_TIMESTAMP_MAX,
} from "./constants";
import type { ModelProviderSource, TunnelManagerToolChange } from "./types";

export function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? "").trim();
  return text || fallback;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function waitForMinimumHistoryListLoading(startedAt: number) {
  const elapsed = Date.now() - startedAt;
  const remainingMs = Math.max(0, HISTORY_LIST_MIN_LOADING_MS - elapsed);
  if (remainingMs > 0) {
    await wait(remainingMs);
  }
}

export function normalizeOptionalStatus(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function normalizeGatewayTimestampMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value < SECONDS_TIMESTAMP_MAX ? value * 1000 : value;
}

export function isChatRuntimeReadyStatus(
  status: AgentStatus | null | undefined,
  now = Date.now(),
) {
  if (status?.online !== true) {
    return false;
  }

  const runtimeState = normalizeOptionalStatus(status.runtime_state)?.toLowerCase() ?? "";
  if (runtimeState === "suspended") {
    return false;
  }

  const hasReadyState =
    runtimeState === "ready" || runtimeState === "draining" || runtimeState === "busy";
  if (status.chat_runtime_ready !== true && !hasReadyState) {
    return false;
  }

  const runtimeHeartbeatAt = normalizeGatewayTimestampMs(status.runtime_last_heartbeat);
  if (runtimeHeartbeatAt <= 0) {
    return status.chat_runtime_ready === true;
  }

  return now - runtimeHeartbeatAt <= CHAT_RUNTIME_READY_STATUS_TTL_MS;
}

export function isAbortError(error: unknown) {
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("已取消") ||
    normalized.includes("abort") ||
    normalized.includes("aborted")
  );
}

export function readChatEventTitle(event: ChatEvent): string {
  if ("title" in event && typeof event.title === "string") {
    return event.title.trim();
  }
  return "";
}

export function isChatEventTitleFinal(event: ChatEvent) {
  return event.type === "done" || ("titleFinal" in event && event.titleFinal === true);
}

export function isTerminalChatEvent(event: ChatEvent) {
  return event.type === "done" || event.type === "error" || isTerminalChatControlEvent(event);
}

export function isChatControlEvent(event: ChatEvent): event is ChatControlEvent {
  switch (event.type) {
    case "accepted":
    case "user_message":
    case "rebased":
    case "projection_updated":
    case "delivered":
    case "claimed":
    case "starting":
    case "queued_in_gui":
    case "started":
    case "progress":
    case "completed":
    case "failed":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

export function isTerminalChatControlEvent(event: ChatEvent) {
  return (
    isChatControlEvent(event) &&
    (event.state === "completed" || event.state === "failed" || event.state === "cancelled")
  );
}

export function isPreparingChatControlEvent(event: ChatEvent) {
  return (
    isChatControlEvent(event) &&
    (event.state === "queued" ||
      event.state === "delivered" ||
      event.state === "claimed" ||
      event.state === "starting" ||
      event.state === "desktop_queued" ||
      event.type === "accepted" ||
      event.type === "rebased" ||
      event.type === "projection_updated" ||
      event.type === "delivered" ||
      event.type === "claimed" ||
      event.type === "starting" ||
      event.type === "queued_in_gui" ||
      event.type === "progress")
  );
}

export function isRuntimeStartedChatControlEvent(event: ChatEvent) {
  return (
    isChatControlEvent(event) &&
    (event.state === "running" || event.type === "started")
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readTunnelManagerToolChange(event: ChatEvent): TunnelManagerToolChange | null {
  if (event.type !== "tool_result" || event.isError === true) {
    return null;
  }
  const details = asRecord(event.details);
  if (details.kind !== "tunnel_manager") {
    return null;
  }
  const action = typeof details.action === "string" ? details.action.trim() : "";
  if (action !== "create" && action !== "close") {
    return null;
  }
  const tunnel = asRecord(details.tunnel);
  const projectPathKey =
    (typeof tunnel.projectPathKey === "string" ? tunnel.projectPathKey.trim() : "") ||
    (typeof tunnel.project_path_key === "string" ? tunnel.project_path_key.trim() : "") ||
    event.workdir?.trim() ||
    "";
  return { action, projectPathKey };
}

export function buildGatewaySelectedModel(
  selectedModel: SelectedModel | undefined,
  providers: ModelProviderSource[],
): GatewaySelectedModel | undefined {
  if (!selectedModel) {
    return undefined;
  }

  const provider = providers.find((item) => item.id === selectedModel.customProviderId);
  if (!provider) {
    return undefined;
  }

  return {
    customProviderId: provider.id,
    model: selectedModel.model,
    providerType: provider.type,
  };
}

export function buildGatewaySystemSettings(settings: AppSettings, workdirOverride?: string) {
  return {
    executionMode: settings.system.executionMode,
    workdir: workdirOverride ?? settings.system.workdir.trim(),
    selectedSystemTools: [...settings.system.selectedSystemTools],
  };
}
