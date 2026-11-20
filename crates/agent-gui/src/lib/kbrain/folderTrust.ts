import type {
  WorkspaceFolderTrustClient,
  WorkspaceFolderTrustStatus,
} from "@liveagent/ui/contracts/workspaceFolderTrust";
import { hasFrozenCapability, readKBrainHealthResponse } from "@liveagent/ui/lib/kbrain/health";
import { fetchKBrain } from "./transport";
import type { KBrainClientOptions } from "./types";

/** K-brain capability: GET/POST/DELETE /v1/trust read, grant and revoke folder trust. */
export const KBRAIN_FOLDER_TRUST_CAPABILITY = "folder_trust";

const trustListeners = new Set<(status: WorkspaceFolderTrustStatus) => void>();

/**
 * Notifies views that depend on folder trust (the composer's slash command
 * catalog) after LiveAgent granted or revoked it.
 */
export function subscribeKBrainFolderTrustChanged(
  listener: (status: WorkspaceFolderTrustStatus) => void,
): () => void {
  trustListeners.add(listener);
  return () => {
    trustListeners.delete(listener);
  };
}

export function notifyKBrainFolderTrustChanged(status: WorkspaceFolderTrustStatus): void {
  for (const listener of trustListeners) listener(status);
}

function readTrustStatus(value: unknown): WorkspaceFolderTrustStatus {
  const body = value as { workdir?: unknown; trusted?: unknown; source?: unknown } | null;
  if (!body || typeof body.workdir !== "string" || typeof body.trusted !== "boolean") {
    throw new Error("Invalid K-brain folder trust response");
  }
  return {
    workdir: body.workdir,
    trusted: body.trusted,
    ...(typeof body.source === "string" && body.source ? { source: body.source } : {}),
  };
}

export function createKBrainFolderTrustClient(
  options: KBrainClientOptions = {},
): WorkspaceFolderTrustClient {
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetchKBrain(path, init, options);
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Keep non-JSON backend errors as they are.
      }
      throw Object.assign(
        new Error(message || `K-brain folder trust request failed (${response.status})`),
        { status: response.status },
      );
    }
    return readTrustStatus(JSON.parse(text));
  }
  const query = (path: string) => `/v1/trust?workdir=${encodeURIComponent(path.trim())}`;
  return {
    supported: () =>
      fetchKBrain("/v1/health", undefined, options)
        .then(readKBrainHealthResponse)
        .then((health) => hasFrozenCapability(health, KBRAIN_FOLDER_TRUST_CAPABILITY))
        .catch(() => false),
    get: (path) => request(query(path)),
    trust: async (path) => {
      const status = await request("/v1/trust", {
        method: "POST",
        body: JSON.stringify({ workdir: path.trim() }),
      });
      notifyKBrainFolderTrustChanged(status);
      return status;
    },
    revoke: async (path) => {
      const status = await request(query(path), { method: "DELETE" });
      notifyKBrainFolderTrustChanged(status);
      return status;
    },
  };
}
