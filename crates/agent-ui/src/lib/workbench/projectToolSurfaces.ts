import { PROJECT_TOOL_SURFACE_KINDS, type ProjectToolSurfaceKind } from "./types";

/**
 * Localised label keys per project tool. Shared by the pane chrome title, the
 * drag ghost, the accessible region label and the dock tab so every host
 * spells a tool the same way.
 */
export const PROJECT_TOOL_SURFACE_TITLE_KEYS: Readonly<Record<ProjectToolSurfaceKind, string>> = {
  fileTree: "projectTools.fileTreeTitle",
  gitReview: "projectTools.gitReviewTitle",
  tunnel: "projectTools.tunnelTitle",
  sshTunnel: "projectTools.sshTunnelTitle",
  backgroundTasks: "projectTools.backgroundTasksTitle",
};

export function projectToolSurfaceTitleKey(kind: ProjectToolSurfaceKind): string {
  return PROJECT_TOOL_SURFACE_TITLE_KEYS[kind];
}

export { PROJECT_TOOL_SURFACE_KINDS };
