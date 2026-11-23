// The login screen loads without the socket client (see App.tsx), yet a login
// or logout must drop any client a previous session left behind. The client
// module registers its reset here when it loads; before that there is no
// client to drop.
let resetLoadedClient: (() => void) | null = null;

export function registerGatewaySocketReset(reset: () => void) {
  resetLoadedClient = reset;
}

/** Disposes the gateway socket client, if its module has been loaded. */
export function resetGatewaySocketClientIfLoaded() {
  resetLoadedClient?.();
}
