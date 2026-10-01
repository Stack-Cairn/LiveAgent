import { useEffect } from "react";

/**
 * Closes the settings surface when Escape is pressed.
 *
 * Listens on `window`, not `document`, and that choice is load-bearing.
 * Anything nested that also wants Escape — a Base UI dialog, a combobox
 * popup, an inline rename field — must get the key first, and those layers
 * bind to `document` (Base UI's `useDismiss` uses the floating element's
 * owner document). Listeners on the same target fire in registration order,
 * so a `document` listener here would beat a dialog that opens later: the
 * settings page mounts first. `window` sits after `document` in the bubble
 * path regardless of when anyone subscribed, which turns the ordering into a
 * structural guarantee instead of a mounting-order coincidence.
 *
 * Those layers call `event.preventDefault()` when they consume the key (Base
 * UI does this whenever the close is not canceled), so honoring
 * `defaultPrevented` is what keeps a single press from both dismissing a
 * modal and dropping the user back into the chat.
 *
 * Text inputs are not excluded. Escape inside a settings field means "I'm
 * done here", and the fields that need to keep the key — the provider model
 * search, inline renames — already stop propagation themselves.
 */
export function useSettingsEscapeToClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A held Escape should not fire once per repeat tick.
      if (event.repeat) return;
      // Escape during IME composition cancels the composition, not the page.
      if (event.isComposing) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onClose]);
}
