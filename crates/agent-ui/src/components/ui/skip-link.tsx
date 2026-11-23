import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";

const COMPOSER_EDITOR_SELECTOR =
  '[data-testid="chat-composer"] [role="textbox"][contenteditable="true"]';

/** Moves focus to the chat composer's editor; false when no composer is on screen. */
export function focusChatComposer(root: ParentNode = document): boolean {
  const editor = root.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR);
  if (!editor) return false;
  editor.focus();
  editor.scrollIntoView?.({ block: "nearest" });
  return true;
}

/**
 * First Tab stop of the chat layout: hidden until it receives keyboard focus,
 * then jumps past the sidebar and header controls straight to the composer.
 */
export function SkipToComposerLink({ className }: { className?: string }) {
  const { t } = useLocale();
  // A button rather than an in-page anchor: the composer has no stable id and
  // focusing it is an action, not navigation.
  return (
    <button
      type="button"
      data-slot="skip-to-composer"
      onClick={() => focusChatComposer()}
      className={cn(
        "sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:m-0",
        "focus-visible:size-auto focus-visible:overflow-visible focus-visible:whitespace-nowrap",
        "focus-visible:[clip-path:none] focus-visible:[clip:auto]",
        "focus-visible:layer-critical focus-visible:rounded-md focus-visible:bg-background",
        "focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium",
        "focus-visible:text-foreground focus-visible:shadow-lg focus-visible:outline-hidden",
        "focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {t("a11y.skipToComposer")}
    </button>
  );
}
