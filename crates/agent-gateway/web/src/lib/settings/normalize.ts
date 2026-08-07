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

/**
 * 供应商多 API Key 归一化：输入可为数组（多 Key）或回退到单 Key 旧字段。
 * 逐项 trim、去空、去重，保持录入顺序。返回值始终是数组（可能为空），
 * 由 normalizeCustomProvider 派生 apiKey = apiKeys[0] ?? ""。
 */
export function normalizeApiKeys(apiKeys: unknown, apiKey: unknown): string[] {
  const keys: string[] = [];
  if (Array.isArray(apiKeys)) {
    for (const value of apiKeys) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
    }
  }
  // 旧快照只有单 apiKey 字段：迁移成单元素数组，行为与改造前一致。
  if (keys.length === 0 && typeof apiKey === "string") {
    const trimmed = apiKey.trim();
    if (trimmed) keys.push(trimmed);
  }
  return keys;
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
