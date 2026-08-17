import type { RightDockTabKind } from "@liveagent/app/lib/settings";
import { Check, Columns2, Cpu, Terminal, X } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { cn } from "../../lib/shared/utils";
import type { TerminalSession } from "../../lib/terminal/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";
import { formatTerminalSessionTitle, type RightDockVisibleTab } from "./rightDockModel";
import { getRightDockToolDefinition, type RightDockSingletonTabKind } from "./rightDockRegistry";
import type { RightDockTabDragProps } from "./useRightDockTabReorder";

const NO_LEASED_SESSIONS: ReadonlySet<string> = new Set();

type RightDockTabStripProps = {
  tabs: RightDockVisibleTab[];
  currentActiveTab: RightDockTabKind;
  backgroundTasksRunning: number;
  // Hide-only: clears the tab's session-local visibility and never touches
  // the processes themselves.
  onCloseBackgroundTasks: () => void;
  activeSession: TerminalSession | null;
  pendingCloseSessionId: string;
  closingSessionIds: ReadonlySet<string>;
  /** 被工作台 Pane 租用的会话:tab 保留但标记,视口由上层换成占位。 */
  leasedSessionIds?: ReadonlySet<string>;
  draggingTabId: string;
  renderTabDragHandle: (tabId: string, label: string) => ReactNode;
  getTabDragProps: (tabId: string) => RightDockTabDragProps;
  getTabDragStyle: (tabId: string) => CSSProperties | undefined;
  consumeSuppressedTabClick: (tabId: string) => boolean;
  onActivateTab: (tabId: string) => void;
  onActivateTerminalSession: (session: TerminalSession) => void;
  onCloseToolTab: (kind: RightDockSingletonTabKind) => void;
  onCloseTerminalRequest: (session: TerminalSession) => void;
  /**
   * Provided when terminal tabs can be dragged out of the dock (workbench
   * hosts). The tab body then arms the drag-out gesture instead of tab
   * reorder; reorder stays available from the grip handle. Click activation
   * is unaffected — the drag session suppresses the click only after its
   * movement threshold.
   */
  onTerminalTabDragStart?: (
    session: TerminalSession,
    event: { pointerId: number; clientX: number; clientY: number },
  ) => void;
  /**
   * Keyboard/pointer alternative to dragging a terminal tab out: docks the
   * session beside the focused workbench pane. Enables the tab context menu.
   */
  onOpenTerminalInWorkbench?: (session: TerminalSession) => void;
  /** Focuses the pane already holding a leased session (menu + placeholder). */
  onFocusWorkbenchPane?: (sessionId: string) => void;
};

// One descriptor per tab regardless of kind, so every tab shares a single
// renderer: identical geometry, drag surface, and close-button behaviour.
type DockTabDescriptor = {
  id: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  // undefined: no status dot; true: running (emerald); false: idle (muted).
  running?: boolean;
  isPendingClose?: boolean;
  closeLabel: string;
  closeTitle: string;
  closeIcon?: ReactNode;
  closeDisabled?: boolean;
  /** Leased to a workbench pane: the tab dims and its viewport is a placeholder. */
  isLeased?: boolean;
  /** Context-menu entries; omitted when the host wires no workbench actions. */
  menuItems?: ReactNode;
  /** Overrides the default reorder pointer-down on the tab body (drag-out). */
  dragProps?: RightDockTabDragProps;
  onActivate: () => void;
  onClose: () => void;
};

// NOTE: `transform` is deliberately absent from the transition list — drag
// positioning drives `transform` via inline styles with its own transitions.
const TAB_BASE_CLASS =
  "project-tools-panel-tab group relative flex h-8 max-w-[12rem] shrink-0 select-none items-center gap-1 rounded-md border border-transparent px-1.5 text-xs text-muted-foreground transition-[background-color,border-color,color,opacity,box-shadow] hover:bg-muted/80 hover:text-foreground";

