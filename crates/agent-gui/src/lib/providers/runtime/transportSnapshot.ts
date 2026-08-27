import {
  LIVEAGENT_UPSTREAM_ORIGIN_HEADER,
  LIVEAGENT_UPSTREAM_URL_HEADER,
  LIVEAGENT_USE_SYSTEM_PROXY_HEADER,
} from "@liveagent/ui/lib/providers/proxy";

/**
 * 一次实际出站尝试的传输装配摘要，供轨迹账本审计逐候选独立性
 * （主选带 use-system-proxy 头、备选不带，互不泄漏）。
 *
 * 脱敏不变量：只读头**名**与路由标记，绝不读头值——鉴权头（authorization/
 * x-api-key/x-goog-api-key）、代理 token、base64 覆盖包的取值全部不进快照。
 * upstream origin 是 scheme+host（与 step_end 已落盘的 provider/model 同
 * 敏感级），fullUrl 模式下完整 URL 可能含 query 凭据，因此只记布尔标记。
 */
export type TransportSnapshot = {
  upstreamOrigin?: string;
  useSystemProxy: boolean;
  fullUrl: boolean;
  /** 全部头名，小写去重后按字典序；值一律不采集。 */
  headerNames: readonly string[];
};

export function captureTransportSnapshot(
  headers: Record<string, string | null> | undefined,
): TransportSnapshot {
  const byLowerName = new Map<string, string>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    // null 是"删除该头"标记（pi-ai ProviderHeaders 语义），不会出现在出站请求里。
    if (value === null) continue;
    byLowerName.set(name.toLowerCase(), value);
  }
  const upstreamOrigin = byLowerName.get(LIVEAGENT_UPSTREAM_ORIGIN_HEADER)?.trim();
  return {
    ...(upstreamOrigin === undefined || upstreamOrigin === "" ? {} : { upstreamOrigin }),
    useSystemProxy: byLowerName.get(LIVEAGENT_USE_SYSTEM_PROXY_HEADER) === "1",
    fullUrl: byLowerName.has(LIVEAGENT_UPSTREAM_URL_HEADER),
    headerNames: [...byLowerName.keys()].sort(),
  };
}
