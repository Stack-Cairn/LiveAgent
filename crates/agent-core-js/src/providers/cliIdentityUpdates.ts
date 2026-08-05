import { hubFetch } from "../hubFetch";
import { isGatewayWebuiRuntime } from "../runtimeEnv";
import {
  CLI_IDENTITY_METADATA,
  type CliIdentityProfile,
  type CliIdentitySettings,
  followLatestCliIdentityVersion,
  MANAGED_CLI_IDENTITY_PROVIDER_IDS,
  type ManagedCliIdentityProviderId,
  normalizeStableCliVersion,
} from "./cliIdentityCore";

export const CLI_IDENTITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
// 检查失败后的退避窗口：失败不写 lastCheckedAt，否则会把失败伪装成一次成功检查；
// 但也不能每次窗口聚焦都重试，离线时那是持续的失败请求流。
export const CLI_IDENTITY_FAILURE_BACKOFF_MS = 60 * 60 * 1_000;
const GATEWAY_TOKEN_STORAGE_KEY = "liveagent.gateway.token";

export type CliIdentityCheckResult =
  | { providerId: ManagedCliIdentityProviderId; status: "success"; version: string }
  | { providerId: ManagedCliIdentityProviderId; status: "error"; message: string };

function registryDistTagsUrl(packageName: string): string {
  return `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`;
}

// 网关标识 URL 和认证头需要通过参数传入，避免直接依赖 window 对象
// 参数可选以保持向后兼容性（对于浏览器端）
export type GatewayContext = {
  origin: string;
  token: string;
};

function buildGatewayContext(): GatewayContext | null {
  // 浏览器环境下尝试从 window 读取；Node 环境返回 null
  // 实际使用时由调用方传入正确的 context
  if (typeof window !== "undefined" && window.location) {
    const token = (window.localStorage as Storage)?.getItem?.(GATEWAY_TOKEN_STORAGE_KEY)?.trim() ?? "";
    return {
      origin: window.location.origin,
      token,
    };
  }
  return null;
}

function gatewayIdentityUrl(providerId: ManagedCliIdentityProviderId, gatewayContext: GatewayContext): string {
  return `${gatewayContext.origin}/api/provider-identities/${encodeURIComponent(providerId)}/latest`;
}

function gatewayAuthHeaders(gatewayContext: GatewayContext): HeadersInit {
  if (!gatewayContext.token) throw new Error("gateway access token is unavailable");
  return { Accept: "application/json", Authorization: `Bearer ${gatewayContext.token}` };
}

