/**
 * 登录前的端点探测。
 *
 * 两件事必须分清楚，否则用户面对的永远是「连接失败」这种没用的提示：
 *   1. 地址通不通
 *   2. 通的这个东西是 v2 后端，还是 v1 的 Go Gateway
 *
 * 判据是 /healthz 的响应体——两代刚好不一样，不需要猜：
 *   - v2 后端（backend/src/lib.rs）：text/plain 的 `ok`
 *   - v1 Gateway（已从本仓库删除，但旧镜像仍在跑）：JSON `{"ok":true}`
 */

import { LEGACY_GATEWAY_MESSAGE } from "../../lib/backend/commandRouting";
import { type BackendEndpoint, httpBaseUrl } from "../../lib/backend/endpoint";

export type ProbeResult =
  | { kind: "ok" }
  | { kind: "legacy-gateway"; message: string }
  | { kind: "unreachable"; message: string }
  | { kind: "unauthorized"; message: string };

/** 探活：地址通不通、是不是旧 Gateway。不需要密码。 */
async function probeHealth(endpoint: BackendEndpoint): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`${httpBaseUrl(endpoint)}/healthz`, { method: "GET" });
  } catch (error) {
    return {
      kind: "unreachable",
      message:
        `连不上 ${endpoint.host}:${endpoint.port}：` +
        `${error instanceof Error ? error.message : String(error)}。` +
        `请确认后端已启动，以及地址/端口/是否 HTTPS 填对了。`,
    };
  }

  const body = (await response.text()).trim();
  if (body === "ok") return { kind: "ok" };

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.ok === "boolean") {
      return {
        kind: "legacy-gateway",
        message: `${endpoint.host}:${endpoint.port} 上跑的是 v1 的 Go Gateway，不是 v2 后端。${LEGACY_GATEWAY_MESSAGE}`,
      };
    }
  } catch {
    // 不是 JSON，落到下面的兜底
  }

  return {
    kind: "unreachable",
    message:
      `${endpoint.host}:${endpoint.port} 有服务在响应，但它不是 LiveAgent 后端` +
      `（/healthz 返回了 ${body.slice(0, 80) || "空响应"}）。`,
  };
}

/**
 * 完整校验：先探活分辨代际，再用密码打一个只读命令确认鉴权。
 *
 * 选 settings_load_all 是因为它无参、无副作用，而且应用启动本来就要调它。
 */
export async function probeEndpoint(endpoint: BackendEndpoint): Promise<ProbeResult> {
  const health = await probeHealth(endpoint);
  if (health.kind !== "ok") return health;

  let response: Response;
  try {
    response = await fetch(`${httpBaseUrl(endpoint)}/api/settings_load_all`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.password}`,
      },
      body: "{}",
    });
  } catch (error) {
    return {
      kind: "unreachable",
      message: `校验密码时请求失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized", message: "密码不对，后端拒绝了这次连接。" };
  }
  if (!response.ok) {
    return {
      kind: "unreachable",
      message: `后端返回 HTTP ${response.status}，无法完成登录校验。`,
    };
  }
  return { kind: "ok" };
}
