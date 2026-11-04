import { type RefObject, useEffect, useRef } from "react";
import { isCommandPaletteSuppressed } from "../chat/commandPalette";
import { isMacLikePlatform } from "../shared/platform";
import { matchesShortcutCommand } from "./shortcutCommands";
import { isKeyEventHandledElsewhere } from "./shortcutKeys";

const WORKBENCH_PANE = "[data-workbench-pane]";
const DIALOG = "[role=dialog], [role=alertdialog], [aria-modal=true]";

/**
 * With several workbench panes only the focused pane's composer reacts; a
 * composer outside the workbench always does.
 */
function ownsComposerShortcut(root: Element | null): boolean {
  if (!root?.isConnected) return false;
  const pane = root.closest(WORKBENCH_PANE);
  return !pane || pane.getAttribute("data-workbench-pane-focused") === "true";
}

/**
 * Composer-level shortcut commands: focus the message editor and open the
 * model picker. Both hosts render the shared composer, so both get them.
 */
export function useComposerShortcuts(options: {
  rootRef: RefObject<Element | null>;
  enabled: boolean;
  focusComposer: () => void;
  openModelPicker?: () => void;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const { enabled } = options;
  useEffect(() => {
    if (!enabled) return;
    const isMac = isMacLikePlatform();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isKeyEventHandledElsewhere(event) || isCommandPaletteSuppressed()) return;
      const current = latest.current;
      const command = matchesShortcutCommand(event, "focusComposer", isMac)
        ? "focusComposer"
        : current.openModelPicker && matchesShortcutCommand(event, "openModelPicker", isMac)
          ? "openModelPicker"
          : null;
      if (!command || !ownsComposerShortcut(current.rootRef.current)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(DIALOG)) return;
      event.preventDefault();
      if (event.repeat) return;
      if (command === "focusComposer") current.focusComposer();
      else current.openModelPicker?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
