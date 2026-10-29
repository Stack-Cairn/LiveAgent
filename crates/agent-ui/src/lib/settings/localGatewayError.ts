// The desktop's local Gateway supervisor (src-tauri services/local_gateway.rs,
// services/gateway/connection.rs)
// reports fixed English errors. Show them in the interface language; any
// other message is displayed as received.
const LOCAL_GATEWAY_ERRORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Local Gateway port (\d+) is already in use/, "settings.localGatewayError.portInUse"],
  [
    /Local Gateway exited before becoming ready \((.*)\)/,
    "settings.localGatewayError.exitedBeforeReady",
  ],
  [
    /Local Gateway exited during its health check/,
    "settings.localGatewayError.exitedDuringHealthCheck",
  ],
  [
    /Permission denied starting the local Gateway executable/,
    "settings.localGatewayError.permissionDenied",
  ],
  [
    /Local Gateway requires a valid authentication token/,
    "settings.localGatewayError.invalidToken",
  ],
  [/Local Gateway requires a nonzero loopback port/, "settings.localGatewayError.invalidPort"],
  [/Local Gateway startup was cancelled/, "settings.localGatewayError.startupCancelled"],
  [/Local Gateway control pipe is unavailable/, "settings.localGatewayError.controlPipe"],
  [/Local gateway supervisor task failed/, "settings.localGatewayError.supervisorFailed"],
  [/Unable to locate desktop executable/, "settings.localGatewayError.desktopExecutable"],
  [/Unable to locate desktop directory/, "settings.localGatewayError.desktopDirectory"],
  [/Local Gateway executable was not found/, "settings.localGatewayError.executableMissing"],
  [/Local Gateway must be a Windows executable/, "settings.localGatewayError.notExecutable"],
  [/Local Gateway startup timed out/, "settings.localGatewayError.startupTimeout"],
  [/Unable to start the local Gateway executable/, "settings.localGatewayError.startFailed"],
  [/Unable to stop the local Gateway process/, "settings.localGatewayError.stopFailed"],
  [/Unable to inspect the local Gateway process/, "settings.localGatewayError.inspectFailed"],
  [/Unable to collect the local Gateway process/, "settings.localGatewayError.collectFailed"],
  [/Unable to prepare the local Gateway data directory/, "settings.localGatewayError.dataDir"],
  [/Unable to prepare the local Gateway health check/, "settings.localGatewayError.healthCheck"],
  [/Unable to update the local Gateway image backend/, "settings.localGatewayError.imageBackend"],
];

export function localizeLocalGatewayError(message: string, t: (key: string) => string): string {
  for (const [pattern, key] of LOCAL_GATEWAY_ERRORS) {
    const match = pattern.exec(message);
    if (match) return t(key).replace(/\{port\}|\{status\}/, match[1] ?? "");
  }
  return message;
}
