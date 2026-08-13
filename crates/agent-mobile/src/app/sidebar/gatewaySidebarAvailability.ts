export type GatewaySidebarStatusFreshnessState = {
  socketConnected: boolean;
  agentStatusFresh: boolean;
};

export type GatewaySidebarStatusFreshnessEvent =
  | { type: "connection"; connected: boolean }
  | { type: "status" };

export const INITIAL_GATEWAY_SIDEBAR_STATUS_FRESHNESS: GatewaySidebarStatusFreshnessState = {
  socketConnected: false,
  agentStatusFresh: false,
};

export function reduceGatewaySidebarStatusFreshness(
  state: GatewaySidebarStatusFreshnessState,
  event: GatewaySidebarStatusFreshnessEvent,
): GatewaySidebarStatusFreshnessState {
  if (event.type === "connection") {
    return {
      socketConnected: event.connected,
      // Every authenticated socket starts a new status epoch. The previous
      // socket's cached online verdict cannot make the new path interactive.
      agentStatusFresh: false,
    };
  }
  return {
    ...state,
    agentStatusFresh: state.socketConnected,
  };
}

export function shouldDisableGatewaySidebarSections(input: {
  connectionLost: boolean;
  agentStatusFresh: boolean;
  agentOnline: boolean | null | undefined;
}): boolean {
  return input.connectionLost || !input.agentStatusFresh || input.agentOnline !== true;
}
