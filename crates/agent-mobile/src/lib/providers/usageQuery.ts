// 平台传输适配层:WebUI 端用量查询经 Gateway WebSocket 桥接到桌面端执行(provider.usage.query)。
// 共享的状态归约/协调器/hook 逻辑在 usageQueryCore.ts(两端字节镜像),本文件只放平台差异。

import {
  type ProviderUsageResult,
  type UsageQueryProvider,
  useProviderUsageWithQuery,
} from "@liveagent/ui/lib/providers/usageQueryCore";
import { getGatewayWebSocketClient } from "@/lib/gatewaySocket";
import { loadToken } from "@/lib/storage";
import type { UsageQueryConfig } from "../settings";

export * from "@liveagent/ui/lib/providers/usageQueryCore";

export async function queryProviderUsage(
  providerId: string,
  refresh: boolean,
): Promise<ProviderUsageResult | null> {
  return getGatewayWebSocketClient(
    loadToken().trim(),
  ).providerUsageQuery<ProviderUsageResult | null>(providerId, refresh);
}

/**
 * 「测试查询」:按编辑器草稿配置试查询——忽略启用开关、不落库、不进缓存。
 * WebUI 草稿的秘密为脱敏空串,靠 *Configured 标志让桌面端沿用已存密钥。
 */
export async function testProviderUsage(
  providerId: string,
  config: UsageQueryConfig,
): Promise<ProviderUsageResult | null> {
  return getGatewayWebSocketClient(
    loadToken().trim(),
  ).providerUsageTest<ProviderUsageResult | null>(providerId, JSON.stringify(config));
}

export function useProviderUsage(providers: readonly UsageQueryProvider[]) {
  return useProviderUsageWithQuery(queryProviderUsage, providers);
}
