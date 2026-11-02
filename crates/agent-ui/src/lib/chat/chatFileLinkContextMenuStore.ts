import type { ChatFileLink } from "./chatFileLinks";

type MenuPoint = { x: number; y: number };

export type ChatFileLinkMenuState =
  | (MenuPoint & {
      kind: "file";
      link: ChatFileLink;
      /** The right-clicked link; menu items click it again so they run its
       * current handler, not the one rendered when the menu opened. */
      target: { isConnected: boolean; click(): void };
    })
  | (MenuPoint & { kind: "url"; url: string });

export type ChatFileLinkMenuIntent = "open" | "reveal" | "default-app";

export type ChatFileLinkMenuSnapshot = {
  menu: ChatFileLinkMenuState | null;
  primaryHost: symbol | undefined;
};

type ContextMenuEvent = {
  clientX: number;
  clientY: number;
  currentTarget?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
};

// Workbench panes each mount a transcript; only the first mounted host renders.
const hosts: symbol[] = [];
let snapshot: ChatFileLinkMenuSnapshot = { menu: null, primaryHost: undefined };
let pendingIntent: ChatFileLinkMenuIntent = "open";
const listeners = new Set<() => void>();

function publish(menu: ChatFileLinkMenuState | null) {
  snapshot = { menu, primaryHost: hosts[0] };
  for (const listener of listeners) listener();
}

function openMenu(event: ContextMenuEvent, menu: ChatFileLinkMenuState) {
  event.preventDefault();
  event.stopPropagation();
  publish(menu);
}

export function subscribeChatFileLinkMenu(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getChatFileLinkMenuSnapshot = () => snapshot;

export function registerChatFileLinkMenuHost(hostId: symbol) {
  hosts.push(hostId);
  publish(snapshot.menu);
  return () => {
    const index = hosts.indexOf(hostId);
    if (index >= 0) hosts.splice(index, 1);
    publish(hosts.length === 0 ? null : snapshot.menu);
  };
}

export function closeChatFileLinkMenu() {
  publish(null);
}

/** Link click handlers pass their link through this so a menu item can turn
 * the click into "reveal in the file manager" or "open with the default app". */
export function withChatFileLinkMenuIntent(link: ChatFileLink): ChatFileLink {
  const intent = pendingIntent;
  pendingIntent = "open";
  if (intent === "reveal") return { ...link, openInFileManager: true };
  if (intent === "default-app") return { ...link, openWithDefaultApp: true };
  return link;
}

/** Runs a menu item against the link's current handler: the pane that owns
 * the link may switch conversations between the right-click and the choice.
 * A link that left the DOM meanwhile is not opened with a stale handler. */
export function openFromChatFileLinkMenu(
  menu: Extract<ChatFileLinkMenuState, { kind: "file" }>,
  intent: ChatFileLinkMenuIntent,
) {
  closeChatFileLinkMenu();
  if (!menu.target.isConnected) return;
  pendingIntent = intent;
  try {
    menu.target.click();
  } finally {
    pendingIntent = "open";
  }
}

/** Right-click on a chat file link. Without a mounted host the browser menu stays. */
export function showChatFileLinkContextMenu(event: ContextMenuEvent, link: ChatFileLink) {
  const target = event.currentTarget as { isConnected?: unknown; click?: unknown } | undefined;
  if (hosts.length === 0 || !target || typeof target.click !== "function") return;
  openMenu(event, {
    kind: "file",
    x: event.clientX,
    y: event.clientY,
    link,
    target: target as { isConnected: boolean; click(): void },
  });
}

/** Right-click on a web link in a chat message. */
export function showChatUrlContextMenu(event: ContextMenuEvent, url: string) {
  if (hosts.length === 0) return;
  openMenu(event, { kind: "url", x: event.clientX, y: event.clientY, url });
}
