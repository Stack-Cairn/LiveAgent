export type CrateBayRuntimeSummary = {
  state: string;
  engineResponsive?: boolean;
  engineName: string;
  backendRuntime: string;
  ociRuntime: string;
  networkStack: string;
  engineApi: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringField(
  value: unknown,
  camelCase: string,
  snakeCase: string,
  fallback: string,
): string {
  const record = asRecord(value);
  return optionalString(record[camelCase]) ?? optionalString(record[snakeCase]) ?? fallback;
}

function booleanField(
  value: unknown,
  camelCase: string,
  snakeCase: string,
): boolean | undefined {
  const record = asRecord(value);
  return optionalBoolean(record[camelCase]) ?? optionalBoolean(record[snakeCase]);
}

export function normalizeCrateBayRuntimeSummary(
  value: unknown,
  fallbackState = "unknown",
): CrateBayRuntimeSummary {
  const runtime = asRecord(value);
  const engine = asRecord(runtime.engine);

  return {
    state: optionalString(runtime.state) ?? fallbackState,
    engineResponsive:
      booleanField(runtime, "engineResponsive", "engine_responsive") ??
      booleanField(runtime, "compatibilityResponsive", "compatibility_responsive") ??
      booleanField(runtime, "dockerResponsive", "docker_responsive"),
    engineName: stringField(engine, "name", "name", "CrateBay Engine"),
    backendRuntime: stringField(engine, "backendRuntime", "backend_runtime", "containerd"),
    ociRuntime: stringField(engine, "ociRuntime", "oci_runtime", "runc"),
    networkStack: stringField(engine, "networkStack", "network_stack", "CNI"),
    engineApi: stringField(engine, "api", "api", "cratebay.engine.v1"),
  };
}
