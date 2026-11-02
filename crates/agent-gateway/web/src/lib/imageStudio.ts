import {
  createImageStudioClient,
  fetchTransport,
  type ImageStudioClientOptions,
  type ImageTransport,
} from "@liveagent/ui/lib/imaging/client";
import { ImageClientError } from "@liveagent/ui/lib/imaging/errors";
import { normalizeGatewayAccessToken } from "./gatewayAuth";

export interface GatewayImageConnection {
  /** The authenticated gateway origin, never a provider or browser-supplied backend URL. */
  baseUrl: string;
  /** Explicit server-configured image backend ID; no default/first-agent fallback. */
  backendId: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

/** Fixed destination and credentials for one session. Never refreshes or replays writes. */
export function createGatewayImageTransport(connection: GatewayImageConnection): ImageTransport {
  const { backendId } = connection;
  const token = normalizeGatewayAccessToken(connection.token);
  if (!backendId.trim() || backendId !== backendId.trim()) {
    throw new ImageClientError("IMAGE_INVALID_INPUT");
  }
  if (!token) throw new ImageClientError("IMAGE_AUTH_REQUIRED");
  const transport = fetchTransport({
    baseUrl: connection.baseUrl,
    fetch: connection.fetch,
    headers: () => ({ Authorization: `Bearer ${token}` }),
    credentials: "omit",
  });
  return (path, init) => {
    // Shared client paths retain their own cursor/projectId/variant query parameters.
    if (!path.startsWith("/api/image/") || path.includes("#")) {
      throw new ImageClientError("IMAGE_INVALID_INPUT");
    }
    const url = new URL(path, "https://image.invalid");
    if (!url.pathname.startsWith("/api/image/")) {
      throw new ImageClientError("IMAGE_INVALID_INPUT");
    }
    url.searchParams.set("backendId", backendId);
    const headers = new Headers(init.headers);
    // Identity is established by Gateway. UI draft scope must never become delegation.
    for (const key of [...headers.keys()]) {
      if (/owner|scope|delegation/i.test(key) || key === "x-backend-id") headers.delete(key);
    }
    headers.delete("Authorization");
    return transport(`${url.pathname}${url.search}`, { ...init, headers });
  };
}

export function createGatewayImageClient(
  connection: GatewayImageConnection,
  signal?: AbortSignal,
  exports?: ImageStudioClientOptions["exports"],
  verificationStorage?: ImageStudioClientOptions["verificationStorage"],
) {
  return createImageStudioClient({
    transport: createGatewayImageTransport(connection),
    imagePath: "/api/image",
    healthPath: "/api/image/health",
    signal,
    exports,
    verificationStorage,
  });
}
