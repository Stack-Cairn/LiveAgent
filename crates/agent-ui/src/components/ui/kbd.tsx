import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { isMacLikePlatform } from "../../lib/chat/commandPalette";
import { cn } from "../../lib/shared/utils";

/**
 * Keyboard hints. `Kbd` is one key cap; `KbdShortcut` renders a chord such as
 * "Mod+Shift+KeyO" as ⇧ ⌘ O on macOS and Ctrl Shift O elsewhere.
 *
 * Chord syntax: tokens joined by "+". Modifiers are Mod (⌘ on macOS, Ctrl
 * elsewhere), Ctrl, Shift, Alt and Meta; the key is a KeyboardEvent.code
 * ("KeyK", "Digit1", "Comma", "ArrowUp", "Enter") or a plain label ("K", "/").
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

type Modifier = "Ctrl" | "Alt" | "Shift" | "Meta";

const MODIFIER_ALIASES: Record<string, Modifier | "Mod"> = {
  mod: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  super: "Meta",
  cmd: "Meta",
  command: "Meta",
};
// macOS menus order modifiers ⌃⌥⇧⌘; Windows and Linux write Ctrl+Shift+Alt.
const MAC_ORDER: readonly Modifier[] = ["Ctrl", "Alt", "Shift", "Meta"];
const OTHER_ORDER: readonly Modifier[] = ["Ctrl", "Shift", "Alt", "Meta"];
const MAC_MODIFIER_GLYPHS: Record<Modifier, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Meta: "⌘",
};
const OTHER_MODIFIER_LABELS: Record<Modifier, string> = {
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Win",
};
const ARIA_MODIFIERS: Record<Modifier, string> = {
  Ctrl: "Control",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Meta",
};
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Esc: "Esc",
  Space: "Space",
  Tab: "Tab",
  Backspace: "⌫",
  Delete: "Del",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Plus: "+",
};
const ARIA_KEYS: Record<string, string> = {
  Esc: "Escape",
  Space: "Space",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Plus: "+",
};

type ParsedChord = { modifiers: Modifier[]; key: string | null };

function parseChord(shortcut: string, isMac: boolean): ParsedChord {
  const modifiers = new Set<Modifier>();
  let key: string | null = null;
  // A trailing "+" is the plus key itself ("Ctrl++").
  const parts = shortcut.endsWith("++")
    ? [...shortcut.slice(0, -2).split("+"), "Plus"]
    : shortcut.split("+");
  for (const raw of parts) {
    const token = raw.trim();
    if (!token) continue;
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier === "Mod") modifiers.add(isMac ? "Meta" : "Ctrl");
    else if (modifier) modifiers.add(modifier);
    else key = token;
  }
  const order = isMac ? MAC_ORDER : OTHER_ORDER;
  return { modifiers: order.filter((modifier) => modifiers.has(modifier)), key };
}

function normalizeKeyCode(key: string): string {
  if (/^Key[A-Z]$/.test(key)) return key.slice(3);
  if (/^Digit\d$/.test(key)) return key.slice(5);
  if (/^Numpad\d$/.test(key)) return key.slice(6);
  return key;
}

function keyLabel(key: string, isMac: boolean): string {
  if (key === "Enter" || key === "Return") return isMac ? "↩" : "Enter";
  const normalized = normalizeKeyCode(key);
  return (
    KEY_LABELS[normalized] ?? (normalized.length === 1 ? normalized.toUpperCase() : normalized)
  );
}

/** Display tokens for a chord: ["⇧", "⌘", "O"] on macOS, ["Ctrl", "Shift", "O"] elsewhere. */
export function shortcutKeyTokens(
  shortcut: string,
  isMac: boolean = isMacLikePlatform(),
): string[] {
  const { modifiers, key } = parseChord(shortcut, isMac);
  const labels = isMac ? MAC_MODIFIER_GLYPHS : OTHER_MODIFIER_LABELS;
  const tokens = modifiers.map((modifier) => labels[modifier]);
  if (key) tokens.push(keyLabel(key, isMac));
  return tokens;
}

/** Plain-text form for native titles: "⇧⌘O" on macOS, "Ctrl+Shift+O" elsewhere. */
export function formatShortcutText(shortcut: string, isMac: boolean = isMacLikePlatform()): string {
  return shortcutKeyTokens(shortcut, isMac).join(isMac ? "" : "+");
}

/** Value for `aria-keyshortcuts`, e.g. "Meta+Shift+O" or "Control+B". */
export function shortcutAriaKeys(shortcut: string, isMac: boolean = isMacLikePlatform()): string {
  const { modifiers, key } = parseChord(shortcut, isMac);
  const tokens = modifiers.map((modifier) => ARIA_MODIFIERS[modifier]);
  if (key) {
    const normalized = normalizeKeyCode(key);
    tokens.push(
      ARIA_KEYS[normalized] ?? (normalized.length === 1 ? normalized.toUpperCase() : normalized),
    );
  }
  return tokens.join("+");
}

export type KbdShortcutProps = Omit<React.ComponentPropsWithoutRef<"kbd">, "children"> &
  VariantProps<typeof kbdVariants> & {
    shortcut: string;
    /** Defaults to the current platform. */
    isMac?: boolean;
    /** Class for each key cap. */
    keyClassName?: string;
  };

/** A whole chord, one cap per key; screen readers read the compact text form instead. */
export function KbdShortcut({
  shortcut,
  isMac,
  variant,
  size,
  className,
  keyClassName,
  ...props
}: KbdShortcutProps) {
  const mac = isMac ?? isMacLikePlatform();
  const tokens = shortcutKeyTokens(shortcut, mac);
  if (tokens.length === 0) return null;
  return (
    <kbd
      data-slot="kbd-shortcut"
      className={cn("inline-flex shrink-0 items-center gap-0.5 font-sans", className)}
      {...props}
    >
      <span className="sr-only">{formatShortcutText(shortcut, mac)}</span>
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
