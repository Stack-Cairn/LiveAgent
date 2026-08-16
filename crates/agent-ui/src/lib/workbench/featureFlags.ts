export type SessionWorkbenchFeature = Readonly<{
  enabled: boolean;
}>;

export function readInternalFeatureFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "on", "true", "yes"].includes(value.trim().toLowerCase());
}

export function createSessionWorkbenchFeature(value: unknown): SessionWorkbenchFeature {
  return Object.freeze({ enabled: readInternalFeatureFlag(value) });
}
