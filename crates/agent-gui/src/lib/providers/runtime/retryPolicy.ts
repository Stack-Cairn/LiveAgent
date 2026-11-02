import type { ProviderRetryPolicy } from "../../settings";
import type { StreamRetryConfig } from "./streamRetry";

/**
 * 供应商级重试策略 → withStreamRetry 选项的解析（PR-2 策略归属权反转）。
 *
 * - 缺省（undefined）→ 空对象：不带 maxAttempts/disabled，withStreamRetry
 *   落到全局 DEFAULT_STREAM_RETRY_MAX_ATTEMPTS——与反转前行为逐字节一致；
 * - off → { disabled: true }：禁用流内重试（不影响跨供应商 failover）；
 * - custom → { maxAttempts: maxRetries + 1 }：设置里存的是"首次失败后的
 *   重试次数"（用户口径，不含首次请求），withStreamRetry 的 maxAttempts
 *   是总尝试数，两者相差恰好 1。
 *
 * 返回值供消费方与自己的 onRetry/onRetryRecovered 回调展开合并；回调语义
 * 与 buffer-until-commit 缓冲不受策略影响。failover 场景下每个候选用各自
 * runtime 的策略调用本函数——策略跟着目标供应商走，与传输配置同口径。
 */
export function resolveStreamRetryConfig(
  retryPolicy: ProviderRetryPolicy | undefined,
): Pick<StreamRetryConfig, "maxAttempts" | "disabled"> {
  if (!retryPolicy) return {};
  if (retryPolicy.mode === "off") return { disabled: true };
  return { maxAttempts: retryPolicy.maxRetries + 1 };
}
