import type { CommandSafetyMode } from "../settings";
import type { ShellSandboxSettings } from "./shellTools";

/**
 * Resolve the turn-level command safety mode into the one sandbox contract
 * shared by every model-driven shell registry (chat, cron, and subagents).
 */
export function resolveShellSandboxSettings(
  mode: CommandSafetyMode | null | undefined,
): ShellSandboxSettings | undefined {
  if (mode !== "sandbox" && mode !== "sandboxOffline") {
    return undefined;
  }
  return {
    enabled: true,
    allowNetwork: mode === "sandbox",
  };
}
