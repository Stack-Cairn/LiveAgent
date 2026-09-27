import type { PlanningBackend } from "@liveagent/ui/lib/planning/types";
import { getGatewayWebSocketClient } from "../gatewaySocket";
import { loadToken } from "../storage";

function client() {
  return getGatewayWebSocketClient(loadToken().trim());
}
export const backend: PlanningBackend = {
  scope: () => client().getActiveAgent(),
  call: <T>(action: string, input?: unknown) => client().planningManage<T>(action, input),
  subscribe(listener) {
    const socket = client();
    const cleanups = [
      socket.subscribePlanning(listener),
      socket.subscribeConnection(() => listener()),
      socket.subscribeStatus(() => listener()),
    ];
    const timer = setInterval(() => listener(), 30_000);
    return () => {
      for (const cleanup of cleanups) cleanup();
      clearInterval(timer);
    };
  },
};
