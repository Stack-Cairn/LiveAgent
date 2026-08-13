// WebUI adapter for WorkspaceActivityClient (web-only, not mirrored).
//
// Wraps the gateway socket's per-workdir workspace.subscribe/unsubscribe
// channel behind the mirrored WorkspaceActivityClient interface. Reconnect
// handling (re-subscribe + `{ kind: "reset" }` fan-out) lives in the socket
// client itself.

import type {
  WorkspaceActivityClient,
  WorkspaceActivityEventPayload,
} from "@liveagent/ui/lib/workspace-activity/types";

type WorkspaceActivitySource = {
  subscribeWorkspaceActivity(
    workdir: string,
    listener: (event: WorkspaceActivityEventPayload) => void,
  ): () => void;
};

export function createGatewayWorkspaceActivityClient(
  api: WorkspaceActivitySource,
): WorkspaceActivityClient {
  return {
    subscribe: (workdir, listener) => api.subscribeWorkspaceActivity(workdir, listener),
  };
}
