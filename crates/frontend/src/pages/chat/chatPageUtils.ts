import { mergeAlwaysEnabledSkillNames } from "../../lib/skills";

export function appendManagedSkillSelections(current: readonly string[], names: readonly string[]) {
  const out = mergeAlwaysEnabledSkillNames(current);
  const seen = new Set(out);
  for (const rawName of names) {
    const name = String(rawName).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}
