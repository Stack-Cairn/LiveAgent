// MCP server display labels by server key for tool row headers: one shared lookup of
// GET /v1/mcp/tools and GET /v1/mcp, loaded the first time a row asks for it and again
// after MCP settings are saved or the backend connection changes.

import { createKBrainClient } from "./client";
import { subscribeKBrainMcpSettingsSaved } from "./mcp";
import { kbrainMcpServerLabels } from "./mcpToolList";
import { subscribeKBrainRuntimeConnection } from "./runtimeConnection";

/** How long a failed lookup waits before a row may ask again. */
const RETRY_AFTER_FAILURE_MS = 15_000;

let labels: ReadonlyMap<string, string> = new Map();
let state: "idle" | "loading" | "loaded" = "idle";
let failedAt = 0;
let generation = 0;
let watching = false;
const listeners = new Set<() => void>();

async function loadLabels() {
  const client = createKBrainClient();
  // Each half stands on its own: settings alone still name every configured server.
  const [tools, settings] = await Promise.allSettled([
    client.discoverMcpTools({}),
    client.getMcpSettings(),
  ]);
  if (tools.status === "rejected" && settings.status === "rejected") throw tools.reason;
  return kbrainMcpServerLabels(
    tools.status === "fulfilled" ? tools.value : null,
    settings.status === "fulfilled" ? settings.value : null,
  );
}

/** Reloads labels someone already asked for; the old ones stay until the new ones land. */
function invalidate() {
  generation += 1;
  failedAt = 0;
  const requested = state !== "idle";
  state = "idle";
  if (requested) requestKBrainMcpServerLabels();
}

export function getKBrainMcpServerLabels(): ReadonlyMap<string, string> {
  return labels;
}

export function subscribeKBrainMcpServerLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts the shared lookup unless it is loaded, in flight, or recently failed. */
export function requestKBrainMcpServerLabels() {
  if (state !== "idle" || Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return;
  if (!watching) {
    watching = true;
    subscribeKBrainMcpSettingsSaved(invalidate);
    subscribeKBrainRuntimeConnection(invalidate);
  }
  state = "loading";
  const current = generation;
  loadLabels().then(
    (next) => {
      if (current !== generation) return;
      state = "loaded";
      labels = next;
      for (const listener of listeners) listener();
    },
    () => {
      if (current !== generation) return;
      state = "idle";
      failedAt = Date.now();
    },
  );
}
