import { toKBrainMcpSettings } from "../kbrain/mcp";
import { getConfiguredKBrainConnection } from "../kbrain/runtimeConnection";
import type { McpSettings } from "./index";

const IMPORTED_KEY = "liveagent.kbrain-legacy-mcp-imported.v1";

// Native legacy settings belong only to the managed local backend's data root.
export async function importLegacyMcpSettings(
  legacy: McpSettings,
  document: unknown,
  save: (settings: unknown) => Promise<unknown>,
): Promise<unknown> {
  const connection = getConfiguredKBrainConnection();
  if (!connection?.managedLocal || legacy.servers.length === 0) return document;
  const settings = (document as { settings?: { servers?: unknown[]; selected?: string[] } })
    ?.settings;
  if (!Array.isArray(settings?.servers)) throw new Error("Malformed K-brain MCP settings");
  const key = `${IMPORTED_KEY}:${connection.storageId ?? "managed-local"}`;
  let imported: string[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(value)) imported = value.filter((id): id is string => typeof id === "string");
  } catch {
    // The backend remains authoritative when the migration cache is unavailable.
  }
  const known = new Set(settings.servers.map((server) => (server as { id?: string }).id));
  const missing = legacy.servers.filter(
    (server) => server.id && !known.has(server.id) && !imported.includes(server.id),
  );
  let result = document;
  if (missing.length > 0) {
    const added = toKBrainMcpSettings({ servers: missing, selected: [] }).servers;
    result = await save({
      ...settings,
      servers: [...settings.servers, ...added],
      selected: [
        ...new Set([
          ...(settings.selected ?? []),
          ...legacy.selected.filter((id) => missing.some((server) => server.id === id)),
        ]),
      ],
    });
  }
  // A deleted backend record must not be restored from SQLite on the next load.
  localStorage.setItem(
    key,
    JSON.stringify([...new Set([...imported, ...legacy.servers.map((server) => server.id)])]),
  );
  return result;
}
