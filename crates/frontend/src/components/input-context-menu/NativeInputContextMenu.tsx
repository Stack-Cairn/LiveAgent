import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import { useMenuExitPresence } from "../../lib/shared/menuMotion";
import { cn } from "../../lib/shared/utils";
import { readClipboardText } from "../../lib/system/clipboardText";
import { ClipboardPaste, Copy, ScanText, Scissors } from "../icons";
import {
  clampMenuPosition,
  computeMenuItems,
  type InputMenuSnapshot,
  isMenuEligibleTarget,
  resolveOpenSelection,
} from "./model";

type MenuTarget = HTMLInputElement | HTMLTextAreaElement;

// Resolves a contextmenu/mousedown target to an input the shared menu owns.
function resolveMenuTarget(target: EventTarget | null): MenuTarget | null {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return null;
  if (!isMenuEligibleTarget(target)) return null;
  // Monaco/xterm host hidden textareas of their own.
  if (target.closest(".monaco-editor, .xterm")) return null;
  return target;
}

const MENU_ITEM_CLASS = cn(
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
  "disabled:pointer-events-none disabled:opacity-45",
);

function writeTextToClipboard(text: string) {
  if (!text) return;

  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      fallbackWriteTextToClipboard(text);
    });
    return;
  }

  fallbackWriteTextToClipboard(text);
}

