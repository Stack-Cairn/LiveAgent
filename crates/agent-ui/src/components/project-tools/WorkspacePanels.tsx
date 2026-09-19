import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePanelRef } from "react-resizable-panels";
import { useIsMobile } from "../../hooks/use-mobile";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";
import {
  ABSOLUTE_RIGHT_DOCK_MAX_PANEL_WIDTH,
  MIN_RIGHT_DOCK_MAIN_CONTENT_WIDTH,
  MIN_RIGHT_DOCK_PANEL_WIDTH,
  PROJECT_TOOLS_RESIZE_END_EVENT,
} from "./rightDockModel";

type PanelsState = {
  open: boolean;
  width: number;
  mobile: boolean;
  resizing: boolean;
  immediate: boolean;
  mainMinimum: number;
  toolsMinimum: number;
  toolsMaximum: number;
  panelRef: ReturnType<typeof usePanelRef>;
  onClose: () => void;
  startResize: () => void;
};
const Context = createContext<PanelsState | null>(null);
function usePanels() {
  const value = useContext(Context);
  if (!value) throw new Error("Workspace panels require WorkspacePanelGroup");
  return value;
}
export function WorkspacePanelGroup({
  open,
  width,
  onClose,
  onWidthChange,
  immediate = false,
  children,
}: {
  open: boolean;
  width: number;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  immediate?: boolean;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const panelRef = usePanelRef();
  const groupElement = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(1000);
  const [resizing, setResizing] = useState(false);
  // Size constraints follow the workspace, not the browser viewport or active panel size.
  useLayoutEffect(() => {
    const element = groupElement.current;
    if (!element) return;
    setAvailableWidth(Math.round(element.getBoundingClientRect().width));
    // Width animations already cause browser layout. Do not also propagate every
    // intermediate pixel through panel constraints and React context.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      clearTimeout(pending);
      pending = setTimeout(() => setAvailableWidth(width), 120);
    });
    observer.observe(element);
    return () => {
      clearTimeout(pending);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!resizing) return;
    const finish = () => setResizing(false);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("blur", finish);
    };
  }, [resizing]);
  const mainMinimum = Math.min(MIN_RIGHT_DOCK_MAIN_CONTENT_WIDTH, availableWidth * 0.55);
  const toolsMinimum = Math.min(MIN_RIGHT_DOCK_PANEL_WIDTH, availableWidth * 0.4);
  const toolsMaximum = Math.min(ABSOLUTE_RIGHT_DOCK_MAX_PANEL_WIDTH, availableWidth - mainMinimum);
  const value = useMemo(
    () => ({
      open,
      width,
      onClose,
      immediate,
      mobile,
      resizing,
      mainMinimum,
      toolsMinimum,
      toolsMaximum,
      panelRef,
      startResize: () => setResizing(true),
    }),
    [
      open,
      width,
      onClose,
      immediate,
      mobile,
      resizing,
      mainMinimum,
      toolsMinimum,
      toolsMaximum,
      panelRef,
    ],
  );
  return (
    <Context.Provider value={value}>
      <ResizablePanelGroup
        data-project-tools-resizing={resizing ? "true" : undefined}
        elementRef={groupElement}
        orientation="horizontal"
        disabled={mobile}
        className={cn(
          "min-w-0 flex-1",
          !resizing &&
            !immediate &&
            !mobile &&
            "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-200 [&>[data-panel]]:ease-out motion-reduce:[&>[data-panel]]:transition-none",
        )}
        resizeTargetMinimumSize={{ fine: 12, coarse: 24 }}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction || mobile || !open) return;
          const percentage = layout["workspace-tools"];
          if (percentage === undefined) return;
          if (percentage === 0) onClose();
          else {
            // This callback precedes the browser layout/transition. Its percentage is
            // authoritative; measuring the panel itself here would save its OLD width.
            const group = groupElement.current;
            const separator = group?.querySelector<HTMLElement>("[data-separator]");
            const usableWidth =
              (group?.getBoundingClientRect().width ?? availableWidth) -
              (separator?.offsetWidth ?? 0);
            const next = Math.round((usableWidth * percentage) / 100);
            if (next > 0 && Math.abs(next - width) > 1) onWidthChange(next);
          }
          groupElement.current?.removeAttribute("data-project-tools-resizing");
          setResizing(false);
          window.dispatchEvent(new Event(PROJECT_TOOLS_RESIZE_END_EVENT));
        }}
      >
        {children}
      </ResizablePanelGroup>
    </Context.Provider>
  );
}
export function WorkspaceMainPanel({ children }: { children: ReactNode }) {
  const { mobile, mainMinimum } = usePanels();
  return (
    <ResizablePanel
      id="workspace-main"
      minSize={mobile ? 0 : mainMinimum}
      className="flex min-h-0 min-w-0"
    >
      {children}
    </ResizablePanel>
  );
}
export function WorkspaceToolsPanel({ children }: { children: ReactNode }) {
  const {
    open,
    width,
    mobile,
    resizing,
    onClose,
    startResize,
    panelRef,
    toolsMinimum,
    toolsMaximum,
  } = usePanels();
  const { t } = useLocale();
  const lastWidth = useRef(width);
  const wasOpen = useRef(false);
  const savedWidth = Math.max(toolsMinimum, Math.min(toolsMaximum, width));
  const initialSize = useRef(open && !mobile ? savedWidth : 0).current;
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (mobile || !open) panel.collapse();
    else if (!wasOpen.current || lastWidth.current !== width || panel.isCollapsed())
      panel.resize(savedWidth);
    wasOpen.current = open && !mobile;
    lastWidth.current = width;
  }, [open, mobile, width, savedWidth, panelRef]);
  return (
    <>
      {/* Keep the desktop separator registered and enabled while collapsed.
          The library caches separator-to-panel associations at registration. */}
      <ResizableHandle
        disabled={mobile}
        aria-label={t("projectTools.resizePanel")}
        aria-hidden={!open || mobile}
        withHandle
        onPointerDown={startResize}
        className={cn((mobile || !open) && "invisible w-0 pointer-events-none")}
      />
      <ResizablePanel
        id="workspace-tools"
        panelRef={panelRef}
        defaultSize={initialSize}
        minSize={toolsMinimum}
        maxSize={toolsMaximum}
        collapsible
        collapsedSize={0}
        className="relative min-h-0 min-w-0"
        aria-hidden={!open || mobile}
        inert={!open || mobile}
      >
        {!mobile ? (
          <div
            className="absolute inset-y-0 right-0 h-full"
            style={{ width: resizing ? "100%" : savedWidth }}
          >
            {children}
          </div>
        ) : null}
      </ResizablePanel>
      {mobile ? (
        <Sheet
          open={open}
          onOpenChange={(next) => {
            if (!next) onClose();
          }}
        >
          <SheetContent
            side="right"
            className="w-full max-w-none p-0"
            showCloseButton={false}
            aria-describedby={undefined}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t("projectTools.title")}</SheetTitle>
            </SheetHeader>
            {children}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
