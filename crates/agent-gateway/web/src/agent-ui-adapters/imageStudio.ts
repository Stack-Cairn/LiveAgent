import type { ImageStudioHost } from "@liveagent/ui/application/imageStudioHost";
import type { DraftStorage } from "@liveagent/ui/features/image-studio/drafts";
import {
  defaultTranslate,
  formatMessage,
  imageErrorText,
  message,
  type Translate,
} from "@liveagent/ui/features/image-studio/studioText";
// Pure browser helper shared with desktop; it has no Tauri/native dependencies.
import { createBrowserImageDownload } from "@liveagent/ui/lib/imaging/browserDownload";
import { ImageClientError } from "@liveagent/ui/lib/imaging/errors";
import { useEffect, useState } from "react";
import { createGatewayImageClient, type GatewayImageConnection } from "../lib/imageStudio";

/** Supplied only by an authenticated server identity response, never browser preferences. */
export interface TrustedGatewayImageIdentity {
  ownerId: string;
  /** Explicit selected backend grant from that identity response. */
  backendId: string;
  /** Bind identity to the gateway and login session that verified it. */
  gatewayOrigin: string;
  accessToken: string;
}

export function createWebImageStudioHost(
  connection: GatewayImageConnection,
  identity: TrustedGatewayImageIdentity | undefined,
  workspace: string,
  storage?: DraftStorage,
): { host: ImageStudioHost; dispose: () => void } {
  if (!identity?.ownerId.trim()) throw new ImageClientError("IMAGE_IDENTITY_UNAVAILABLE");
  if (
    identity.backendId !== connection.backendId ||
    identity.gatewayOrigin !== connection.baseUrl ||
    identity.accessToken !== connection.token
  ) {
    throw new ImageClientError("IMAGE_AUTH_REQUIRED");
  }
  const controller = new AbortController();
  const scopeKey = JSON.stringify([
    connection.baseUrl,
    identity.ownerId,
    connection.backendId,
    workspace.trim(),
  ]);
  const scopedStorage: DraftStorage = {
    getItem: (key) => storage?.getItem(`${scopeKey}:${key}`) ?? null,
    setItem: (key, value) => storage?.setItem(`${scopeKey}:${key}`, value),
    removeItem: (key) => storage?.removeItem(`${scopeKey}:${key}`),
  };
  const download = createBrowserImageDownload((...args) => client.readAsset(...args));
  const client = createGatewayImageClient(
    connection,
    controller.signal,
    download ? { download } : undefined,
    storage ? scopedStorage : undefined,
  );
  return {
    host: {
      client,
      ownerId: identity.ownerId,
      backendId: connection.backendId,
      scopeKey,
      storage: scopedStorage,
      // Gateway remote exports have no native workspace destination contract yet.
      exportDestinations: download ? ["download"] : [],
    },
    dispose: () => controller.abort(),
  };
}

export function gatewayImageErrorNotice(error: unknown, t: Translate = defaultTranslate): string {
  if (!(error instanceof ImageClientError)) return t("imageStudio.gateway.networkError");
  const status = error.status ? `HTTP ${error.status} · ` : "";
  const text =
    error.code === "IMAGE_IDENTITY_UNAVAILABLE"
      ? t("imageStudio.gateway.identityUnavailable")
      : formatMessage(
          message("imageStudio.gateway.errorWithCode", {
            message: imageErrorText(error, t),
            code: error.code,
          }),
          t,
        );
  return `${status}${text}`;
}

export function useWebImageStudioHost(
  token: string,
  identity: TrustedGatewayImageIdentity | undefined,
  workspace: string,
  /** The caller renders the locale provider, so it passes the interface language in. */
  t: Translate = defaultTranslate,
): { host?: ImageStudioHost; unavailable: string; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState<{
    attempt: number;
    token: string;
    identity: TrustedGatewayImageIdentity;
    workspace: string;
    host?: ImageStudioHost;
    // Kept raw so the notice follows the current interface language.
    error?: { cause: unknown };
  }>();
  useEffect(() => {
    // In particular, do not even access browser draft storage without trusted identity.
    if (!identity || !token) {
      setActive(undefined);
      return;
    }
    let disposed = false;
    let session: ReturnType<typeof createWebImageStudioHost> | undefined;
    const failed = (error: unknown) => {
      if (!disposed) setActive({ attempt, token, identity, workspace, error: { cause: error } });
    };
    try {
      let storage: DraftStorage | undefined;
      try {
        storage = globalThis.localStorage;
      } catch {
        /* Storage can be disabled. */
      }
      session = createWebImageStudioHost(
        { baseUrl: window.location.origin, token, backendId: identity.backendId },
        identity,
        workspace,
        storage,
      );
      const host = session.host;
      void host.client.capabilities().then(() => {
        // Only an actual capabilities response can reach the workbench's supported check.
        // 401/403/5xx remain visible errors, never a synthetic unsupported capability.
        if (!disposed) setActive({ attempt, token, identity, workspace, host });
      }, failed);
    } catch (error) {
      failed(error);
    }
    return () => {
      disposed = true;
      session?.dispose();
    };
  }, [attempt, token, identity, workspace]);
  const current =
    active?.attempt === attempt &&
    active?.token === token &&
    active?.identity === identity &&
    active?.workspace === workspace
      ? active
      : undefined;
  return {
    retry: () => setAttempt((value) => value + 1),
    host: current?.host,
    unavailable:
      (current?.error && gatewayImageErrorNotice(current.error.cause, t)) ??
      t(identity ? "imageStudio.connecting" : "imageStudio.gateway.identityUnavailable"),
  };
}
