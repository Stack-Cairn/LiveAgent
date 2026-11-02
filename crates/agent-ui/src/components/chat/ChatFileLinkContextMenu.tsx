import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { AppWindow, Copy, FileText, FolderOpen, Globe } from "@liveagent/ui/components/IconSet";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPopup,
  ContextMenuSeparator,
} from "@liveagent/ui/components/ui/context-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  closeChatFileLinkMenu,
  getChatFileLinkMenuSnapshot,
  openFromChatFileLinkMenu,
  registerChatFileLinkMenuHost,
  subscribeChatFileLinkMenu,
} from "@liveagent/ui/lib/chat/chatFileLinkContextMenuStore";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { useEffect, useState, useSyncExternalStore } from "react";

const WEB_PAGE_PATTERN = /\.(?:html?|xhtml|svg)$/i;

type ChatFileLinkContextMenuHostProps = {
  /** Desktop only: launching the host's default app means nothing to a
   * WebUI viewer on another device. */
  canOpenWithDefaultApp?: boolean;
};

/** Renders the menu opened by `showChatFileLinkContextMenu` or
 * `showChatUrlContextMenu`; mount one per transcript. */
export function ChatFileLinkContextMenuHost({
  canOpenWithDefaultApp = false,
}: ChatFileLinkContextMenuHostProps) {
  const { t } = useLocale();
  const [hostId] = useState(() => Symbol("chat-file-link-menu-host"));
  const { menu: state, primaryHost } = useSyncExternalStore(
    subscribeChatFileLinkMenu,
    getChatFileLinkMenuSnapshot,
    getChatFileLinkMenuSnapshot,
  );
  useEffect(() => registerChatFileLinkMenuHost(hostId), [hostId]);
  if (!state || primaryHost !== hostId || typeof document === "undefined") return null;
  return (
    // The portal still bubbles React events through the primary host's pane;
    // keep a press here from focusing that pane instead of the link's own.
    <ContextMenuPopup
      point={state}
      onClose={closeChatFileLinkMenu}
      className="min-w-38"
      data-workbench-preserve-focus=""
    >
      {state.kind === "file" ? (
        <>
          <ContextMenuItem onClick={() => openFromChatFileLinkMenu(state, "open")}>
            <FileText className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{t("chat.fileLink.open")}</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => openFromChatFileLinkMenu(state, "reveal")}>
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{t("chat.fileLink.openContainingDirectory")}</span>
          </ContextMenuItem>
          {canOpenWithDefaultApp ? (
            <ContextMenuItem onClick={() => openFromChatFileLinkMenu(state, "default-app")}>
              {WEB_PAGE_PATTERN.test(state.link.path) ? (
                <>
                  <Globe className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{t("chat.fileLink.openInBrowser")}</span>
                </>
              ) : (
                <>
                  <AppWindow className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{t("chat.fileLink.openWithDefaultApp")}</span>
                </>
              )}
            </ContextMenuItem>
          ) : null}
        </>
      ) : (
        <>
          {/* The link text may differ from its target; the left click shows
              the URL in a confirmation, so the menu shows it up front. */}
          <ContextMenuLabel
            data-chat-url-menu-target=""
            className="max-w-80 font-mono text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]"
          >
            {state.url}
          </ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              closeChatFileLinkMenu();
              void openUrl(state.url).catch((error: unknown) => {
                console.error("Failed to open link in the default browser", error);
              });
            }}
          >
            <Globe className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{t("chat.fileLink.openInBrowser")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              closeChatFileLinkMenu();
              void copyTextToClipboard(state.url);
            }}
          >
            <Copy className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{t("chat.fileLink.copyLink")}</span>
          </ContextMenuItem>
        </>
      )}
    </ContextMenuPopup>
  );
}
