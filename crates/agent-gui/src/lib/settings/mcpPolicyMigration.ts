import {
  isCuaDriverServer,
  serverPolicyKeyCandidates,
} from "@liveagent/ui/contracts/mcpServerDefaults";
import { kbrainMcpSettingsDocument } from "../kbrain/mcp";
import { getConfiguredKBrainConnection } from "../kbrain/runtimeConnection";
import type { ToolPolicy } from "./index";

const MIGRATED_KEY = "liveagent.kbrain-mcp-policy-migrated.v1";

export type McpPolicyMigrationResult = {
  document: unknown;
  toolPolicies: Record<string, ToolPolicy> | undefined;
};

function readMigrated(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function legacyServerPolicy(
  toolPolicies: Record<string, ToolPolicy>,
  serverId: string,
): { policy?: ToolPolicy; keys: string[] } {
  const keys = serverPolicyKeyCandidates(serverId).filter((key) => key in toolPolicies);
  const policy = keys.map((key) => toolPolicies[key]).find((value) => value !== undefined);
  return { policy, keys };
}

/**
 * Moves the per-server MCP approval chosen in older LiveAgent builds (stored
 * locally as `toolPolicies["server:<id>"]`, never sent to K-brain) into the
 * server's K-brain `policy["*"]`, where K-brain enforces it. A policy K-brain
 * already has for the server wins. Runs once per server and K-brain data root;
 * the migrated local keys are dropped. Servers K-brain manages itself
 * (cua-driver) keep their local policy, which their own settings page owns.
 */
export async function migrateLegacyMcpServerPolicies(
  toolPolicies: Record<string, ToolPolicy> | undefined,
  document: unknown,
  save: (settings: unknown) => Promise<unknown>,
): Promise<McpPolicyMigrationResult> {
  const unchanged = { document, toolPolicies };
  if (!toolPolicies || Object.keys(toolPolicies).length === 0) return unchanged;
  const settings = kbrainMcpSettingsDocument(document);
  if (!settings) return unchanged;
  const connection = getConfiguredKBrainConnection();
  const markerKey = `${MIGRATED_KEY}:${connection?.storageId ?? connection?.baseUrl ?? "default"}`;
  const migrated = readMigrated(markerKey);

  const handled: string[] = [];
  const droppedKeys = new Set<string>();
  let changed = false;
  const servers = settings.servers.map((server) => {
    const id = typeof server.id === "string" ? server.id : "";
    if (!id) return server;
    const identity = { id, command: typeof server.command === "string" ? server.command : "" };
    if (isCuaDriverServer(identity)) return server;
    const legacy = legacyServerPolicy(toolPolicies, id);
    if (migrated.includes(id)) {
      // Moved on an earlier start; a local key left behind (no save since) goes now.
      for (const key of legacy.keys) droppedKeys.add(key);
      return server;
    }
    if (!legacy.policy) return server;
    handled.push(id);
    for (const key of legacy.keys) droppedKeys.add(key);
    const current =
      server.policy && typeof server.policy === "object"
        ? (server.policy as Record<string, unknown>)
        : {};
    if (typeof current["*"] === "string") return server;
    changed = true;
    return { ...server, policy: { ...current, "*": legacy.policy } };
  });
  if (handled.length === 0 && droppedKeys.size === 0) return unchanged;

  let result = document;
  if (changed) {
    try {
      result = await save({ ...settings, servers });
    } catch (error) {
      // K-brain keeps its current policy; the next load retries the migration.
      console.warn("[mcp] could not move MCP server approvals to K-brain", error);
      return unchanged;
    }
  }
  if (handled.length > 0) {
    try {
      localStorage.setItem(markerKey, JSON.stringify([...new Set([...migrated, ...handled])]));
    } catch {
      // Re-running is harmless: K-brain's policy now wins over the local key.
    }
  }
  const nextPolicies = Object.fromEntries(
    Object.entries(toolPolicies).filter(([key]) => !droppedKeys.has(key)),
  ) as Record<string, ToolPolicy>;
  return {
    document: result,
    toolPolicies: Object.keys(nextPolicies).length > 0 ? nextPolicies : undefined,
  };
}