function fallbackWriteTextToClipboard(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

// Writes through the prototype value setter so React's per-node value tracker
// sees the change and the dispatched input event reaches onChange handlers.
function setNativeValue(el: MenuTarget, value: string, caret: number) {
  const proto =
    el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // Selection API unsupported for this input type.
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Shared right-click menu (cut/copy/paste/select-all) for plain native
 * inputs and textareas. Wired once at the AppChrome root: surfaces that own a
 * custom context menu keep it (stopPropagation / preventDefault upstream),
 * everything else keeps the historical suppressed-menu behavior.
 */
export function useNativeInputContextMenu(): {
  onRootContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onRootMouseDownCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  menu: ReactNode;
} {
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<InputMenuSnapshot | null>(null);
  const targetRef = useRef<MenuTarget | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Selection captured on right-mousedown, before WebKit's context-menu
  // preparation mutates it (see onRootMouseDownCapture).
  const preClickRef = useRef<{
    target: MenuTarget;
    wasFocused: boolean;
    start: number | null;
    end: number | null;
    at: number;
  } | null>(null);

  const closeMenu = useCallback(() => {
    targetRef.current = null;
    setSnapshot(null);
  }, []);

  // Right-mousedown must not disturb the caret/selection before the menu
  // opens — Chromium moves the caret on the default action (cancellable),
  // while macOS WebKit selects the word/token under the pointer during
  // context-menu preparation, AFTER mousedown and regardless of
  // preventDefault. So: cancel what we can, and snapshot the true selection
  // here so the contextmenu handler can restore it over whatever the engine
  // selected in between. Capture phase so inner stopPropagation cannot skip
  // it.
  const onRootMouseDownCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 2) return;
    if (event.defaultPrevented) return;
    const target = resolveMenuTarget(event.target);
    if (!target) return;
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = target.selectionStart;
      end = target.selectionEnd;
    } catch {
      // Selection API unsupported; treated as no selection downstream.
    }
    preClickRef.current = {
      target,
      wasFocused: document.activeElement === target,
      start,
      end,
      at: Date.now(),
    };
    event.preventDefault();
  }, []);

  const onRootContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      // A surface that already owns a custom menu may preventDefault without
      // stopPropagation (e.g. the composer) — leave it alone.
      if (event.defaultPrevented) return;
      event.preventDefault();

      const target = resolveMenuTarget(event.target);
      if (!target) {
        closeMenu();
        return;
      }

      // Prefer the pre-mousedown snapshot: by now the engine may have
      // word-selected under the pointer (macOS WebKit). Fall back to the
      // live state for keyboard-invoked menus.
      const preClick = preClickRef.current;
      preClickRef.current = null;
      const fresh =
        preClick !== null && preClick.target === target && Date.now() - preClick.at < 1500;

      const wasFocused = fresh ? preClick.wasFocused : document.activeElement === target;
      const valueLength = target.value.length;
      let selectionStart: number | null = null;
      let selectionEnd: number | null = null;
      if (fresh) {
        selectionStart = preClick.start;
        selectionEnd = preClick.end;
      } else if (wasFocused) {
        try {
          selectionStart = target.selectionStart;
          selectionEnd = target.selectionEnd;
        } catch {
          // Selection API unsupported; fall back to a caret at the end.
        }
      }
      const { start, end } = resolveOpenSelection(
        wasFocused,
        selectionStart,
        selectionEnd,
        valueLength,
      );

      // Focus for the menu actions and pin the resolved selection — this
      // undoes any contextual word/token selection the engine made between
      // mousedown and contextmenu, so right-click never changes what is
      // selected.
      if (document.activeElement !== target) {
        target.focus({ preventScroll: true });
      }
      try {
        target.setSelectionRange(start, end);
      } catch {
        // Selection API unsupported for this input type.
      }
      // Some WebKit paths apply the contextual selection after dispatching
      // contextmenu — re-pin once on the next frame (no-op when it stuck).
      requestAnimationFrame(() => {
        if (targetRef.current !== target || !target.isConnected) return;
        try {
          target.setSelectionRange(start, end);
        } catch {
          // Selection API unsupported for this input type.
        }
      });

      targetRef.current = target;
      setSnapshot({
        x: event.clientX,
        y: event.clientY,
        start,
        end,
        hasSelection: end > start,
        hasContent: valueLength > 0,
        readOnly: target.readOnly,
        isPassword: target instanceof HTMLInputElement && target.type === "password",
      });
    },
    [closeMenu],
  );

  // Clamp against the measured size after render (no hard-coded dimensions —
  // labels vary by locale); useLayoutEffect runs before paint, so an
  // out-of-bounds menu never flashes at the raw pointer position.
  useLayoutEffect(() => {
    if (!snapshot) return;
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = clampMenuPosition(
      snapshot.x,
      snapshot.y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    );
    if (next.left !== snapshot.x || next.top !== snapshot.y) {
      setSnapshot({ ...snapshot, x: next.left, y: next.top });
    }
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };

    // Focus stays in the input while the menu is open, so any keystroke would
    // invalidate the captured selection snapshot — close on every key. Escape
    // is consumed so it only dismisses the menu, never a host dialog.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      closeMenu();
    };

    const handleClose = () => {
      closeMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleClose, true);
    window.addEventListener("resize", handleClose);
    window.addEventListener("blur", handleClose);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleClose, true);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("blur", handleClose);
    };
  }, [closeMenu, snapshot]);

  // Refocuses the input and restores the selection captured at open time so
  // execCommand acts on the range the user right-clicked.
  const prepareTarget = useCallback(() => {
    const el = targetRef.current;
    if (!el?.isConnected || !snapshot) return null;
    el.focus({ preventScroll: true });
    try {
      el.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      // Selection API unsupported; execCommand acts on the browser caret.
    }
    return el;
  }, [snapshot]);

  const handleCopy = useCallback(() => {
    const el = targetRef.current;
    if (el?.isConnected && snapshot) {
      writeTextToClipboard(el.value.slice(snapshot.start, snapshot.end));
    }
    closeMenu();
  }, [closeMenu, snapshot]);

  const handleCut = useCallback(() => {
    const el = prepareTarget();
    if (!el || !snapshot?.hasSelection) {
      closeMenu();
      return;
    }
    const text = el.value.slice(snapshot.start, snapshot.end);
    let removed = false;
    try {
      // Goes through the browser editing pipeline so React onChange fires.
      removed = document.execCommand("delete");
    } catch {
      removed = false;
    }
    if (!removed) {
      setNativeValue(
        el,
        el.value.slice(0, snapshot.start) + el.value.slice(snapshot.end),
        snapshot.start,
      );
    }
    writeTextToClipboard(text);
    closeMenu();
  }, [closeMenu, prepareTarget, snapshot]);

  const handlePaste = useCallback(async () => {
    const snap = snapshot;
    if (!snap) return;

    // Native-first read: the webview clipboard API pops WebKit's paste
    // confirmation for externally-copied content (see readClipboardText).
    const text = await readClipboardText();

    // Refocus after the await — the read may have shifted focus.
    const el = prepareTarget();
    if (!el) {
      closeMenu();
      return;
    }

    if (text === null) {
      // Clipboard read denied — let the browser paste natively (WebKit).
      try {
        document.execCommand("paste");
      } catch {
        // Nothing left to fall back to.
      }
      closeMenu();
      return;
    }

    if (!text) {
      closeMenu();
      return;
    }

    const insert = el instanceof HTMLInputElement ? text.replace(/\r\n?|\n/g, " ") : text;
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, insert);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      setNativeValue(
        el,
        el.value.slice(0, snap.start) + insert + el.value.slice(snap.end),
        snap.start + insert.length,
      );
    }
    closeMenu();
  }, [closeMenu, prepareTarget, snapshot]);

  const handleSelectAll = useCallback(() => {
    const el = targetRef.current;
    if (el?.isConnected) {
      el.focus({ preventScroll: true });
      el.select();
    }
    closeMenu();
  }, [closeMenu]);

  // Clearing the snapshot starts the exit animation; the retained snapshot
  // keeps the menu rendered (inert) until the fade-out completes.
  const { rendered: renderedSnapshot, isExiting } = useMenuExitPresence(snapshot);
  const items = renderedSnapshot ? computeMenuItems(renderedSnapshot) : null;

  const menu =
    renderedSnapshot && items
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            className={cn(
              "editor-context-menu fixed z-[10000] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] select-none overflow-hidden rounded-lg border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-[0_20px_60px_-20px_rgba(15,23,42,0.35)]",
              isExiting && "editor-context-menu-exit",
            )}
            style={{ left: renderedSnapshot.x, top: renderedSnapshot.y }}
            onContextMenu={(event) => {
              event.preventDefault();
            }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!items.canCut}
              className={MENU_ITEM_CLASS}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCut}
            >
              <Scissors className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("inputContextMenu.cut")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!items.canCopy}
              className={MENU_ITEM_CLASS}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCopy}
            >
              <Copy className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("inputContextMenu.copy")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!items.canPaste}
              className={MENU_ITEM_CLASS}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                void handlePaste();
              }}
            >
              <ClipboardPaste className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("inputContextMenu.paste")}</span>
            </button>
            <div className="my-1 h-px bg-border/70" />
            <button
              type="button"
              role="menuitem"
              disabled={!items.canSelectAll}
              className={MENU_ITEM_CLASS}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleSelectAll}
            >
              <ScanText className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("inputContextMenu.selectAll")}</span>
            </button>
          </div>,
          document.body,
        )
      : null;

  return { onRootContextMenu, onRootMouseDownCapture, menu };
}
