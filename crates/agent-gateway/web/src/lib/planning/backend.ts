import type { PlanningBackend } from "@liveagent/ui/lib/planning/types";
import { getGatewayWebSocketClient, onGatewayWebSocketClientReplaced } from "../gatewaySocket";
import { loadToken } from "../storage";

function client() {
  return getGatewayWebSocketClient(loadToken().trim());
}
export const backend: PlanningBackend = {
  scope: () => client().getActiveAgent(),
  call: <T>(action: string, input?: unknown) => client().planningManage<T>(action, input),
  subscribe(listener) {
    const attach = () => {
      const socket = client();
      const cleanups = [
        socket.subscribePlanning(listener),
        socket.subscribeConnection(() => listener()),
        socket.subscribeStatus(() => listener()),
      ];
      return () => {
        for (const cleanup of cleanups) cleanup();
      };
    };
    // 订阅挂在单个客户端实例上：登录（token 变化）替换单例后改挂新实例并立即重拉，
    // 否则登录前挂上的订阅收不到日程变更，只能靠 30 秒轮询兜底。
    let detach = attach();
    const detachReplaced = onGatewayWebSocketClientReplaced(() => {
      detach();
      detach = attach();
      listener();
    });
    const timer = setInterval(() => listener(), 30_000);
    return () => {
      detach();
      detachReplaced();
      clearInterval(timer);
    };
  },
};
