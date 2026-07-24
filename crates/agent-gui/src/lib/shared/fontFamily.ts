export const DEFAULT_INTERFACE_FONT_FAMILY =
  'ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
export const DEFAULT_APP_FONT_FAMILY = DEFAULT_INTERFACE_FONT_FAMILY;
export const DEFAULT_CHAT_FONT_FAMILY =
  '"OpenAI Sans Semibold", "PingFang SC", "Microsoft YaHei", sans-serif';
export const DEFAULT_CODE_FONT_FAMILY =
  '"SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, "Liberation Mono", monospace';

// Shared between GUI and WebUI so mirrored XTerm can listen without platform adapters.
export const CODE_FONT_FAMILY_CHANGE_EVENT = "liveagent:code-font-family-change";
// SelectItem rejects empty strings, so built-in stacks / freeform input use sentinels.
export const FONT_FAMILY_DEFAULT_SELECT_VALUE = "__default__";
export const FONT_FAMILY_CUSTOM_SELECT_VALUE = "__custom__";

// Curated families always offered even when queryLocalFonts is unavailable.
export const COMMON_FONT_FAMILIES = [
  "Inter",
  "SF Pro Text",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Noto Sans SC",
  "Source Han Sans SC",
  "Helvetica Neue",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Songti SC",
  "STSong",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Cascadia Code",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "IBM Plex Mono",
] as const;

export type FontFamilySelectOption = {
  value: string;
  label: string;
};

export type FontFamilySettings = {
  interfaceFontFamily: string;
  chatFontFamily: string;
  codeFontFamily: string;
};

const MAX_FONT_FAMILY_LENGTH = 200;

// Reject values that could break out of a CSS declaration or inject external resources.
const UNSAFE_FONT_FAMILY_PATTERN = /[;{}<>\\]|url\s*\(|@import|expression\s*\(/i;
const ALLOWED_FONT_FAMILY_PATTERN = /^[\w\s,"'\-.+]+$/u;

type LocalFontData = {
  family?: string;
};

type QueryLocalFonts = () => Promise<LocalFontData[]>;

export function normalizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length > MAX_FONT_FAMILY_LENGTH) return "";
  if (UNSAFE_FONT_FAMILY_PATTERN.test(trimmed)) return "";
  if (!ALLOWED_FONT_FAMILY_PATTERN.test(trimmed)) return "";
  return trimmed;
}

export function resolveFontFamily(value: string, fallback: string): string {
  return normalizeFontFamily(value) || fallback;
}

export function resolveAppFontFamily(value: string): string {
  return resolveFontFamily(value, DEFAULT_APP_FONT_FAMILY);
}

export function resolveChatFontFamily(value: string): string {
  return resolveFontFamily(value, DEFAULT_CHAT_FONT_FAMILY);
}

export function resolveCodeFontFamily(value: string): string {
  return resolveFontFamily(value, DEFAULT_CODE_FONT_FAMILY);
}

export function getCodeFontFamily(root: HTMLElement = document.documentElement): string {
  const inlineValue = root.style.getPropertyValue("--code-font-family");
  if (inlineValue) return resolveCodeFontFamily(inlineValue);
  const computedValue = root.ownerDocument?.defaultView
    ?.getComputedStyle(root)
    .getPropertyValue("--code-font-family");
  return resolveCodeFontFamily(computedValue ?? "");
}

export function applyFontFamilies(
  settings: FontFamilySettings,
  root: HTMLElement = document.documentElement,
): void {
  const appFontFamily = resolveAppFontFamily(settings.interfaceFontFamily);
  const chatFontFamily = resolveChatFontFamily(settings.chatFontFamily);
  const codeFontFamily = resolveCodeFontFamily(settings.codeFontFamily);
  const previousCodeFontFamily = root.style.getPropertyValue("--code-font-family");

  root.style.setProperty("--app-font-family", appFontFamily);
  root.style.setProperty("--chat-font-family", chatFontFamily);
  root.style.setProperty("--code-font-family", codeFontFamily);

  if (previousCodeFontFamily !== codeFontFamily) {
    const target = root.ownerDocument?.defaultView ?? globalThis.window;
    target?.dispatchEvent(
      new CustomEvent<string>(CODE_FONT_FAMILY_CHANGE_EVENT, { detail: codeFontFamily }),
    );
  }
}

export function quoteFontFamilyName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

export function buildFontFamilySelectOptions(
  localFamilies: readonly string[] = [],
): FontFamilySelectOption[] {
  const byValue = new Map<string, string>();

  for (const family of COMMON_FONT_FAMILIES) {
    const value = quoteFontFamilyName(family);
    if (value) byValue.set(value, family);
  }

  for (const family of localFamilies) {
    const trimmed = typeof family === "string" ? family.trim() : "";
    if (!trimmed) continue;
    const value = quoteFontFamilyName(trimmed);
    if (value && !byValue.has(value)) byValue.set(value, trimmed);
  }

  return [...byValue.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
    );
}

export function isKnownFontFamilySelectValue(
  value: string,
  options: readonly FontFamilySelectOption[],
): boolean {
  const normalized = normalizeFontFamily(value);
  if (!normalized) return true;
  return options.some((option) => option.value === normalized);
}

export function toFontFamilySelectValue(
  value: string,
  options: readonly FontFamilySelectOption[],
  preferCustom = false,
): string {
  const normalized = normalizeFontFamily(value);
  if (!normalized) {
    return preferCustom ? FONT_FAMILY_CUSTOM_SELECT_VALUE : FONT_FAMILY_DEFAULT_SELECT_VALUE;
  }
  if (!preferCustom && options.some((option) => option.value === normalized)) {
    return normalized;
  }
  return FONT_FAMILY_CUSTOM_SELECT_VALUE;
}

export function fromFontFamilySelectValue(value: string): string {
  if (value === FONT_FAMILY_DEFAULT_SELECT_VALUE || value === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
    return "";
  }
  return normalizeFontFamily(value);
}

export async function listLocalFontFamilies(): Promise<string[]> {
  const queryLocalFonts = (
    globalThis as typeof globalThis & {
      queryLocalFonts?: QueryLocalFonts;
    }
  ).queryLocalFonts;
  if (typeof queryLocalFonts !== "function") return [];

  try {
    const fonts = await queryLocalFonts();
    const names = new Set<string>();
    for (const font of fonts) {
      const family = typeof font.family === "string" ? font.family.trim() : "";
      if (family) names.add(family);
    }
    return [...names].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
  } catch {
    return [];
  }
}
