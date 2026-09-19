/** Join adjacent string arguments so source-level style contracts can inspect a split cn(...) value. */
export function normalizeClassGroups(source) {
  return source.replace(/"\s*,\s*"/g, " ");
}
