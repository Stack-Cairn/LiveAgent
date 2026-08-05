// Quota ladder: turns the raw per-scope quota summary into a graded pressure
// level that biases the organizer prompt (compression target) and drives the
// settings-panel banner. Pure derivation — no auto-archival happens here.

import type { MemoryQuotaScopeSummary, MemoryQuotaSummaryResponse } from "../api";
import { QUOTA_LADDER_THRESHOLDS } from "../config";

export type QuotaLadderLevel = "normal" | "notice" | "degraded" | "critical" | "exhausted";

export type QuotaLadder = {
  level: QuotaLadderLevel;
  /** The scope with the least headroom (drives the level). */
  tightestScope?: MemoryQuotaScopeSummary;
  /** Organizer consolidation target: aim to reduce the tightest scope to this
   *  many entries (restores at least `notice` headroom). Unset when normal. */
  compressionTarget?: number;
  /** i18n key for the settings banner; unset when normal. */
  bannerKey?: string;
};

function levelForHeadroom(headroom: number): QuotaLadderLevel {
  if (headroom <= QUOTA_LADDER_THRESHOLDS.exhausted) return "exhausted";
  if (headroom <= QUOTA_LADDER_THRESHOLDS.critical) return "critical";
  if (headroom <= QUOTA_LADDER_THRESHOLDS.degraded) return "degraded";
  if (headroom <= QUOTA_LADDER_THRESHOLDS.notice) return "notice";
  return "normal";
}

const BANNER_KEYS: Record<Exclude<QuotaLadderLevel, "normal">, string> = {
  notice: "settings.memoryQuotaNotice",
  degraded: "settings.memoryQuotaDegraded",
  critical: "settings.memoryQuotaCritical",
  exhausted: "settings.memoryQuotaExhausted",
};

export function deriveQuotaLadder(summary: MemoryQuotaSummaryResponse | null): QuotaLadder {
  const scopes = summary?.scopes ?? [];
  if (scopes.length === 0) return { level: "normal" };

  let tightest = scopes[0];
  for (const scope of scopes) {
    if (scope.headroom < tightest.headroom) tightest = scope;
  }
  const level = levelForHeadroom(tightest.headroom);
  if (level === "normal") return { level, tightestScope: tightest };

  return {
    level,
    tightestScope: tightest,
    compressionTarget: Math.max(0, tightest.limit - QUOTA_LADDER_THRESHOLDS.notice),
    bannerKey: BANNER_KEYS[level],
  };
}
