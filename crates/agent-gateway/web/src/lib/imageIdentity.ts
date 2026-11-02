import { ImageClientError } from "@liveagent/ui/lib/imaging/errors";
import { useEffect, useState } from "react";
import type { TrustedGatewayImageIdentity } from "../agent-ui-adapters/imageStudio";

export async function fetchSingleUserImageIdentity(
  origin: string,
  token: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<TrustedGatewayImageIdentity> {
  if (!token.trim()) throw new ImageClientError("IMAGE_AUTH_REQUIRED");
  const response = await fetcher(`${origin}/api/image/identity`, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok)
    throw new ImageClientError(
      response.status === 401 ? "IMAGE_AUTH_REQUIRED" : "IMAGE_IDENTITY_UNAVAILABLE",
      response.status,
    );
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new ImageClientError("IMAGE_PROTOCOL_ERROR");
  const v = value as Record<string, unknown>;
  if (
    v.mode !== "single_user" ||
    v.ownerId !== "local" ||
    typeof v.backendId !== "string" ||
    !v.backendId.trim()
  )
    throw new ImageClientError("IMAGE_PROTOCOL_ERROR");
  return { ownerId: "local", backendId: v.backendId, gatewayOrigin: origin, accessToken: token };
}

export function useSingleUserImageIdentity(token: string, supplied?: TrustedGatewayImageIdentity) {
  const [active, setActive] = useState<{ token: string; identity: TrustedGatewayImageIdentity }>();
  useEffect(() => {
    if (supplied || !token.trim()) return;
    const controller = new AbortController();
    void fetchSingleUserImageIdentity(window.location.origin, token, controller.signal)
      .then((identity) => {
        if (!controller.signal.aborted) setActive({ token, identity });
      })
      .catch(() => {
        if (!controller.signal.aborted) setActive(undefined);
      });
    return () => controller.abort();
  }, [token, supplied]);
  if (supplied) return supplied;
  return active?.token === token ? active.identity : undefined;
}
