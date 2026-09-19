import type { McpRegistryCard, McpRegistrySource } from "../../lib/mcpRegistry/index";

type Snapshot = { items: McpRegistryCard[]; nextCursor?: string; updatedAt: number };
const entries = new Map<string, Snapshot>();
const pending = new Map<string, Promise<Snapshot>>();
export const REGISTRY_CACHE_TTL = 5 * 60_000;
export const registryCacheKey = (source: McpRegistrySource, query: string) =>
  JSON.stringify([source, query.trim()]);
export function readRegistryCache(key: string) {
  return entries.get(key);
}
export function loadRegistryCache(
  key: string,
  cursor: string | undefined,
  fetchPage: () => Promise<{ items: McpRegistryCard[]; nextCursor?: string }>,
): Promise<Snapshot> {
  const requestKey = JSON.stringify([key, cursor]);
  const existing = pending.get(requestKey);
  if (existing) return existing;
  const request = fetchPage()
    .then((page) => {
      const previous = cursor ? (entries.get(key)?.items ?? []) : [];
      const byId = new Map(previous.map((item) => [item.id, item]));
      for (const item of page.items) byId.set(item.id, item);
      const snapshot = {
        items: [...byId.values()],
        nextCursor: page.nextCursor === cursor ? undefined : page.nextCursor,
        updatedAt: Date.now(),
      };
      entries.delete(key);
      entries.set(key, snapshot);
      while (entries.size > 24) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return snapshot;
    })
    .finally(() => pending.delete(requestKey));
  pending.set(requestKey, request);
  return request;
}
