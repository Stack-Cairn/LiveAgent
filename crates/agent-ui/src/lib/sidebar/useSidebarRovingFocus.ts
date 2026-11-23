import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

// Conversation, project and group rows of the history sidebar. Each row keeps a
// primary button (the title) plus inline actions (pin, new chat, more).
const ROW_SELECTOR = ".chat-history-row, [data-sidebar-reorder-key]";
const PRIMARY_SELECTOR = '[data-sidebar="menu-button"]';
const FOCUSABLE_SELECTOR = "button, a[href], [tabindex]";
const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';

const SIDEBAR_ROW_KEY_SHORTCUTS = "ArrowUp ArrowDown Home End ArrowRight Shift+F10";

function isRendered(element: HTMLElement) {
  return element.getClientRects().length > 0;
}

function rowOf(element: Element, root: HTMLElement): HTMLElement | null {
  const row = element.closest<HTMLElement>(ROW_SELECTOR);
  return row && root.contains(row) ? row : null;
}

function primaryOf(row: HTMLElement): HTMLElement | undefined {
  return Array.from(row.querySelectorAll<HTMLElement>(PRIMARY_SELECTOR)).find(
    (element) => element.closest(ROW_SELECTOR) === row,
  );
}

/** Rendered row titles in document order: the roving list. */
function sidebarRovingItems(root: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const primary = primaryOf(row);
    if (primary && isRendered(primary) && !items.includes(primary)) items.push(primary);
  }
  return items;
}

/** Inline row actions reached with ArrowRight (never Tab stops of their own). */
function sidebarRowActions(row: HTMLElement): HTMLElement[] {
  const primary = primaryOf(row);
  return Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element !== primary &&
      element.closest(ROW_SELECTOR) === row &&
      !element.matches(TEXT_ENTRY_SELECTOR) &&
      element.getAttribute("aria-hidden") !== "true" &&
      !(element as HTMLButtonElement).disabled,
  );
}

function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * Makes the sidebar's rows a single Tab stop with roving focus: Up/Down/Home/End
 * move between rows, Enter opens (native button), Right/Left walk the row's
 * actions, Escape returns to the row and Shift+F10 / the context-menu key opens
 * the row's menu. Works on the DOM so virtualized and memoized rows need no
 * per-row wiring. Spread the result on the element that contains the rows; the
 * key handler is a React prop so row-level handlers run (and can claim the key)
 * first.
 */
export function useSidebarRovingFocus(keyboardHint: string) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const keyDownRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const hintRef = useRef(keyboardHint);
  hintRef.current = keyboardHint;

  useEffect(() => () => cleanupRef.current?.(), []);

  const ref = useCallback((root: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!root) return;

    let current: HTMLElement | null = null;
    let frame = 0;

    const sync = () => {
      frame = 0;
      const items = sidebarRovingItems(root);
      const focusedRow = rowOf(document.activeElement ?? root, root);
      const focused = focusedRow ? primaryOf(focusedRow) : undefined;
      if (focused && items.includes(focused)) current = focused;
      if (!current || !items.includes(current)) {
        current =
          items.find((item) => item.getAttribute("aria-current") === "page") ?? items[0] ?? null;
      }
      for (const item of items) {
        const tabIndex = item === current ? "0" : "-1";
        if (item.getAttribute("tabindex") !== tabIndex) item.setAttribute("tabindex", tabIndex);
        if (item.getAttribute("aria-keyshortcuts") !== SIDEBAR_ROW_KEY_SHORTCUTS) {
          item.setAttribute("aria-keyshortcuts", SIDEBAR_ROW_KEY_SHORTCUTS);
        }
        if (item.getAttribute("aria-description") !== hintRef.current) {
          item.setAttribute("aria-description", hintRef.current);
        }
        const row = rowOf(item, root);
        for (const action of row ? sidebarRowActions(row) : []) {
          if (action.getAttribute("tabindex") !== "-1") action.setAttribute("tabindex", "-1");
        }
      }
    };
    const scheduleSync = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };

    const focusItem = (item: HTMLElement | undefined) => {
      if (!item) return false;
      current = item;
      sync();
      item.focus();
      item.scrollIntoView?.({ block: "nearest" });
      return true;
    };

    const moveBy = (from: HTMLElement, delta: 1 | -1, retries = 2) => {
      const items = sidebarRovingItems(root);
      if (focusItem(items[items.indexOf(from) + delta])) return;
      // Virtualized lists render rows lazily: nudge the scroller and look again.
      const scroller = retries > 0 ? scrollParentOf(from) : null;
      if (!scroller) return;
      scroller.scrollBy({ top: delta * from.offsetHeight });
      requestAnimationFrame(() => moveBy(from, delta, retries - 1));
    };

    keyDownRef.current = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
      if (target.matches(TEXT_ENTRY_SELECTOR)) return false;
      const row = rowOf(target, root);
      const primary = row ? primaryOf(row) : undefined;
      if (!row || !primary) return false;
      const actions = sidebarRowActions(row);
      const onPrimary = target === primary;
      const menuKey = event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
      if (event.shiftKey && !menuKey) return false;
      let handled = true;
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp":
          moveBy(primary, event.key === "ArrowDown" ? 1 : -1);
          break;
        case "Home":
        case "End": {
          const items = sidebarRovingItems(root);
          focusItem(event.key === "Home" ? items[0] : items.at(-1));
          break;
        }
        case "ArrowRight":
          (onPrimary ? actions[0] : actions[actions.indexOf(target) + 1])?.focus();
          break;
        case "ArrowLeft":
          if (onPrimary) handled = false;
          else (actions[actions.indexOf(target) - 1] ?? primary).focus();
          break;
        case "Escape":
          if (onPrimary) handled = false;
          else primary.focus();
          break;
        default: {
          // Rows without an inline menu button (touch layout) keep the native
          // contextmenu event, which opens the same menu.
          const menu = menuKey
            ? actions.find((action) => action.getAttribute("aria-haspopup") === "menu")
            : undefined;
          if (menu) menu.click();
          else handled = false;
        }
      }
      return handled;
    };

    const onFocusIn = (event: FocusEvent) => {
      const row = rowOf(event.target as HTMLElement, root);
      const primary = row ? primaryOf(row) : undefined;
      if (primary && primary !== current) {
        current = primary;
        sync();
      }
    };

    const observer = new MutationObserver(scheduleSync);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("focusin", onFocusIn);
    sync();
    cleanupRef.current = () => {
      observer.disconnect();
      keyDownRef.current = () => false;
      root.removeEventListener("focusin", onFocusIn);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (keyDownRef.current(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  return useMemo(() => ({ ref, onKeyDown }), [ref, onKeyDown]);
}
