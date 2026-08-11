import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ABSOLUTE_RIGHT_DOCK_MAX_PANEL_WIDTH as ABSOLUTE_MAX_PANEL_WIDTH,
  DEFAULT_RIGHT_DOCK_MAX_PANEL_WIDTH as DEFAULT_MAX_PANEL_WIDTH,
  MIN_RIGHT_DOCK_MAIN_CONTENT_WIDTH as MIN_MAIN_CONTENT_WIDTH,
  MIN_RIGHT_DOCK_PANEL_WIDTH as MIN_PANEL_WIDTH,
  PROJECT_TOOLS_RESIZE_END_EVENT,
} from "./rightDockModel";

type UseRightDockPanelWidthOptions = {
  isOpen: boolean;
  collapseImmediately: boolean;
  width: number;
  onWidthChange: (width: number) => void;
};

function getFallbackMaxPanelWidth() {
  if (typeof window === "undefined") return DEFAULT_MAX_PANEL_WIDTH;
  return Math.max(
    DEFAULT_MAX_PANEL_WIDTH,
    Math.min(ABSOLUTE_MAX_PANEL_WIDTH, window.innerWidth - MIN_MAIN_CONTENT_WIDTH),
  );
}

function getDynamicMaxPanelWidth(panel: HTMLElement | null) {
  if (!panel) return getFallbackMaxPanelWidth();
  const parent = panel.parentElement;
  const sibling = panel.previousElementSibling;
  const parentRect = parent?.getBoundingClientRect();
  const siblingRect = sibling instanceof HTMLElement ? sibling.getBoundingClientRect() : null;
  const hostWidth =
    parentRect && siblingRect
      ? parentRect.right - siblingRect.left
      : (parentRect?.width ?? panel.getBoundingClientRect().width);
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) {
    return getFallbackMaxPanelWidth();
  }
  return Math.max(
    MIN_PANEL_WIDTH,
    Math.min(ABSOLUTE_MAX_PANEL_WIDTH, Math.floor(hostWidth - MIN_MAIN_CONTENT_WIDTH)),
  );
}

function clampPanelWidth(width: number, maxWidth: number) {
  return Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, width));
}

function panelWidthStyleValue(width: number) {
  return `${Math.round(width)}px`;
}

function applyPanelWidthStyle(panel: HTMLElement | null, width: number) {
  panel?.style.setProperty("--project-tools-panel-width", panelWidthStyleValue(width));
}

export function useRightDockPanelWidth(options: UseRightDockPanelWidthOptions) {
  const { isOpen, collapseImmediately, width, onWidthChange } = options;
  const [shouldRenderContent, setShouldRenderContent] = useState(isOpen);
  const [widthCollapsed, setWidthCollapsed] = useState(!isOpen);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const [maxPanelWidth, setMaxPanelWidth] = useState(getFallbackMaxPanelWidth);
  const clampedWidth = clampPanelWidth(width, maxPanelWidth);
  const [draftWidth, setDraftWidth] = useState(clampedWidth);
  const pendingResizeWidthRef = useRef(clampedWidth);
  const resizeFrameRef = useRef<number | null>(null);
  const resizingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const panelWidth = clampPanelWidth(draftWidth, maxPanelWidth);
  const panelStyleWidth = resizingRef.current ? pendingResizeWidthRef.current : panelWidth;
  const panelStyle = {
    "--project-tools-panel-width": panelWidthStyleValue(panelStyleWidth),
  } as CSSProperties;
  const effectiveWidthCollapsed = !isOpen && collapseImmediately ? true : widthCollapsed;
  const effectiveShouldRenderContent = !isOpen && collapseImmediately ? false : shouldRenderContent;

  useEffect(() => {
    if (resizingRef.current) return;
    pendingResizeWidthRef.current = clampedWidth;
    applyPanelWidthStyle(panelRef.current, clampedWidth);
    setDraftWidth(clampedWidth);
  }, [clampedWidth]);

  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    let frameId = 0;
    const updateMaxWidth = () => {
      frameId = 0;
      if (resizingRef.current) return;
      setMaxPanelWidth(getDynamicMaxPanelWidth(panel));
    };
    const scheduleUpdate = () => {
      if (frameId !== 0) return;
      frameId = window.requestAnimationFrame(updateMaxWidth);
    };
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    if (panel) {
      resizeObserver?.observe(panel);
      if (panel.previousElementSibling instanceof HTMLElement) {
        resizeObserver?.observe(panel.previousElementSibling);
      }
      if (panel.parentElement) {
        resizeObserver?.observe(panel.parentElement);
      }
    }
    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
    };
  }, [isOpen]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setWidthCollapsed(false);
      setShouldRenderContent(true);
      return;
    }
    if (collapseImmediately) {
      setShouldRenderContent(false);
      setWidthCollapsed(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setShouldRenderContent(false);
      setWidthCollapsed(true);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [collapseImmediately, isOpen]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizeCleanupRef.current?.();
      const startX = event.clientX;
      const dragMaxWidth = getDynamicMaxPanelWidth(panelRef.current);
      const startWidth = clampPanelWidth(panelWidth, dragMaxWidth);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      resizingRef.current = true;
      setMaxPanelWidth(dragMaxWidth);
      setIsResizing(true);
      pendingResizeWidthRef.current = startWidth;
      applyPanelWidthStyle(panelRef.current, startWidth);
      panelRef.current?.setAttribute("data-project-tools-resizing", "true");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const schedulePanelWidth = (nextWidth: number) => {
        pendingResizeWidthRef.current = nextWidth;
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          applyPanelWidthStyle(panelRef.current, pendingResizeWidthRef.current);
        });
      };

      const cleanupResize = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        window.removeEventListener("blur", handleUp);
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        panelRef.current?.removeAttribute("data-project-tools-resizing");
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        resizingRef.current = false;
        resizeCleanupRef.current = null;
      };

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        const nextWidth = clampPanelWidth(startWidth + startX - moveEvent.clientX, dragMaxWidth);
        schedulePanelWidth(nextWidth);
      };

      const handleUp = () => {
        cleanupResize();
        const finalWidth = pendingResizeWidthRef.current;
        applyPanelWidthStyle(panelRef.current, finalWidth);
        setDraftWidth(finalWidth);
        if (finalWidth !== clampedWidth) {
          onWidthChange(finalWidth);
        }
        setIsResizing(false);
        window.dispatchEvent(new Event(PROJECT_TOOLS_RESIZE_END_EVENT));
      };

      resizeCleanupRef.current = cleanupResize;
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      window.addEventListener("blur", handleUp);
    },
    [clampedWidth, onWidthChange, panelWidth],
  );

  return {
    effectiveShouldRenderContent,
    effectiveWidthCollapsed,
    handleResizeStart,
    isResizing,
    panelRef,
    panelStyle,
  };
}
