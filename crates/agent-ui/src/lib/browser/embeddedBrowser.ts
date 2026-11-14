// Shared contract + pure helpers for the embedded browser pane (Right Dock /
// workbench "Browser" tool). The desktop host implements the client on top of
// its native embedded-browser commands; hosts without one pass no client and
// the tool stays hidden.

import type {
  BrowserImportRequest,
  BrowserImportSource,
  BrowserImportSummary,
} from "./browserCookieImport";

export type EmbeddedBrowserTab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
};

export type EmbeddedBrowserViewport = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};

/** Local CDP endpoint of the pane's browser (for agent attach). */
export type EmbeddedBrowserCdpEndpoint = {
  port: number;
  httpUrl: string;
  websocketUrl: string;
  activeTargetId: string | null;
};

export type EmbeddedBrowserState = {
  running: boolean;
  browserAvailable: boolean;
  activeTabId: string | null;
  tabs: EmbeddedBrowserTab[];
  viewport?: EmbeddedBrowserViewport | null;
  cdp?: EmbeddedBrowserCdpEndpoint | null;
};

export type EmbeddedBrowserFrame = {
  tabId: string;
  /** Base64 JPEG. */
  data: string;
  /** Page viewport size in CSS pixels the frame represents. */
  deviceWidth: number;
  deviceHeight: number;
  timestamp?: number;
};

export type EmbeddedBrowserMouseInput = {
  kind: "move" | "down" | "up" | "wheel";
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right" | "back" | "forward";
  buttons?: number;
  clickCount?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
};

export type EmbeddedBrowserKeyInput = {
  kind: "down" | "up";
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
};

export type EmbeddedBrowserHistoryAction = "back" | "forward" | "reload" | "stop";

export type EmbeddedBrowserPickedElement = {
  pageUrl: string;
  pageTitle: string;
  tagName: string;
  role?: string;
  accessibleName?: string;
  selector: string;
  xpath?: string;
  text?: string;
  nearbyText?: string;
  htmlExcerpt?: string;
  attributes?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  style?: Record<string, string>;
};

export type EmbeddedBrowserScreenshot = {
  /** Base64 PNG of the active tab viewport. */
  data: string;
  url: string;
  title: string;
};

export type EmbeddedBrowserListener = {
  onState?: (state: EmbeddedBrowserState) => void;
  onFrame?: (frame: EmbeddedBrowserFrame) => void;
};

export type EmbeddedBrowserClient = {
  getState: () => Promise<EmbeddedBrowserState>;
  open: (options?: {
    url?: string;
    viewport?: EmbeddedBrowserViewport;
  }) => Promise<EmbeddedBrowserState>;
  navigate: (url: string, tabId?: string) => Promise<EmbeddedBrowserState>;
  history: (action: EmbeddedBrowserHistoryAction, tabId?: string) => Promise<EmbeddedBrowserState>;
  resize: (viewport: EmbeddedBrowserViewport) => Promise<void>;
  newTab: (url?: string) => Promise<EmbeddedBrowserState>;
  closeTab: (tabId: string) => Promise<EmbeddedBrowserState>;
  activateTab: (tabId: string) => Promise<EmbeddedBrowserState>;
  mouse: (input: EmbeddedBrowserMouseInput) => Promise<void>;
  key: (input: EmbeddedBrowserKeyInput) => Promise<void>;
  insertText: (text: string) => Promise<void>;
  screenshot: () => Promise<string>;
  pickElement: () => Promise<EmbeddedBrowserPickedElement | null>;
  cancelPick: () => Promise<void>;
  close: () => Promise<void>;
  subscribe: (listener: EmbeddedBrowserListener) => () => void;
  /** Lists local browser profiles that sign-in state can be imported from. */
  listImportSources?: () => Promise<BrowserImportSource[]>;
  /** Imports cookies from a local profile into this browser (starts it if needed). */
  importCookies?: (request: BrowserImportRequest) => Promise<BrowserImportSummary>;
  /** Closes the browser and deletes its profile (cookies, cache, site data). */
  clearBrowsingData?: () => Promise<void>;
  /**
   * Host bridge into the chat composer. Absent (or returning false) when the
   * composer cannot take the content; the panel then disables the action.
   */
  insertIntoComposer?: (markdown: string) => boolean;
  /** Attaches a PNG to the current composer; resolves false when unsupported. */
  attachScreenshotToComposer?: (screenshot: EmbeddedBrowserScreenshot) => Promise<boolean>;
};

export const EMBEDDED_BROWSER_MAX_TABS = 32;
export const EMBEDDED_BROWSER_SEARCH_URL = "https://www.bing.com/search?q=";
export const EMBEDDED_BROWSER_BLANK_URL = "about:blank";
const PICKED_ELEMENT_MAX_CHARS = 8000;

