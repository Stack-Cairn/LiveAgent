import type { CustomProvider } from "../settings";

const RESERVED_CUSTOM_HEADER_KEYS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "anthropic-version",
  "content-type",
  "host",
  "content-length",
]);
const HTTP_HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidCustomHeaderKey(key: string): boolean {
  return HTTP_HEADER_TOKEN_PATTERN.test(key);
}

export function isReservedCustomHeaderKey(key: string): boolean {
  return RESERVED_CUSTOM_HEADER_KEYS.has(key.toLowerCase());
}
export function mergeCustomHeaders(
  base: Record<string, string>,
  customHeaders?: CustomProvider["customHeaders"],
): Record<string, string> {
  const merged = { ...base };

  for (const header of customHeaders ?? []) {
    if (!isValidCustomHeaderKey(header.key) || isReservedCustomHeaderKey(header.key)) {
      continue;
    }

    const existingKey = Object.keys(merged).find(
      (key) => key.toLowerCase() === header.key.toLowerCase(),
    );
    if (existingKey) delete merged[existingKey];
    merged[header.key] = header.value;
  }

  return merged;
}
