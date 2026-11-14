import {
  type WebSearchFallbackState,
  webSearchFallbackStateFrom,
} from "@liveagent/ui/lib/providers/webSearchFallback";
import { kbrainSettingsAdapter } from "./kbrainSettings";

/**
 * Desktop: the web search fallback state straight from the local K-brain; null when the
 * backend has no fallback (no `webSearch` section, capability web_search_fallback).
 */
export async function loadWebSearchFallbackState(): Promise<WebSearchFallbackState | null> {
  return webSearchFallbackStateFrom(await kbrainSettingsAdapter.getSettings());
}
