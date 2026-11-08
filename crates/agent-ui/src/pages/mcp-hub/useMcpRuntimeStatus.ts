import {
  getResourceHostCapabilities,
  type McpServerRuntimeStatus,
} from "@liveagent/ui/lib/resourceHost";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often the Hub re-reads statuses while a server is still connecting. */
export const MCP_STATUS_POLL_MS = 1500;
/** Polling stops after this long even if a server never leaves "connecting". */
export const MCP_STATUS_POLL_LIMIT_MS = 60_000;

export type McpRuntimeStatusState = {
  /** null while the host has no status source (older backend or no adapter). */
  statuses: Map<string, McpServerRuntimeStatus> | null;
  available: boolean;
  reconnecting: boolean;
  error: string | null;
  reconnect: () => Promise<void>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Live MCP server statuses for the Hub: read on mount, after every MCP save
 * from this client, and every 1.5s while a server is connecting.
 */
export function useMcpRuntimeStatus(): McpRuntimeStatusState {
  const adapter = getResourceHostCapabilities().mcpStatusAdapter;
  const [statuses, setStatuses] = useState<Map<string, McpServerRuntimeStatus> | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pollStartedAt = useRef<number | null>(null);

  const apply = useCallback((list: McpServerRuntimeStatus[]) => {
    setStatuses(new Map(list.map((status) => [status.id, status])));
  }, []);

  const refresh = useCallback(async () => {
    if (!adapter) return;
    const current = ++generation.current;
    try {
      const list = await adapter.statuses();
      if (current === generation.current) apply(list);
    } catch {
      // Statuses are informational; the cards still render without them.
    }
  }, [adapter, apply]);

  useEffect(() => {
    if (!adapter) return;
    void refresh();
    const unsubscribe = adapter.subscribe?.(() => {
      pollStartedAt.current = null;
      void refresh();
    });
    return () => {
      generation.current += 1;
      unsubscribe?.();
    };
  }, [adapter, refresh]);

  const connecting = statuses
    ? [...statuses.values()].some((status) => status.status === "connecting")
    : false;
  useEffect(() => {
    if (!connecting) {
      pollStartedAt.current = null;
      return;
    }
    pollStartedAt.current ??= Date.now();
    const startedAt = pollStartedAt.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (cancelled || Date.now() - startedAt > MCP_STATUS_POLL_LIMIT_MS) return;
      timer = setTimeout(() => {
        void refresh().then(schedule);
      }, MCP_STATUS_POLL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connecting, refresh]);

  const reconnect = useCallback(async () => {
    if (!adapter) return;
    setReconnecting(true);
    setError(null);
    const current = ++generation.current;
    try {
      const list = await adapter.reconnect();
      if (current === generation.current) apply(list);
      pollStartedAt.current = null;
    } catch (reconnectError) {
      setError(errorText(reconnectError));
    } finally {
      setReconnecting(false);
    }
  }, [adapter, apply]);

  return { statuses, available: Boolean(adapter), reconnecting, error, reconnect };
}
