import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import type { ChatFileLink } from "../../lib/chat/chatFileLinks";
import {
  resolveThinkingOverlayPlacement,
  type ThinkingOverlayPlacement,
} from "../../lib/chat/thinkingOverlayModel";
import { ChevronRight, Lightbulb } from "../icons";
import { Markdown } from "../Markdown";

export function ThinkingActivity(props: {
  text: string;
  isRunning?: boolean;
  renderMode: "streaming" | "static";
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const { text, isRunning = false, renderMode, workdir, onOpenFileLink } = props;
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<ThinkingOverlayPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const hasText = /\S/.test(text);

  const updatePlacement = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPlacement(
      resolveThinkingOverlayPlacement(trigger.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPlacement(null);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePlacement();
    const focusFrame = requestAnimationFrame(() =>
      panelRef.current?.focus({ preventScroll: true }),
    );
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("focusin", handleFocusIn, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [close, open, updatePlacement]);

  if (!hasText) return null;

  return (
    <div className="group/think w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        className="thinking-block-toggle flex w-full cursor-pointer select-none items-center gap-2 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground/80 hover:text-foreground"
      >
        {isRunning ? (
          <span className="flex items-center gap-2">
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />
            {t("chat.thinking")}
          </span>
        ) : (
          <>
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            <span className="thinking-block-label">{t("chat.thinkingProcess")}</span>
          </>
        )}
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && placement
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={t("chat.thinkingProcess")}
              tabIndex={-1}
              data-scroll-follow-ignore-keys
              className="fixed z-[120] overflow-y-auto overscroll-contain rounded-xl border border-border/80 bg-background/95 p-4 shadow-2xl outline-none backdrop-blur-md"
              style={{
                left: placement.left,
                width: placement.width,
                maxHeight: placement.maxHeight,
                top: placement.top,
                bottom: placement.bottom,
              }}
            >
              <Markdown
                content={text}
                className="thinking-markdown space-y-1.5"
                renderMode={renderMode}
                showCaret={false}
                workdir={workdir}
                onOpenFileLink={onOpenFileLink}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