export async function fetchLatestCliIdentityVersion(
  providerId: ManagedCliIdentityProviderId,
  signal?: AbortSignal,
  gatewayContext?: GatewayContext | null,
): Promise<string> {
  const metadata = CLI_IDENTITY_METADATA[providerId];
  const context = gatewayContext ?? buildGatewayContext();
  const gatewayRuntime = isGatewayWebuiRuntime();
  const response = context && gatewayRuntime
    ? await fetch(gatewayIdentityUrl(providerId, context), { headers: gatewayAuthHeaders(context), signal })
    : await hubFetch(registryDistTagsUrl(metadata.packageName), {
        headers: { Accept: "application/json" },
        signal,
      });
  if (!response.ok) {
    throw new Error(`version service returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const version = normalizeStableCliVersion(
    gatewayRuntime && context ? payload.version : payload[metadata.distTag],
  );
  if (!version) {
    throw new Error("version service returned an invalid stable semantic version");
  }
  return version;
}

export async function checkCliIdentityVersions(
  providerIds: readonly ManagedCliIdentityProviderId[],
  signal?: AbortSignal,
  gatewayContext?: GatewayContext | null,
): Promise<CliIdentityCheckResult[]> {
  return Promise.all(
    providerIds.map(async (providerId) => {
      try {
        return {
          providerId,
          status: "success" as const,
          version: await fetchLatestCliIdentityVersion(providerId, signal, gatewayContext),
        };
      } catch (error) {
        return {
          providerId,
          status: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

export function cliIdentityProvidersNeedingCheck(
  identities: CliIdentitySettings,
  now = Date.now(),
  includeBuiltin = false,
): ManagedCliIdentityProviderId[] {
  return MANAGED_CLI_IDENTITY_PROVIDER_IDS.filter((providerId) => {
    const profile = identities[providerId];
    if (!includeBuiltin && profile.mode === "builtin") return false;
    // 失败退避：时钟回拨（lastFailedAt 在未来）按已过期处理，避免永久卡住。
    if (
      profile.lastFailedAt &&
      profile.lastFailedAt <= now &&
      now - profile.lastFailedAt < CLI_IDENTITY_FAILURE_BACKOFF_MS
    ) {
      return false;
    }
    return (
      !profile.lastCheckedAt ||
      profile.lastCheckedAt > now ||
      now - profile.lastCheckedAt >= CLI_IDENTITY_CHECK_INTERVAL_MS
    );
  });
}

export function mergeCliIdentityCheckResults(
  identities: CliIdentitySettings,
  results: readonly CliIdentityCheckResult[],
  checkedAt = Date.now(),
): {
  identities: CliIdentitySettings;
  errors: Partial<Record<ManagedCliIdentityProviderId, string>>;
  changed: boolean;
} {
  const next = { ...identities };
  const errors: Partial<Record<ManagedCliIdentityProviderId, string>> = {};
  let changed = false;
  for (const result of results) {
    const current = next[result.providerId];
    if (result.status === "error") {
      errors[result.providerId] = result.message;
      // 记录失败时间以便退避；lastCheckedAt 保持不动，失败不算一次成功检查。
      next[result.providerId] = { ...current, lastFailedAt: checkedAt };
      changed = changed || current.lastFailedAt !== checkedAt;
      continue;
    }
    let profile: CliIdentityProfile = {
      ...current,
      latestVersion: result.version,
      lastCheckedAt: checkedAt,
    };
    delete profile.lastFailedAt;
    profile = followLatestCliIdentityVersion(profile);
    next[result.providerId] = profile;
    changed =
      changed ||
      current.latestVersion !== profile.latestVersion ||
      current.lastCheckedAt !== profile.lastCheckedAt ||
      current.lastFailedAt !== profile.lastFailedAt ||
      current.version !== profile.version ||
      current.previousVersion !== profile.previousVersion ||
      current.rejectedVersion !== profile.rejectedVersion;
  }
  return { identities: next, errors, changed };
}


export function cliIdentityProvidersNeedingCheck(
  identities: CliIdentitySettings,
  now = Date.now(),
  includeBuiltin = false,
): ManagedCliIdentityProviderId[] {
  return MANAGED_CLI_IDENTITY_PROVIDER_IDS.filter((providerId) => {
    const profile = identities[providerId];
    if (!includeBuiltin && profile.mode === "builtin") return false;
    // 失败退避：时钟回拨（lastFailedAt 在未来）按已过期处理，避免永久卡住。
    if (
      profile.lastFailedAt &&
      profile.lastFailedAt <= now &&
      now - profile.lastFailedAt < CLI_IDENTITY_FAILURE_BACKOFF_MS
    ) {
      return false;
    }
    return (
      !profile.lastCheckedAt ||
      profile.lastCheckedAt > now ||
      now - profile.lastCheckedAt >= CLI_IDENTITY_CHECK_INTERVAL_MS
    );
  });
}

export function mergeCliIdentityCheckResults(
  identities: CliIdentitySettings,
  results: readonly CliIdentityCheckResult[],
  checkedAt = Date.now(),
): {
  identities: CliIdentitySettings;
  errors: Partial<Record<ManagedCliIdentityProviderId, string>>;
  changed: boolean;
} {
  const next = { ...identities };
  const errors: Partial<Record<ManagedCliIdentityProviderId, string>> = {};
  let changed = false;
  for (const result of results) {
    const current = next[result.providerId];
    if (result.status === "error") {
      errors[result.providerId] = result.message;
      // 记录失败时间以便退避；lastCheckedAt 保持不动，失败不算一次成功检查。
      next[result.providerId] = { ...current, lastFailedAt: checkedAt };
      changed = changed || current.lastFailedAt !== checkedAt;
      continue;
    }
    let profile: CliIdentityProfile = {
      ...current,
      latestVersion: result.version,
      lastCheckedAt: checkedAt,
    };
    delete profile.lastFailedAt;
    profile = followLatestCliIdentityVersion(profile);
    next[result.providerId] = profile;
    changed =
      changed ||
      current.latestVersion !== profile.latestVersion ||
      current.lastCheckedAt !== profile.lastCheckedAt ||
      current.lastFailedAt !== profile.lastFailedAt ||
      current.version !== profile.version ||
      current.previousVersion !== profile.previousVersion ||
      current.rejectedVersion !== profile.rejectedVersion;
  }
  return { identities: next, errors, changed };
}
