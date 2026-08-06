const MAX_FONT_FAMILY_LENGTH = 200;

// Reject values that could break out of a CSS declaration or inject external resources.
const UNSAFE_FONT_FAMILY_PATTERN = /[;{}<>\\]|url\s*\(|@import|expression\s*\(/i;
const ALLOWED_FONT_FAMILY_PATTERN = /^[\w\s,"'\-.+]+$/u;

export function normalizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length > MAX_FONT_FAMILY_LENGTH) return "";
  if (UNSAFE_FONT_FAMILY_PATTERN.test(trimmed)) return "";
  if (!ALLOWED_FONT_FAMILY_PATTERN.test(trimmed)) return "";
  return trimmed;
}
