import "@liveagent/ui/i18n/namespaces/settings";
import {
  type DiagnosticsBundle,
  type DiagnosticsSaveResult,
  downloadDiagnosticsZip,
  type HostDiagnosticsFacts,
} from "@liveagent/ui/lib/diagnostics/bundle";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";

export const DIAGNOSTICS_SAVE_LABEL_KEY: "diagnostics.save" | "diagnostics.download" =
  "diagnostics.download";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The WebUI reaches K-brain only through the Gateway: it reports the Gateway's
 * view of the connected agent and has no local log files to add.
 */
export async function collectHostDiagnostics(): Promise<HostDiagnosticsFacts> {
  const client = getGatewayWebSocketClient(loadToken().trim());
  const started = performance.now();
  const [status, history] = await Promise.all([
    client.getStatus().then(
      (value) => ({ ok: true as const, value, latencyMs: performance.now() - started }),
      (error: unknown) => ({ ok: false as const, error: errorText(error) }),
    ),
    client.listHistory(1, 1).catch(() => null),
  ]);
  const agentVersion = status.ok ? status.value.agent_version : undefined;
  return {
    host: "webui",
    app: {
      version: agentVersion ?? "unknown",
      channel: agentVersion?.includes("-") ? "prerelease" : agentVersion ? "stable" : undefined,
      os: globalThis.navigator?.platform,
      userAgent: globalThis.navigator?.userAgent,
      locale: globalThis.navigator?.language,
    },
    kbrain: {
      health: null,
      healthError: "Backend health is not available to the WebUI",
      connection: status.ok
        ? {
            state: status.value.online ? "connected" : "unreachable",
            endpoint: globalThis.location?.origin,
            latencyMs: status.latencyMs,
            ...(status.value.online ? {} : { error: "agent offline" }),
          }
        : { state: "unreachable", endpoint: globalThis.location?.origin, error: status.error },
    },
    sessionCount: history?.total_count ?? null,
    logFiles: [],
    homeDirs: [],
  };
}

export async function saveDiagnosticsBundle(
  bundle: DiagnosticsBundle,
): Promise<DiagnosticsSaveResult> {
  return downloadDiagnosticsZip(bundle);
}
