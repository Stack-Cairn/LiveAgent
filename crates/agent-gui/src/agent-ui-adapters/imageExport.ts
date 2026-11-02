import { invoke } from "@liveagent/app/shims/tauriCore";
import type { ImageStudioClientOptions } from "@liveagent/ui/lib/imaging/client";
import { ImageClientError } from "@liveagent/ui/lib/imaging/errors";
import type { ExportDestination } from "@liveagent/ui/lib/imaging/types";
import { isTauriHost } from "../lib/host";
import type { KBrainRuntimeConnection } from "../lib/kbrain/runtimeConnection";

/** Native manager validates backend identity, asset, dialog path and completed write. */
export function createNativeImageExports(
  connection: KBrainRuntimeConnection,
): ImageStudioClientOptions["exports"] {
  if (!isTauriHost() || !connection.managedLocal) return undefined;
  const exportTo =
    (destination: ExportDestination) => async (assetId: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new ImageClientError("IMAGE_ABORTED");
      try {
        const result = await invoke<{ saved: boolean }>("image_export_asset", {
          request: { assetId, backendBaseUrl: connection.baseUrl, destination },
        });
        if (signal?.aborted) throw new ImageClientError("IMAGE_ABORTED");
        if (!result || typeof result.saved !== "boolean")
          throw new ImageClientError("IMAGE_PROTOCOL_ERROR");
        return { saved: result.saved };
      } catch (error) {
        if (signal?.aborted) throw new ImageClientError("IMAGE_ABORTED");
        if (error instanceof ImageClientError) throw error;
        // Native errors can be strings or objects. Never forward their raw message/details.
        const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const codes: Record<string, string> = {
          UNSUPPORTED: "IMAGE_UNSUPPORTED_OPERATION",
          INVALID_ARGUMENT: "IMAGE_INVALID_INPUT",
          UNAUTHORIZED: "IMAGE_AUTH_REQUIRED",
          FORBIDDEN: "IMAGE_FORBIDDEN",
          NOT_FOUND: "IMAGE_NOT_FOUND",
          NETWORK_ERROR: "IMAGE_NETWORK_ERROR",
        };
        const code =
          typeof value.code === "string" && Object.hasOwn(codes, value.code)
            ? codes[value.code]
            : "IMAGE_EXPORT_FAILED";
        const status =
          typeof value.status === "number" && value.status >= 400 && value.status <= 599
            ? value.status
            : 0;
        throw new ImageClientError(code, status, value.retryable === true);
      }
    };
  return { download: exportTo("download"), local_workspace: exportTo("local_workspace") };
}
