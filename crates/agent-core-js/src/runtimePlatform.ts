export const RUNTIME_PLATFORM = {};

export type RuntimePlatform = any;

export function inferRuntimePlatform(): RuntimePlatform {
  return RUNTIME_PLATFORM;
}

export function normalizeRuntimePlatform(platform: any): RuntimePlatform {
  return platform;
}

export function runtimePlatformLabel(platform: RuntimePlatform): string {
  return "node";
}
