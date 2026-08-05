// 平台传输适配层：Node 端通过 callBackend 直接调用 Rust 侧的用量查询。
// 共享的状态归约/协调器/hook 逻辑在 usageQueryCore.ts(两端字节镜像)，本文件只放平台差异。
import { callBackend } from "../backendClient";
import type { UsageQueryConfig } from "../settings";
import {
  type ProviderUsageResult,
  type UsageQueryProvider,
  useProviderUsageWithQuery,
} from "./usageQueryCore";

export * from "./usageQueryCore";

export async function queryProviderUsage(
  providerId: string,
  refresh: boolean,
): Promise<ProviderUsageResult | null> {
  return callBackend<ProviderUsageResult>("provider_usage_query", { providerId, refresh });
}

/**
 * 「测试查询」：按编辑器草稿配置试查询——忽略启用开关、不落库、不进缓存。
 * WebUI 草稿的秘密为脱敏空串，靠 *Configured 标志让桌面端沿用已存密钥。
 */
export async function testProviderUsage(
  providerId: string,
  config: UsageQueryConfig,
): Promise<ProviderUsageResult | null> {
  return callBackend<ProviderUsageResult>("provider_usage_test", {
    providerId,
    configJson: JSON.stringify(config),
  });
}

export function useProviderUsage(providers: readonly UsageQueryProvider[]) {
  return useProviderUsageWithQuery(queryProviderUsage, providers);
}
