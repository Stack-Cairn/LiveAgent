import type { ImageStudioHost } from "@liveagent/ui/application/imageStudioHost";
import type { DraftStorage } from "@liveagent/ui/features/image-studio/drafts";
import type { ExportDestination } from "@liveagent/ui/lib/imaging/types";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createKBrainImageClient } from "../lib/kbrain/images";
import {
  getKBrainRuntimeConnection,
  type KBrainRuntimeConnection,
  subscribeKBrainRuntimeConnection,
} from "../lib/kbrain/runtimeConnection";
import { createBrowserImageDownload } from "./imageDownload";
import { createNativeImageExports } from "./imageExport";

export function createDesktopImageStudioHost(
  connection: KBrainRuntimeConnection,
  workspace: string,
  storage?: DraftStorage,
): { host: ImageStudioHost; dispose: () => void } {
  const controller = new AbortController();
  const backendId = connection.managedLocal
    ? connection.storageId?.trim()
    : connection.baseUrl.trim().replace(/\/+$/, "");
  if (!backendId) throw new Error("Managed backend storage identity is unavailable");
  const workspaceKey = JSON.stringify([workspace.trim()]);
  const scopedStorage: DraftStorage = {
    getItem: (key) => storage?.getItem(`${workspaceKey}:${key}`) ?? null,
    setItem: (key, value) => storage?.setItem(`${workspaceKey}:${key}`, value),
    removeItem: (key) => storage?.removeItem(`${workspaceKey}:${key}`),
  };
  const download = createBrowserImageDownload((...args) => client.readAsset(...args));
  const exports = createNativeImageExports(connection) ?? (download ? { download } : undefined);
  const verificationScope = JSON.stringify(["local", backendId, workspace.trim()]);
  const verificationStorage = storage
    ? {
        getItem: (key: string) => storage.getItem(`${verificationScope}:${key}`),
        setItem: (key: string, value: string) =>
          storage.setItem(`${verificationScope}:${key}`, value),
      }
    : undefined;
  const client = createKBrainImageClient(
    connection,
    controller.signal,
    exports,
    verificationStorage,
  );
  return {
    host: {
      client,
      // This private desktop connection is authenticated by the backend as local.
      // This value namespaces drafts only; it is never sent as an owner header.
      ownerId: "local",
      backendId,
      scopeKey: JSON.stringify(["local", backendId, workspace.trim()]),
      storage: scopedStorage,
      exportDestinations: Object.keys(exports ?? {}) as ExportDestination[],
    },
    dispose: () => controller.abort(),
  };
}

export function useDesktopImageStudioHost(workspace: string): ImageStudioHost | undefined {
  const connection = useSyncExternalStore(
    subscribeKBrainRuntimeConnection,
    getKBrainRuntimeConnection,
    getKBrainRuntimeConnection,
  );
  const [active, setActive] = useState<{
    connection: KBrainRuntimeConnection;
    workspace: string;
    host: ImageStudioHost;
  }>();
  useEffect(() => {
    if (!connection) {
      setActive(undefined);
      return;
    }
    let storage: DraftStorage | undefined;
    try {
      storage = globalThis.localStorage;
    } catch {
      /* Private storage may be disabled. */
    }
    const session = createDesktopImageStudioHost(connection, workspace, storage);
    setActive({ connection, workspace, host: session.host });
    return session.dispose;
  }, [connection, workspace]);
  return active?.connection === connection && active?.workspace === workspace
    ? active.host
    : undefined;
}
