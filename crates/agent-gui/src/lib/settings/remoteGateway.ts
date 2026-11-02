import type { AppSettings } from "./index";

export type RemoteGatewaySettings = Pick<
  AppSettings["remote"],
  "enabled" | "gatewayUrl" | "token" | "managedLocal" | "localGatewayPort" | "localGatewayToken"
>;

/**
 * Whether a Gateway connection is configured: a Gateway hosted on this computer
 * (managedLocal) needs its port and localGatewayToken, an external one its URL and token.
 */
export function isRemoteSettingsConfigured(remote: RemoteGatewaySettings) {
  if (remote.managedLocal) {
    return (
      Number.isInteger(remote.localGatewayPort) &&
      remote.localGatewayPort >= 1 &&
      remote.localGatewayPort <= 65_535 &&
      remote.localGatewayToken.trim() !== ""
    );
  }
  return remote.gatewayUrl.trim() !== "" && remote.token.trim() !== "";
}
