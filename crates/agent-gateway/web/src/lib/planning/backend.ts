import { followBrowserPlanning } from "@liveagent/ui/lib/planning/browserTimeZone";
import type { PlanningBackend } from "@liveagent/ui/lib/planning/types";
import { getGatewayWebSocketClient } from "../gatewaySocket";
import { loadToken } from "../storage";

function client() {
  return getGatewayWebSocketClient(loadToken().trim());
}
export const backend: PlanningBackend = {
  scope: () => client().getActiveAgent(),
  // Browser client: an automatic calendar zone shows this computer's zone (read at startup),
  // the same as the direct HTTP host. The scope is the active remote agent, so switching
  // agents reads that agent's shared preference.
  async call<T>(action: string, input?: unknown) {
    const socket = client();
    const scope = socket.getActiveAgent();
    const result = await socket.planningManage<T>(action, input);
    return followBrowserPlanning(scope, action, result, () =>
      socket.planningManage<{ preference?: unknown }>("timezone.get", {}),
    );
  },
  subscribe(listener) {
    const socket = client();
    const cleanups = [
      socket.subscribePlanning(listener),
      socket.subscribeConnection(() => listener()),
      socket.subscribeStatus(() => listener()),
    ];
    const timer = setInterval(() => listener(), 2_000);
    return () => {
      for (const cleanup of cleanups) cleanup();
      clearInterval(timer);
    };
  },
};
