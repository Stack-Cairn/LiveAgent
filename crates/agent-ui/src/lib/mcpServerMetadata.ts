import type { McpServerConfig } from "@liveagent/app/lib/settings";
import type { McpRegistryCard } from "@liveagent/ui/lib/mcpRegistry";

export function resolveMcpDocsHref(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\s/u.test(character) || codePoint < 32 || codePoint === 127) return null;
  }

  const isHttpUrl = /^https?:\/\//i.test(value);
  const isHostWithPort = /^(?:\[[0-9a-f:.]+\]|[^/?#:\s]+):\d+(?:[/?#]|$)/i.test(value);
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !isHttpUrl && !isHostWithPort) return null;

  const href = isHttpUrl ? value : value.startsWith("//") ? `https:${value}` : `https://${value}`;
  try {
    const url = new URL(href);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    return href;
  } catch {
    return null;
  }
}

export function enrichMcpServerWithRegistryMetadata(
  server: McpServerConfig,
  card: McpRegistryCard,
): McpServerConfig {
  const description = card.description.trim();
  const docsUrl = [card.detailUrl, card.homepageUrl, card.repositoryUrl]
    .map((value) => value?.trim() ?? "")
    .find(Boolean);

  return {
    ...server,
    ...(description ? { description } : {}),
    ...(docsUrl ? { docsUrl } : {}),
  };
}
