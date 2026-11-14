import { isLocalDevelopmentUrl } from "./embeddedBrowser";

/**
 * Routes chat links to local development servers into the embedded browser
 * pane. Only a host with a pane registers a handler (desktop); everywhere else
 * `tryOpenInAppBrowser` returns false and callers fall back to their normal
 * external-link flow.
 */
export type InAppBrowserLinkHandler = (url: string) => boolean;

let activeHandler: InAppBrowserLinkHandler | null = null;

export function setInAppBrowserLinkHandler(handler: InAppBrowserLinkHandler | null): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

export function hasInAppBrowserLinkHandler(): boolean {
  return activeHandler !== null;
}

/** Opens `href` in the pane when it targets a local dev server; true if handled. */
export function tryOpenInAppBrowser(href: string): boolean {
  if (!activeHandler || !isLocalDevelopmentUrl(href)) return false;
  try {
    return activeHandler(href.trim());
  } catch (error) {
    console.error("in-app browser link handler failed", error);
    return false;
  }
}
