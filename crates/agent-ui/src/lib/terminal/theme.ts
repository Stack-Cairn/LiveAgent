import type { ITheme } from "@xterm/xterm";

const COLOR_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionInactiveBackground",
  "scrollbarSliderBackground",
  "scrollbarSliderHoverBackground",
  "scrollbarSliderActiveBackground",
  "overviewRulerBorder",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

type StyleValues = Pick<CSSStyleDeclaration, "getPropertyValue">;

// xterm parses concrete colors, so resolve CSS variables before passing its palette.
// In particular, preserve the 8-digit transparent hex for the overview ruler;
// xterm's fallback parser does not accept the transparent keyword here.
export function readTerminalTheme(
  theme: "light" | "dark",
  style: StyleValues = getComputedStyle(document.documentElement),
): ITheme {
  return Object.fromEntries(
    COLOR_KEYS.map((key) => [
      key,
      style
        .getPropertyValue(
          `--terminal-${theme}-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
        )
        .trim(),
    ]),
  );
}

export function readTerminalAppearance(
  theme: "light" | "dark",
  style: StyleValues = getComputedStyle(document.documentElement),
) {
  return {
    theme: readTerminalTheme(theme, style),
    fontSize: Number.parseFloat(style.getPropertyValue("--text-13px")),
    lineHeight: Number.parseFloat(style.getPropertyValue("--leading-1p3")),
    overviewRulerWidth: Number.parseFloat(style.getPropertyValue("--spacing-8px")),
  };
}
