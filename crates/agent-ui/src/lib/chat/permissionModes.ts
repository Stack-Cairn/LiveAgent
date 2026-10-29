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
