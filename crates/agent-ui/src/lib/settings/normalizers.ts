import {
  DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  MAX_CHAT_TRANSCRIPT_WIDTH,
  MIN_CHAT_TRANSCRIPT_WIDTH,
} from "@liveagent/ui/lib/transcript-width/transcriptWidthModel";
import type { ChatTranscriptSettings, FontScaleSettings } from "./types";

export function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

export function normalizePositiveInteger(input: unknown, fallback: number): number {
  const numeric =
    typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  const value = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return value > 0 ? value : fallback;
}

export function normalizeIntegerInRange(
  input: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = normalizePositiveInteger(input, fallback);
  return Math.min(max, Math.max(min, value));
}

export function normalizeFontScale(value: unknown): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(1.4, Math.max(0.8, Math.round(numberValue * 100) / 100));
}

export function normalizeFontScaleSettings(input: unknown): FontScaleSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    sidebar: normalizeFontScale(obj.sidebar),
    chat: normalizeFontScale(obj.chat),
    rightDock: normalizeFontScale(obj.rightDock),
  };
}

export function normalizeChatTranscriptSettings(input: unknown): ChatTranscriptSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    width: normalizeIntegerInRange(
      obj.width,
      MIN_CHAT_TRANSCRIPT_WIDTH,
      MAX_CHAT_TRANSCRIPT_WIDTH,
      DEFAULT_CHAT_TRANSCRIPT_WIDTH,
    ),
  };
}
