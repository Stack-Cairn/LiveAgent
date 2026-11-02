import {
  createImageStudioClient,
  type ImageStudioClientOptions,
} from "@liveagent/ui/lib/imaging/client";
import type { KBrainRuntimeConnection } from "./runtimeConnection";
import { fetchKBrain } from "./transport";

/** Pin every request (including streams) to the selected backend for this scope. */
export function createKBrainImageClient(
  connection: KBrainRuntimeConnection,
  signal: AbortSignal,
  exports?: ImageStudioClientOptions["exports"],
  verificationStorage?: ImageStudioClientOptions["verificationStorage"],
) {
  const { baseUrl, token } = connection;
  return createImageStudioClient({
    signal,
    transport: (path, init) =>
      fetchKBrain(
        path,
        {
          ...init,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        },
        { baseUrl, token },
      ),
    exports,
    verificationStorage,
    // Workspace destinations require a separate host implementation.
  });
}
