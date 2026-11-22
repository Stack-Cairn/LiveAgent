import { invoke } from "@liveagent/app/shims/tauriCore";
import {
  type DiagnosticsBundle,
  type DiagnosticsConnection,
  type DiagnosticsLogFile,
  type DiagnosticsSaveResult,
  downloadDiagnosticsZip,
  type HostDiagnosticsFacts,
} from "@liveagent/ui/lib/diagnostics/bundle";
import type { KBrainHealth } from "@liveagent/ui/lib/kbrain/health";
import { isTauriHost } from "../lib/host";
import { countKBrainSessions } from "../lib/kbrain/history";
import {
  getConfiguredKBrainConnection,
  getKBrainRuntimeConnection,
} from "../lib/kbrain/runtimeConnection";
import { getKBrainHealth } from "./kbrainSettings";

/** Shape returned by the `diagnostics_collect_native` Tauri command. */
type NativeDiagnostics = {
  appVersion: string;
  buildProfile: string;
  os: string;
  osVersion?: string | null;
  arch: string;
  homeDir?: string | null;
  dataRoot?: string | null;
  logFiles: DiagnosticsLogFile[];
};

export const DIAGNOSTICS_SAVE_LABEL_KEY: "diagnostics.save" | "diagnostics.download" = isTauriHost()
  ? "diagnostics.save"
  : "diagnostics.download";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeBackend(): Promise<{
  health: KBrainHealth | null;
  healthError?: string;
  connection: DiagnosticsConnection;
}> {
  const connection = getKBrainRuntimeConnection() ?? getConfiguredKBrainConnection();
  if (!connection) return { health: null, connection: { state: "unknown" } };
  const started = performance.now();
  try {
    const health = await getKBrainHealth();
    return {
      health,
      connection: {
        state: "connected",
        endpoint: connection.baseUrl,
        latencyMs: performance.now() - started,
      },
    };
  } catch (error) {
    return {
      health: null,
      healthError: errorText(error),
      connection: { state: "unreachable", endpoint: connection.baseUrl, error: errorText(error) },
    };
  }
}

export async function collectHostDiagnostics(): Promise<HostDiagnosticsFacts> {
  const tauri = isTauriHost();
  const [backend, native, sessionCount] = await Promise.all([
    probeBackend(),
    tauri
      ? invoke<NativeDiagnostics>("diagnostics_collect_native").catch((error) => {
          console.warn("collect native diagnostics failed", errorText(error));
          return null;
        })
      : Promise.resolve(null),
    countKBrainSessions().catch(() => null),
  ]);
  const version =
    native?.appVersion ??
    (typeof __LIVEAGENT_APP_VERSION__ === "string" ? __LIVEAGENT_APP_VERSION__ : "unknown");
  return {
    host: tauri ? "desktop" : "browser",
    app: {
      version,
      build: native?.buildProfile,
      channel: version.includes("-") ? "prerelease" : "stable",
      os: native?.os ?? globalThis.navigator?.platform,
      osVersion: native?.osVersion ?? undefined,
      arch: native?.arch,
      userAgent: globalThis.navigator?.userAgent,
      locale: globalThis.navigator?.language,
    },
    kbrain: backend,
    sessionCount,
    logFiles: native?.logFiles ?? [],
    homeDirs: native?.homeDir ? [native.homeDir] : [],
    dataRoot: native?.dataRoot ?? undefined,
  };
}

/** Desktop: native save dialog and a Rust zip writer; plain browser: a download. */
export async function saveDiagnosticsBundle(
  bundle: DiagnosticsBundle,
): Promise<DiagnosticsSaveResult> {
  if (!isTauriHost()) return downloadDiagnosticsZip(bundle);
  const location = await invoke<string | null>("diagnostics_save_bundle", {
    fileName: bundle.fileName,
    files: bundle.files.map((file) => ({ path: file.path, content: file.content })),
  });
  return location ? { status: "saved", location } : { status: "cancelled" };
}
