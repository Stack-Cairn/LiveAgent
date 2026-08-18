export type SessionWorkbenchFeature = Readonly<{
  enabled: boolean;
}>;

export function readInternalFeatureFlag(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return defaultValue;
  return ["1", "on", "true", "yes"].includes(normalized);
}

// GA 默认开启;VITE_LIVEAGENT_SESSION_WORKBENCH=0 是回退旧单 Pane 路径的逃生开关。
export function createSessionWorkbenchFeature(value: unknown): SessionWorkbenchFeature {
  return Object.freeze({ enabled: readInternalFeatureFlag(value, true) });
}