export const EMPTY_EMBEDDED_BROWSER_STATE: EmbeddedBrowserState = {
  running: false,
  browserAvailable: true,
  activeTabId: null,
  tabs: [],
};

// --- Address bar ---------------------------------------------------------

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

/**
 * Hosts that are clearly a local development server: loopback, private LAN
 * ranges, link-local and the reserved dev TLDs. Used both for the scheme
 * default (http instead of https) and for routing chat links into the pane.
 */
export function isLocalDevelopmentHost(rawHostname: string): boolean {
  const hostname = rawHostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".test")) return true;
  const ipv4 = parseIpv4(hostname);
  if (!ipv4) return false;
  const [a, b] = ipv4;
  return (
    a === 127 ||
    (a === 0 && ipv4.every((octet) => octet === 0)) ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** True for http(s) URLs whose host is a local development server. */
export function isLocalDevelopmentUrl(href: string): boolean {
  try {
    const url = new URL(href.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLocalDevelopmentHost(url.hostname);
  } catch {
    return false;
  }
}

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const HOST_PORT_PATTERN = /^(\[[^\]]+\]|[^\s/:?#]+):(\d{1,5})(?:[/?#]|$)/;

export type BrowserAddressResult =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string }
  | { kind: "rejected"; reason: "empty" | "scheme" | "invalid" };

/**
 * Turns address-bar input into a navigable URL:
 * - explicit http(s) URLs pass through, `about:blank` is allowed;
 * - other schemes (file:, javascript:, chrome:, data: …) are rejected;
 * - scheme-less hosts get `http://` for local dev hosts or explicit non-443
 *   ports, `https://` otherwise;
 * - anything that does not look like a host becomes a web search.
 */
export function normalizeBrowserAddress(input: string): BrowserAddressResult {
  const value = input.trim();
  if (!value) return { kind: "rejected", reason: "empty" };
  if (value.toLowerCase() === EMBEDDED_BROWSER_BLANK_URL) {
    return { kind: "url", url: EMBEDDED_BROWSER_BLANK_URL };
  }

  const hostPort = HOST_PORT_PATTERN.exec(value);
  const scheme = hostPort ? null : SCHEME_PATTERN.exec(value)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== "http" && scheme !== "https") return { kind: "rejected", reason: "scheme" };
    try {
      const url = new URL(value);
      if (!url.hostname) return { kind: "rejected", reason: "invalid" };
      return { kind: "url", url: url.toString() };
    } catch {
      return { kind: "rejected", reason: "invalid" };
    }
  }

  const looksLikeHost =
    !/\s/.test(value) &&
    (Boolean(hostPort) ||
      /^[^/?#]+\.[^/?#.]+/.test(value) ||
      /^localhost(?:[/?#:]|$)/i.test(value) ||
      /^\[[0-9a-f:]+\]/i.test(value));
  if (!looksLikeHost) {
    return { kind: "search", url: `${EMBEDDED_BROWSER_SEARCH_URL}${encodeURIComponent(value)}` };
  }

  try {
    const probe = new URL(`http://${value}`);
    const explicitPort = probe.port !== "" && probe.port !== "443";
    const scheme = isLocalDevelopmentHost(probe.hostname) || explicitPort ? "http" : "https";
    const url = new URL(`${scheme}://${value}`);
    return { kind: "url", url: url.toString() };
  } catch {
    return { kind: "search", url: `${EMBEDDED_BROWSER_SEARCH_URL}${encodeURIComponent(value)}` };
  }
}

/** Address bar text for a tab: blank pages show an empty field. */
export function browserAddressDisplay(url: string): string {
  return !url || url === EMBEDDED_BROWSER_BLANK_URL ? "" : url;
}

export function isBlankBrowserTab(tab: Pick<EmbeddedBrowserTab, "url"> | null | undefined) {
  return !tab?.url || tab.url === EMBEDDED_BROWSER_BLANK_URL;
}

export function browserTabLabel(tab: Pick<EmbeddedBrowserTab, "url" | "title">, fallback: string) {
  const title = tab.title.trim();
  if (isBlankBrowserTab(tab)) return fallback;
  if (title && title !== tab.url) return title;
  try {
    const url = new URL(tab.url);
    return url.host || tab.url;
  } catch {
    return title || tab.url || fallback;
  }
}

// --- Input mapping -------------------------------------------------------

export type FrameRect = { left: number; top: number; width: number; height: number };

/**
 * Maps a pointer position inside the rendered frame element to page CSS
 * pixels. The frame is drawn with `object-fit: contain` anchored top-left, so
 * when the pane and the page viewport disagree (mid-resize) only the scaled
 * image area is interactive; returns null outside it.
 */
export function mapPointerToViewport(
  clientX: number,
  clientY: number,
  rect: FrameRect,
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const drawnWidth = viewport.width * scale;
  const drawnHeight = viewport.height * scale;
  if (localX < 0 || localY < 0 || localX > drawnWidth || localY > drawnHeight) return null;
  return {
    x: Math.min(viewport.width, Math.max(0, localX / scale)),
    y: Math.min(viewport.height, Math.max(0, localY / scale)),
  };
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

export function cdpMouseButton(button: number): EmbeddedBrowserMouseInput["button"] {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}

/**
 * Keys the pane keeps for itself instead of forwarding to the page. Paste is
 * delivered through the `paste` event as plain text, and the host's own
 * window-level shortcuts (new window, quit, settings …) stay with the host.
 */
export function shouldForwardBrowserKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.key === "Process" || event.key === "Dead" || event.key === "Unidentified") return false;
  const primary = event.metaKey || event.ctrlKey;
  if (!primary) return true;
  const key = event.key.toLowerCase();
  if (key === "v") return false;
  return ["a", "c", "x", "z", "y", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key);
}

// --- Picker → composer ----------------------------------------------------

function fencedBlock(language: string, body: string) {
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * Markdown context block for elements picked in the pane. Values are page
 * content (untrusted); they are fenced or inline-coded, never interpreted.
 */
export function formatPickedElementsMarkdown(
  elements: readonly EmbeddedBrowserPickedElement[],
): string {
  if (elements.length === 0) return "";
  const sections = elements.map((element, index) => {
    const lines = [`## Element ${index + 1}`];
    const inline = (value: string) => `\`${value.replace(/`/g, "'")}\``;
    lines.push(`- URL: ${element.pageUrl}`);
    if (element.pageTitle) lines.push(`- Title: ${element.pageTitle}`);
    lines.push(`- Tag: ${inline(element.tagName)}`);
    if (element.role) lines.push(`- Role: ${inline(element.role)}`);
    if (element.accessibleName) lines.push(`- Name: ${element.accessibleName}`);
    if (element.selector) lines.push(`- Selector: ${inline(element.selector)}`);
    if (element.xpath) lines.push(`- XPath: ${inline(element.xpath)}`);
    const attributes = Object.entries(element.attributes ?? {}).filter(
      ([name]) => name !== "id" || !element.selector.startsWith("#"),
    );
    if (attributes.length > 0) {
      lines.push(
        `- Attributes: ${attributes.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(", ")}`,
      );
    }
    if (element.rect) {
      const { x, y, width, height } = element.rect;
      lines.push(`- Rect: x=${x}, y=${y}, ${width}×${height}`);
    }
    if (element.text) lines.push("", "Text:", fencedBlock("text", element.text));
    if (element.htmlExcerpt) lines.push("", "HTML:", fencedBlock("html", element.htmlExcerpt));
    return lines.join("\n");
  });
  let markdown = `# Web page elements\n\n${sections.join("\n\n")}`;
  if (markdown.length > PICKED_ELEMENT_MAX_CHARS) {
    markdown = `${markdown.slice(0, PICKED_ELEMENT_MAX_CHARS)}\n…(truncated)`;
  }
  return `${markdown}\n`;
}

export function embeddedBrowserScreenshotFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `browser-screenshot-${stamp}.png`;
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export type BrowserLoadErrorKind =
  | "certificate"
  | "dns"
  | "refused"
  | "timeout"
  | "offline"
  | "other";

/** Classifies a Chromium `net::ERR_*` navigation error so the pane can explain it. */
export function classifyBrowserLoadError(
  errorText: string | null | undefined,
): BrowserLoadErrorKind {
  const code = (errorText ?? "").toUpperCase();
  if (code.includes("ERR_CERT_") || code.includes("ERR_SSL_") || code.includes("ERR_BAD_SSL")) {
    return "certificate";
  }
  if (code.includes("ERR_NAME_NOT_RESOLVED") || code.includes("ERR_NAME_RESOLUTION_FAILED")) {
    return "dns";
  }
  if (code.includes("ERR_INTERNET_DISCONNECTED") || code.includes("ERR_NETWORK_CHANGED")) {
    return "offline";
  }
  if (code.includes("TIMED_OUT")) return "timeout";
  if (
    code.includes("ERR_CONNECTION_REFUSED") ||
    code.includes("ERR_CONNECTION_RESET") ||
    code.includes("ERR_CONNECTION_CLOSED") ||
    code.includes("ERR_ADDRESS_UNREACHABLE") ||
    code.includes("ERR_EMPTY_RESPONSE")
  ) {
    return "refused";
  }
  return "other";
}
