import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import type {
  BrowserImportSource,
  BrowserImportSummary,
} from "@liveagent/ui/lib/browser/browserCookieImport";
import type {
  EmbeddedBrowserClient,
  EmbeddedBrowserFrame,
  EmbeddedBrowserListener,
  EmbeddedBrowserPickedElement,
  EmbeddedBrowserState,
} from "@liveagent/ui/lib/browser/embeddedBrowser";

export const EMBEDDED_BROWSER_FRAME_EVENT = "embedded-browser://frame";
export const EMBEDDED_BROWSER_STATE_EVENT = "embedded-browser://state";

type ComposerBridge = Pick<
  EmbeddedBrowserClient,
  "insertIntoComposer" | "attachScreenshotToComposer"
>;

/**
 * Desktop client for the embedded browser pane: commands go to the
 * `embedded_browser_*` Tauri handlers and the two host events fan out to every
 * subscribed panel through one shared listener pair.
 */
export function createTauriEmbeddedBrowserClient(
  composer: ComposerBridge = {},
): EmbeddedBrowserClient {
  const listeners = new Set<EmbeddedBrowserListener>();
  let unlisten: Promise<Array<() => void>> | null = null;

  const ensureListening = () => {
    if (unlisten) return;
    unlisten = Promise.all([
      listen<EmbeddedBrowserState>(EMBEDDED_BROWSER_STATE_EVENT, (event) => {
        for (const listener of [...listeners]) listener.onState?.(event.payload);
      }),
      listen<EmbeddedBrowserFrame>(EMBEDDED_BROWSER_FRAME_EVENT, (event) => {
        for (const listener of [...listeners]) listener.onFrame?.(event.payload);
      }),
    ]);
  };

  const stopListening = () => {
    const pending = unlisten;
    unlisten = null;
    void pending
      ?.then((handles) => {
        for (const handle of handles) handle();
      })
      .catch(() => {});
  };

  return {
    getState: () => invoke<EmbeddedBrowserState>("embedded_browser_status"),
    open: (options) =>
      invoke<EmbeddedBrowserState>("embedded_browser_open", {
        url: options?.url ?? null,
        viewport: options?.viewport ?? null,
      }),
    navigate: (url, tabId) =>
      invoke<EmbeddedBrowserState>("embedded_browser_navigate", { url, tabId: tabId ?? null }),
    history: (action, tabId) =>
      invoke<EmbeddedBrowserState>("embedded_browser_history", { action, tabId: tabId ?? null }),
    resize: (viewport) => invoke<void>("embedded_browser_resize", { viewport }),
    newTab: (url) => invoke<EmbeddedBrowserState>("embedded_browser_new_tab", { url: url ?? null }),
    closeTab: (tabId) => invoke<EmbeddedBrowserState>("embedded_browser_close_tab", { tabId }),
    activateTab: (tabId) =>
      invoke<EmbeddedBrowserState>("embedded_browser_activate_tab", { tabId }),
    mouse: (input) => invoke<void>("embedded_browser_mouse", { input }),
    key: (input) => invoke<void>("embedded_browser_key", { input }),
    insertText: (text) => invoke<void>("embedded_browser_insert_text", { text }),
    screenshot: () => invoke<string>("embedded_browser_screenshot"),
    pickElement: () => invoke<EmbeddedBrowserPickedElement | null>("embedded_browser_pick_element"),
    cancelPick: () => invoke<void>("embedded_browser_cancel_pick"),
    close: () => invoke<void>("embedded_browser_close"),
    listImportSources: () => invoke<BrowserImportSource[]>("embedded_browser_import_sources"),
    importCookies: ({ browser, profileDir, domains }) =>
      invoke<BrowserImportSummary>("embedded_browser_import_cookies", {
        browser,
        profileDir,
        domains: domains?.length ? domains : null,
      }),
    clearBrowsingData: () => invoke<void>("embedded_browser_clear_data"),
    subscribe: (listener) => {
      listeners.add(listener);
      ensureListening();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopListening();
      };
    },
    insertIntoComposer: composer.insertIntoComposer,
    attachScreenshotToComposer: composer.attachScreenshotToComposer,
  };
}
