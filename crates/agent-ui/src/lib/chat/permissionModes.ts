import type { CommandSafetyMode } from "../settings/types";

export type KBrainPermissionMode =
  | "normal"
  | "plan"
  | "auto_edit"
  | "full_access"
  | "always"
  | "auto_review";

export function resolveKBrainPermissionMode(
  mode: CommandSafetyMode | undefined,
  planModeEnabled = false,
): KBrainPermissionMode {
  if (planModeEnabled) return "plan";
  switch (mode) {
    case "autoEdit":
      return "auto_edit";
    // Legacy "auto" (retired "full access") runs as "always", matching the
    // settings migration, should an older client still send it.
    case "auto":
    case "always":
      return "always";
    case "autoReview":
      return "auto_review";
    // Sandboxed runs edit files without asking; their shell commands run inside
    // the OS sandbox (options.sandbox) instead of asking before each one.
    case "sandbox":
    case "sandboxOffline":
      return "auto_edit";
    default:
      return "normal";
  }
}

/** K-brain `options.sandbox` (capability run_sandbox) for a run. */
export type KBrainRunSandbox = { mode: "workspace"; network: boolean };

/**
 * The OS sandbox a mode asks for: workspace writes only, credential directories
 * hidden; the offline variant also blocks the network. Other modes run commands
 * unconfined and leave the field out.
 */
export function resolveKBrainRunSandbox(
  mode: CommandSafetyMode | undefined,
): KBrainRunSandbox | undefined {
  if (mode === "sandbox") return { mode: "workspace", network: true };
  if (mode === "sandboxOffline") return { mode: "workspace", network: false };
  return undefined;
}

export interface ComposerPermissionModeState {
  commandSafetyMode: CommandSafetyMode | undefined;
  planModeEnabled: boolean;
}

/**
 * Shift+Tab in the composer: ask → auto edit → plan → ask. Plan is its own
 * switch, so entering it keeps the permission mode underneath (turning plan off
 * from its pill restores that mode). Any other mode returns to ask; always allow
 * and the sandboxes are only chosen from the picker.
 */
export function nextComposerPermissionMode(state: ComposerPermissionModeState): {
  commandSafetyMode: CommandSafetyMode;
  planModeEnabled: boolean;
  shown: "ask" | "autoEdit" | "plan";
} {
  if (!state.planModeEnabled && state.commandSafetyMode === "ask") {
    return { commandSafetyMode: "autoEdit", planModeEnabled: false, shown: "autoEdit" };
  }
  if (!state.planModeEnabled && state.commandSafetyMode === "autoEdit") {
    return { commandSafetyMode: "autoEdit", planModeEnabled: true, shown: "plan" };
  }
  return { commandSafetyMode: "ask", planModeEnabled: false, shown: "ask" };
}
