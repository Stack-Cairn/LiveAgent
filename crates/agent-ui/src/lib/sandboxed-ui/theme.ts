// Theme tokens handed to sandboxed pages. Pages cannot read the host's CSS, so the host
// resolves its own design tokens to plain hex colors once per theme change.

export type SandboxedUiThemeMode = "light" | "dark";

export type SandboxedUiTheme = {
  mode: SandboxedUiThemeMode;
  colors: {
    background: string;
    foreground: string;
    muted: string;
    accent: string;
    border: string;
  };
  fontFamily: string;
  fontSize: number;
};

const FALLBACK_THEMES: Record<SandboxedUiThemeMode, SandboxedUiTheme["colors"]> = {
  light: {
    background: "#ffffff",
    foreground: "#020817",
    muted: "#64748b",
    accent: "#1677ff",
    border: "#e2e8f0",
  },
  dark: {
    background: "#181818",
    foreground: "#fafafa",
    muted: "#b8b8b8",
    accent: "#1677ff",
    border: "#424242",
  },
};

function toHexByte(value: number) {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

function hslToHex(h: number, s: number, l: number) {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${toHexByte(f(0) * 255)}${toHexByte(f(8) * 255)}${toHexByte(f(4) * 255)}`;
}

/**
 * Converts a token value to `#rrggbb`: the shadcn "H S% L%" component form, `#rgb`,
 * `#rrggbb`, `rgb()` and `hsl()`. Returns null for anything else.
 */
export function cssColorToHex(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    return digits.length === 3
      ? `#${digits
          .split("")
          .map((digit) => digit + digit)
          .join("")}`
      : `#${digits}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
  if (rgb) {
    return `#${toHexByte(Number(rgb[1]))}${toHexByte(Number(rgb[2]))}${toHexByte(Number(rgb[3]))}`;
  }
  const hsl = /^(?:hsla?\(\s*)?(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(value);
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  return null;
}

export function fallbackSandboxedUiTheme(mode: SandboxedUiThemeMode): SandboxedUiTheme {
  return {
    mode,
    colors: { ...FALLBACK_THEMES[mode] },
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
  };
}

export function readDocumentThemeMode(): SandboxedUiThemeMode {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Resolves the host's current tokens; falls back per color when a token is missing. */
export function readSandboxedUiTheme(mode = readDocumentThemeMode()): SandboxedUiTheme {
  const theme = fallbackSandboxedUiTheme(mode);
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return theme;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => cssColorToHex(style.getPropertyValue(name));
  theme.colors = {
    background: read("--background") ?? theme.colors.background,
    foreground: read("--foreground") ?? theme.colors.foreground,
    muted: read("--muted-foreground") ?? theme.colors.muted,
    accent: read("--ui-color-1677ff") ?? theme.colors.accent,
    border: read("--border") ?? theme.colors.border,
  };
  const bodyFont =
    typeof document.body !== "undefined" && document.body
      ? getComputedStyle(document.body).fontFamily
      : "";
  if (bodyFont) theme.fontFamily = bodyFont;
  return theme;
}

/** Calls `onChange` whenever the document switches between light and dark. */
export function observeDocumentThemeMode(onChange: (mode: SandboxedUiThemeMode) => void) {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  let current = readDocumentThemeMode();
  const observer = new MutationObserver(() => {
    const next = readDocumentThemeMode();
    if (next === current) return;
    current = next;
    onChange(next);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