const CLOSE_BUTTON_CLASS =
  "relative z-10 ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export function RightDockTabStrip(props: RightDockTabStripProps) {
  const {
    tabs,
    currentActiveTab,
    backgroundTasksRunning,
    onCloseBackgroundTasks,
    activeSession,
    pendingCloseSessionId,
    closingSessionIds,
    draggingTabId,
    renderTabDragHandle,
    getTabDragProps,
    getTabDragStyle,
    consumeSuppressedTabClick,
    onActivateTab,
    onActivateTerminalSession,
    onCloseToolTab,
    onCloseTerminalRequest,
    onTerminalTabDragStart,
    onOpenTerminalInWorkbench,
    onFocusWorkbenchPane,
    leasedSessionIds = NO_LEASED_SESSIONS,
  } = props;
  const { t } = useLocale();
  // One open menu at a time, keyed by tab id — the strip is a single row, so a
  // per-tab open flag would only add bookkeeping.
  const [menuTabId, setMenuTabId] = useState("");

  const renderDockTab = (tab: DockTabDescriptor) => {
    const tabBody = (
      <div
        key={tab.id}
        data-project-tools-tab-id={tab.id}
        data-project-tools-tab-leased={tab.isLeased ? "true" : undefined}
        className={cn(
          TAB_BASE_CLASS,
          tab.isActive && "border-border bg-muted text-foreground shadow-sm",
          tab.isLeased && "opacity-60",
          tab.isPendingClose && "bg-destructive/10 text-destructive hover:bg-destructive/15",
          draggingTabId === tab.id &&
            "z-10 scale-[0.98] cursor-grabbing opacity-80 shadow-md ring-1 ring-ring",
        )}
        title={tab.label}
        style={getTabDragStyle(tab.id)}
        {...(tab.dragProps ?? getTabDragProps(tab.id))}
      >
        <button
          type="button"
          aria-label={tab.label}
          aria-haspopup={tab.menuItems ? "menu" : undefined}
          className="absolute inset-0 z-0 rounded-md bg-transparent p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            if (consumeSuppressedTabClick(tab.id)) return;
            tab.onActivate();
          }}
          onContextMenu={
            tab.menuItems
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuTabId(tab.id);
                }
              : undefined
          }
          onKeyDown={
            tab.menuItems
              ? (event) => {
                  // Keyboard equivalent of right-click: the workbench actions
                  // must not be drag-only.
                  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) {
                    return;
                  }
                  event.preventDefault();
                  setMenuTabId(tab.id);
                }
              : undefined
          }
        />
        {renderTabDragHandle(tab.id, tab.label)}
        <div
          aria-hidden="true"
          className="pointer-events-none relative z-10 flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-inherit"
        >
          {tab.icon}
          <span className="min-w-0 truncate">{tab.label}</span>
          {tab.isLeased ? <Columns2 className="h-3 w-3 shrink-0 text-muted-foreground/70" /> : null}
          {tab.running !== undefined ? (
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                tab.running ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
          ) : null}
        </div>
        <button
          type="button"
          data-project-tools-tab-action="close"
          aria-label={tab.closeLabel}
          title={tab.closeTitle}
          disabled={tab.closeDisabled}
          className={cn(
            CLOSE_BUTTON_CLASS,
            tab.isPendingClose
              ? "bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground md:opacity-100"
              : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            consumeSuppressedTabClick(tab.id);
            tab.onClose();
          }}
        >
          {tab.closeIcon ?? <X className="h-3 w-3" />}
        </button>
      </div>
    );

    if (!tab.menuItems) return tabBody;
    return (
      <DropdownMenu
        key={tab.id}
        open={menuTabId === tab.id}
        onOpenChange={(open) => setMenuTabId(open ? tab.id : "")}
        modal={false}
      >
        {/* biome-ignore lint/complexity/noUselessFragments: DropdownMenu keeps trigger and popup siblings under one provider child */}
        <>
          {tabBody}
          <DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
            {tab.menuItems}
          </DropdownMenuContent>
        </>
      </DropdownMenu>
    );
  };

  return (
    <>
      {tabs.map((tab) => {
        if (tab.kind === "backgroundTasks") {
          // Derived tab; closing only hides it (a newly started task or the
          // create menu brings it back).
          const label = t("projectTools.backgroundTasksTitle");
          const closeLabel = t("projectTools.bgTaskClosePanel");
          return renderDockTab({
            id: tab.id,
            label,
            icon: <Cpu className="h-3.5 w-3.5 shrink-0" />,
            isActive: currentActiveTab === "backgroundTasks",
            running: backgroundTasksRunning > 0,
            closeLabel,
            closeTitle: closeLabel,
            onActivate: () => onActivateTab(tab.id),
            onClose: onCloseBackgroundTasks,
          });
        }
        if (tab.kind !== "terminal") {
          const definition = getRightDockToolDefinition(tab.kind);
          if (!definition) return null;
          const closeLabel = t(definition.closeKey);
          return renderDockTab({
            id: tab.id,
            label: t(definition.titleKey),
            icon: definition.icon("h-3.5 w-3.5 shrink-0"),
            isActive: currentActiveTab === tab.kind,
            closeLabel,
            closeTitle: closeLabel,
            onActivate: () => onActivateTab(tab.id),
            onClose: () => onCloseToolTab(tab.kind),
          });
        }

        const session = tab.session;
        const isPendingClose = pendingCloseSessionId === session.id;
        const isLeased = leasedSessionIds.has(session.id);
        const sessionTitle = formatTerminalSessionTitle(
          session.title,
          t("projectTools.terminalTitle"),
        );
        // A leased session already lives in a pane, so its only workbench
        // action is "take me there"; docking it again would fight the lease.
        const menuItems =
          isLeased && onFocusWorkbenchPane ? (
            <DropdownMenuItem
              onSelect={() => onFocusWorkbenchPane(session.id)}
              className="gap-2 text-xs"
            >
              <Columns2 className="h-3.5 w-3.5" />
              {t("workbench.focusPane")}
            </DropdownMenuItem>
          ) : !isLeased && onOpenTerminalInWorkbench ? (
            <DropdownMenuItem
              onSelect={() => onOpenTerminalInWorkbench(session)}
              className="gap-2 text-xs"
            >
              <Columns2 className="h-3.5 w-3.5" />
              {t("workbench.openInSplit")}
            </DropdownMenuItem>
          ) : null;
        return renderDockTab({
          id: session.id,
          label: sessionTitle,
          icon: <Terminal className="h-3.5 w-3.5 shrink-0" />,
          isActive: currentActiveTab === "terminal" && activeSession?.id === session.id,
          running: session.running,
          isPendingClose,
          isLeased,
          menuItems,
          closeLabel: `${isPendingClose ? t("projectTools.confirmClose") : t("projectTools.close")} ${sessionTitle}`,
          closeTitle: isPendingClose
            ? t("projectTools.confirmCloseTerminal")
            : t("projectTools.closeTerminal"),
          closeIcon: isPendingClose ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />,
          closeDisabled: closingSessionIds.has(session.id),
          dragProps: onTerminalTabDragStart
            ? {
                onPointerDown: (event) => {
                  // Touch keeps panning the strip (same rule as tab reorder).
                  if (event.button !== 0 || event.pointerType === "touch") return;
                  onTerminalTabDragStart(session, {
                    pointerId: event.pointerId,
                    clientX: event.clientX,
                    clientY: event.clientY,
                  });
                },
              }
            : undefined,
          onActivate: () => onActivateTerminalSession(session),
          onClose: () => onCloseTerminalRequest(session),
        });
      })}
    </>
  );
}
