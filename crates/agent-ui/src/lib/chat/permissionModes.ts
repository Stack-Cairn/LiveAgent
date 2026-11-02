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
    default:
      return "normal";
  }
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
