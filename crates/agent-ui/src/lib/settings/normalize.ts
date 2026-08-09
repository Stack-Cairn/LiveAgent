export function normalizeBaseUrl(input: string) {
  const trimmed = input.trim();
  const schemeMatch = /^(https?:)(.*)$/i.exec(trimmed);
  const normalized =
    schemeMatch && !schemeMatch[2].startsWith("//")
      ? `${schemeMatch[1]}//${schemeMatch[2].replace(/^\/+/, "")}`
      : trimmed;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function normalizeApiKey(input: string) {
  return input.trim();
}

export function normalizeModels(input: string | string[]) {
  const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const m = raw.trim();
    if (!m) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }

  return out;
}
