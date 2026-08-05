import { useState } from "react";
import { type GatewayRuntimeStatus, OFFLINE_GATEWAY_STATUS } from "./gatewayRuntimeStatusModel";

/**
 * 阶段 4 之后桌面端不再内嵌 gateway,`gateway_status` 命令与
 * `gateway:status` 事件均已删除——运行时状态恒为离线。保留 hook
 * 形状是为了让消费方(状态条/分享入口)零改动地维持既有行为。
 */
export function useGatewayStatus() {
  const [remoteRuntimeStatus, setRemoteRuntimeStatus] =
    useState<GatewayRuntimeStatus>(OFFLINE_GATEWAY_STATUS);

  return { remoteRuntimeStatus, setRemoteRuntimeStatus };
}
