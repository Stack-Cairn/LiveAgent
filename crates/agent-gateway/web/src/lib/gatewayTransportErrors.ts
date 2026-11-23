// Connection-level failures of the Gateway WebSocket, classified by message.
// Kept free of transport code so the always-loaded shell can recognise them
// without pulling the lazily loaded socket client into the main bundle.
import { errorMessageWithFallback as asErrorMessage } from "@liveagent/ui/lib/shared/value";

// Status error emitted while a reconnect is in progress; the WebUI renders its
// own translated connection banner instead of this text.
export const GATEWAY_RECONNECTING_NOTICE = "Gateway is reconnecting";

export function isRecoverableGatewayTransportError(error: unknown) {
  const message = asErrorMessage(error, "");
  return (
    message.startsWith("Gateway WebSocket disconnected") ||
    message === "Gateway WebSocket is not connected" ||
    message.startsWith("Gateway transport stalled")
  );
}

export function isConnectionSetupTimeoutError(error: unknown) {
  const message = asErrorMessage(error, "");
  return (
    message === "Gateway WebSocket connection timed out" ||
    message === "Gateway WebSocket auth timed out"
  );
}

// The request never reached the gateway because the connection is down or
// still being re-established. Shown as connection status, never as a chat error.
export function isGatewayTransportFailure(error: unknown) {
  return (
    isRecoverableGatewayTransportError(error) ||
    isConnectionSetupTimeoutError(error) ||
    asErrorMessage(error, "") === GATEWAY_RECONNECTING_NOTICE
  );
}
