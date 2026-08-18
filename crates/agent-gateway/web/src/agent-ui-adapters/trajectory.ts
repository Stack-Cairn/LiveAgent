/**
 * 轨迹视图的 WebUI 宿主：把共享实现接到 shim 的 invoke 上。
 *
 * shim 会把 `trajectory_get_events` / `trajectory_get_sections` 路由成 Gateway 的
 * `trajectory.fetch` 请求，最终仍由桌面端应答——WebUI 不持有任何本地轨迹数据。
 */

import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { createInvokeTrajectoryHost } from "@liveagent/ui/lib/trajectory/host";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import { invoke } from "@/shims/tauriCore";

/**
 * 构造 WebUI 宿主。
 *
 * @returns 轨迹视图宿主。
 */
export function createGatewayTrajectoryHost(
  api: GatewayWebSocketClientLike | null,
  openFileLink?: (link: ChatFileLink) => void,
): TrajectoryHost {
  return createInvokeTrajectoryHost(invoke, {
    ...(openFileLink === undefined ? {} : { openFileLink }),
    ...(api === null
      ? {}
      : {
          subscribeRefresh: (listener) => {
            let initialized = false;
            let wasConnected = false;
            return api.subscribeConnection((connected) => {
              if (!initialized) {
                initialized = true;
                wasConnected = connected;
                return;
              }
              const recovered = connected && !wasConnected;
              wasConnected = connected;
              if (recovered) listener();
            });
          },
        }),
  });
}
