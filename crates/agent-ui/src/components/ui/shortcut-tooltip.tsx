import * as React from "react";

import { isMacLikePlatform } from "../../lib/shared/platform";
import { formatShortcutLabel, shortcutAriaKeys } from "../../lib/shortcuts/shortcutKeys";
import { KbdShortcut } from "./kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type TooltipContentPlacement = Pick<
  React.ComponentPropsWithoutRef<typeof TooltipContent>,
  "align" | "side" | "sideOffset"
>;

export type ShortcutTooltipProps = TooltipContentPlacement &
  Omit<React.HTMLAttributes<HTMLButtonElement>, "children"> & {
    /** Visible tooltip text; icon-only triggers still need their own aria-label. */
    label: string;
    /** Chord in Kbd syntax ("Mod+KeyB", "Enter"); omitted or null shows the label only. */
    shortcut?: string | null;
    /** The trigger element. It receives the tooltip's event handlers and ref. */
    children: React.ReactElement;
    /**
     * Pass the trigger's disabled state. Disabled controls get no pointer
     * events in WebKit, so the label falls back to a native title there.
     */
    triggerDisabled?: boolean;
    delay?: number;
    closeOnClick?: boolean;
    isMac?: boolean;
  };

/**
 * Label + optional shortcut tooltip on the shared tooltip primitive. It opens
 * on hover and on keyboard focus, and sets `aria-keyshortcuts` on the trigger.
 * Extra props and the ref are forwarded to the trigger, so it can sit inside
 * another `render` prop (a popover or menu trigger).
 */
export const ShortcutTooltip = React.forwardRef<HTMLButtonElement, ShortcutTooltipProps>(
  function ShortcutTooltip(
    {
      label,
      shortcut,
      children,
      triggerDisabled = false,
      delay = 300,
      closeOnClick = true,
      isMac,
      side = "top",
      align,
      sideOffset,
      ...triggerProps
    },
    ref,
  ) {
    const mac = isMac ?? isMacLikePlatform();
    const fallbackTitle = shortcut ? `${label} (${formatShortcutLabel(shortcut, mac)})` : label;
    return (
      <Tooltip disabled={triggerDisabled}>
        <TooltipTrigger
          ref={ref}
          delay={delay}
          closeOnClick={closeOnClick}
          render={children}
          {...(shortcut ? { "aria-keyshortcuts": shortcutAriaKeys(shortcut, mac) } : null)}
          {...(triggerDisabled ? { title: fallbackTitle } : null)}
          {...triggerProps}
        />
        <TooltipContent side={side} align={align} sideOffset={sideOffset}>
          <span data-slot="shortcut-tooltip" className="flex items-center gap-2">
            <span>{label}</span>
            {shortcut ? (
              <KbdShortcut
                shortcut={shortcut}
                isMac={mac}
                size="sm"
                className="-my-0.5"
                keyClassName="border-popover-foreground/15 text-popover-foreground/70"
              />
            ) : null}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  },
);
