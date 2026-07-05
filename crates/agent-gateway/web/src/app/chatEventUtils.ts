import type { ChatEvent, GatewaySelectedModel } from "@/lib/gatewayTypes";
import type { AppSettings, SelectedModel } from "@/lib/settings";

import type { ModelProviderSource, TunnelManagerToolChange } from "./types";

export function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? "").trim();
  return text || fallback;
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
