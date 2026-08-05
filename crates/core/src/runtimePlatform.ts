// Node 引擎恒定运行在本机进程上，平台直接取 process.platform，无需 IPC。
export type RuntimePlatform = "windows" | "macos" | "linux";

export function normalizeRuntimePlatform(value: unknown): RuntimePlatform | undefined {
  if (value === "windows" || value === "macos" || value === "linux") return value;
  return undefined;
}

export function inferRuntimePlatform(): RuntimePlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function runtimePlatformLabel(platform: RuntimePlatform) {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  return "Linux";
}

export async function resolveRuntimePlatform(): Promise<RuntimePlatform> {
  return inferRuntimePlatform();
}
