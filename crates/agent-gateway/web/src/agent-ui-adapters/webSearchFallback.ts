import {
  type WebSearchFallbackState,
  webSearchFallbackStateFrom,
} from "@liveagent/ui/lib/providers/webSearchFallback";
import { settingsHostAdapter } from "./settingsExtension";

/**
 * WebUI: the web search fallback state the Gateway relays (`kbrainWebSearch`); null when
 * the connected desktop or backend does not report one.
 */
export async function loadWebSearchFallbackState(): Promise<WebSearchFallbackState | null> {
  return webSearchFallbackStateFrom(await settingsHostAdapter.kbrain.getSettings());
}
