import type { ProviderId } from "../settings";

export type BashTimeoutPolicy = {
  providerId: ProviderId;
  providerLabel: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
};

export const MIN_BASH_TIMEOUT_MS = 1_000;
export const CLAUDE_CODE_BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const CLAUDE_CODE_BASH_MAX_TIMEOUT_MS = 600_000;
export const CODEX_BASH_MAX_TIMEOUT_MS = 30_000;
export const CODEX_BASH_DEFAULT_TIMEOUT_MS = CODEX_BASH_MAX_TIMEOUT_MS;
export const GLOBAL_BASH_MAX_TIMEOUT_MS = CLAUDE_CODE_BASH_MAX_TIMEOUT_MS;

const BASH_TIMEOUT_POLICIES: Record<ProviderId, BashTimeoutPolicy> = {
  claude_code: {
    providerId: "claude_code",
    providerLabel: "Claude Code",
    defaultTimeoutMs: CLAUDE_CODE_BASH_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: CLAUDE_CODE_BASH_MAX_TIMEOUT_MS,
  },
  codex: {
    providerId: "codex",
    providerLabel: "Codex",
    defaultTimeoutMs: CODEX_BASH_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: CODEX_BASH_MAX_TIMEOUT_MS,
  },
  gemini: {
    providerId: "gemini",
    providerLabel: "Gemini",
    defaultTimeoutMs: CODEX_BASH_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: CODEX_BASH_MAX_TIMEOUT_MS,
  },
  xai: {
    providerId: "xai",
    providerLabel: "Grok",
    defaultTimeoutMs: CODEX_BASH_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: CODEX_BASH_MAX_TIMEOUT_MS,
  },
};

export function resolveBashTimeoutPolicy(providerId: ProviderId): BashTimeoutPolicy {
  return BASH_TIMEOUT_POLICIES[providerId];
}

export function normalizeBashTimeoutMs(value: unknown, policy: BashTimeoutPolicy) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return policy.defaultTimeoutMs;
  }
  return Math.min(policy.maxTimeoutMs, Math.max(MIN_BASH_TIMEOUT_MS, Math.floor(value)));
}
