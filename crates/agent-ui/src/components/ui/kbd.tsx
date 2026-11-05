import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { isMacLikePlatform } from "../../lib/shared/platform";
import { cn } from "../../lib/shared/utils";
import { formatShortcutLabel, shortcutDisplayTokens } from "../../lib/shortcuts/shortcutKeys";

/**
 * Keyboard hints. `Kbd` is one key cap; `KbdShortcut` renders a chord such as
 * "Mod+Shift+KeyO" as ⇧ ⌘ O on macOS and Ctrl Shift O elsewhere.
 *
 * Labels come from the shared formatter in lib/shortcuts/shortcutKeys
 * (`shortcutDisplayTokens` / `formatShortcutLabel`), which also documents the
 * chord syntax: modifiers Mod (⌘ on macOS, Ctrl elsewhere), Ctrl, Shift, Alt
 * and Super/Meta/Cmd; the key is a KeyboardEvent.code ("KeyK", "Comma",
 * "ArrowUp", "Enter") or a plain label ("K", "/"). Never build a label by hand.
 */

const kbdVariants = cva(
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded font-sans font-normal leading-none",
  {
    variants: {
      variant: {
        outline: "border border-foreground/10 text-muted-foreground",
        tile: "bg-settings-tile text-foreground",
        // Inline hint inside menus and buttons: no cap, just the glyphs.
        plain: "text-muted-foreground",
      },
      size: {
        default: "h-5 min-w-5 px-1 text-xs",
        sm: "h-4 min-w-4 px-1 text-tiny",
        inline: "",
      },
    },
    compoundVariants: [{ variant: "plain", className: "min-w-0 px-0" }],
    defaultVariants: { variant: "outline", size: "default" },
  },
);

export type KbdProps = React.ComponentPropsWithoutRef<"kbd"> & VariantProps<typeof kbdVariants>;

export const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ className, variant, size, ...props }, ref) => (
    <kbd
      ref={ref}
      data-slot="kbd"
      className={cn(kbdVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Kbd.displayName = "Kbd";

export type KbdShortcutProps = Omit<React.ComponentPropsWithoutRef<"kbd">, "children"> &
  VariantProps<typeof kbdVariants> & {
    shortcut: string;
    /** Defaults to the current platform. */
    isMac?: boolean;
    /** Class for each key cap. */
    keyClassName?: string;
    /**
     * One cap holding the compact label ("⇧⌘O" / "Ctrl+Shift+O") instead of one
     * cap per key: the menu-style hint for context menus, dropdowns and buttons.
     */
    compact?: boolean;
  };

/** A whole chord, one cap per key; screen readers read the compact text form instead. */
export function KbdShortcut({
  shortcut,
  isMac,
  variant,
  size,
  className,
  keyClassName,
  compact = false,
  ...props
}: KbdShortcutProps) {
  const mac = isMac ?? isMacLikePlatform();
  const tokens = shortcutDisplayTokens(shortcut, mac);
  if (tokens.length === 0) return null;
  if (compact) {
    return (
      <Kbd variant={variant} size={size} className={cn(className, keyClassName)} {...props}>
        {formatShortcutLabel(shortcut, mac)}
      </Kbd>
    );
  }
  return (
    <kbd
      data-slot="kbd-shortcut"
      className={cn("inline-flex shrink-0 items-center gap-0.5 font-sans", className)}
      {...props}
    >
      <span className="sr-only">{formatShortcutLabel(shortcut, mac)}</span>
      {tokens.map((token, index) => (
        <Kbd
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and may repeat
          key={index}
          aria-hidden="true"
          variant={variant}
          size={size}
          className={keyClassName}
        >
          {token}
        </Kbd>
      ))}
    </kbd>
  );
}
