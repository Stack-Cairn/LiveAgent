import {
  DEFAULT_RETRY_ERROR_SETTINGS,
  RETRYABLE_PRESET_HTTP_STATUS_CODES,
  type RetryErrorSettings,
} from "./types";

const PRESET_CODE_SET = new Set<number>(RETRYABLE_PRESET_HTTP_STATUS_CODES);

/**
 * Normalizes the user-defined retry-error config.
 *
 * `presetStatusCodes` are validated against the known preset list (unknown codes
 * dropped, duplicates removed). A present-but-empty array is respected — the
 * user may want to opt out of every preset — while a missing field (legacy
 * snapshot) falls back to all presets on, so relays self-heal out of the box
 * (#608) without requiring the user to opt in.
 *
 * `customPatterns` are trimmed, de-duplicated case-insensitively, and empties
 * are dropped.
 */
export function normalizeRetryErrorSettings(input: unknown): RetryErrorSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const defaults = DEFAULT_RETRY_ERROR_SETTINGS;

  const presetStatusCodes: number[] = [];
  if (Array.isArray(obj.presetStatusCodes)) {
    const seen = new Set<number>();
    for (const raw of obj.presetStatusCodes) {
      const code = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : Number.NaN;
      if (!Number.isFinite(code) || !PRESET_CODE_SET.has(code) || seen.has(code)) continue;
      seen.add(code);
      presetStatusCodes.push(code);
    }
  } else {
    // Missing field (legacy snapshot): default to every preset enabled.
    presetStatusCodes.push(...defaults.presetStatusCodes);
  }

  const customPatterns: string[] = [];
  if (Array.isArray(obj.customPatterns)) {
    const seen = new Set<string>();
    for (const raw of obj.customPatterns) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      customPatterns.push(trimmed);
    }
  }

  return {
    presetStatusCodes,
    customPatterns,
  };
}
