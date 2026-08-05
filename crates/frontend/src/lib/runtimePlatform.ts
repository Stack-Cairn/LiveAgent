import { invoke } from "@tauri-apps/api/core";

export type RuntimePlatform = "windows" | "macos" | "linux";

type RuntimePlatformResponse = {
  platform?: unknown;
};

export function normalizeRuntimePlatform(value: unknown): RuntimePlatform | undefined {
  if (value === "windows" || value === "macos" || value === "linux") return value;
  return undefined;
}

export function inferRuntimePlatform(): RuntimePlatform {
  const nav =
    typeof navigator !== "undefined"
      ? `${navigator.userAgent || ""} ${navigator.platform || ""}`
      : "";
  if (/\bWindows\b|Win32|Win64|WOW64/i.test(nav)) return "windows";
  if (/Mac|iPhone|iPad|iPod/i.test(nav)) return "macos";
  return "linux";
}

export function runtimePlatformLabel(platform: RuntimePlatform) {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  return "Linux";
}

export async function resolveRuntimePlatform(): Promise<RuntimePlatform> {
  try {
    const response = await invoke<RuntimePlatformResponse>("app_runtime_platform");
    return normalizeRuntimePlatform(response?.platform) ?? inferRuntimePlatform();
  } catch {
    return inferRuntimePlatform();
  }
}
