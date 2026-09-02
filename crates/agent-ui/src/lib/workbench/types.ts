export const WORKBENCH_LAYOUT_SCHEMA_VERSION = 1;

export type WorkbenchAxis = "horizontal" | "vertical";
export type WorkbenchEdge = "top" | "right" | "bottom" | "left";

export type ProjectRef = {
  projectId: string;
  projectPathKey: string;
};

export type ConversationWorkbenchSurface = {
  kind: "conversation";
  conversationId: string;
  project: ProjectRef;
};

/**
 * Project tools that can leave the Right Dock and live in a workbench pane.
 * Every kind is a singleton per scope (see `surfaceIdentityKey`): the pane and
 * the dock never show the same tool twice, and the dock hides its tab while a
 * pane holds the tool ("lease").
 */
export const PROJECT_TOOL_SURFACE_KINDS = [
  "fileTree",
  "gitReview",
  "tunnel",
  "sshTunnel",
  "backgroundTasks",
] as const;

export type ProjectToolSurfaceKind = (typeof PROJECT_TOOL_SURFACE_KINDS)[number];

/**
 * Distributive so `switch (surface.kind)` narrows per tool. Background tasks
 * carry the project they were opened from only for focus→dock project
 * context; their identity is window-wide (the managed-process registry is
 * global, so a second pane would just mirror the first).
 */
export type ProjectToolWorkbenchSurface = {
  [K in ProjectToolSurfaceKind]: { kind: K; project: ProjectRef };
}[ProjectToolSurfaceKind];

export type FileTreeWorkbenchSurface = Extract<ProjectToolWorkbenchSurface, { kind: "fileTree" }>;
export type GitReviewWorkbenchSurface = Extract<ProjectToolWorkbenchSurface, { kind: "gitReview" }>;
export type TunnelWorkbenchSurface = Extract<ProjectToolWorkbenchSurface, { kind: "tunnel" }>;
export type SshTunnelWorkbenchSurface = Extract<ProjectToolWorkbenchSurface, { kind: "sshTunnel" }>;
export type BackgroundTasksWorkbenchSurface = Extract<
  ProjectToolWorkbenchSurface,
  { kind: "backgroundTasks" }
>;

const PROJECT_TOOL_SURFACE_KIND_SET: ReadonlySet<string> = new Set(PROJECT_TOOL_SURFACE_KINDS);

export function isProjectToolSurfaceKind(kind: string): kind is ProjectToolSurfaceKind {
  return PROJECT_TOOL_SURFACE_KIND_SET.has(kind);
}

export function isProjectToolSurface(
  surface: WorkbenchSurfaceSpec,
): surface is ProjectToolWorkbenchSurface {
  return isProjectToolSurfaceKind(surface.kind);
}

/**
 * Identity key of a project tool without building a surface first. Hosts use
 * it for lease lookups (`findPaneIdBySurfaceKey`) and drop de-duplication.
 * Background tasks ignore the project (window singleton); the trailing colon
 * keeps the key shape `${kind}:${scope}` uniform.
 */
export function projectToolSurfaceIdentityKey(
  kind: ProjectToolSurfaceKind,
  projectPathKey: string,
): string {
  return kind === "backgroundTasks" ? "backgroundTasks:" : `${kind}:${projectPathKey.trim()}`;
}

export type LocalTerminalLaunchSpec = {
  cwd: string;
  shell?: string;
  title?: string;
};

export type SshTerminalLaunchSpec = {
  cwd: string;
  sshHostId: string;
  title?: string;
  sftpEnabled?: boolean;
};

export type LocalTerminalWorkbenchSurface = {
  kind: "localTerminal";
  surfaceId: string;
  project: ProjectRef;
  launchSpec: LocalTerminalLaunchSpec;
};

export type SshTerminalWorkbenchSurface = {
  kind: "sshTerminal";
  surfaceId: string;
  project: ProjectRef;
  launchSpec: SshTerminalLaunchSpec;
};

/**
 * Forward-compat passthrough: a persisted pane whose surface kind this build
 * does not understand. It survives decode/encode round-trips untouched but can
 * never be opened, and it is exempt from surface-identity uniqueness.
 */
export type UnsupportedWorkbenchSurface = {
  kind: "unsupported";
  originalKind: string;
  raw: Readonly<Record<string, unknown>>;
};

export type TerminalWorkbenchSurface = LocalTerminalWorkbenchSurface | SshTerminalWorkbenchSurface;

export type WorkbenchSurfaceSpec =
  | ConversationWorkbenchSurface
  | ProjectToolWorkbenchSurface
  | TerminalWorkbenchSurface
  | UnsupportedWorkbenchSurface;

/**
 * Stable identity used for the "one pane per surface" invariant. Unsupported
 * surfaces return a kind-scoped key that MUST NOT be used for uniqueness —
 * every identity-aware call site exempts `kind === "unsupported"` instead.
 */
export function surfaceIdentityKey(surface: WorkbenchSurfaceSpec): string {
  switch (surface.kind) {
    case "conversation":
      return `conversation:${surface.conversationId.trim()}`;
    case "fileTree":
    case "gitReview":
    case "tunnel":
    case "sshTunnel":
    case "backgroundTasks":
      return projectToolSurfaceIdentityKey(surface.kind, surface.project.projectPathKey);
    case "localTerminal":
    case "sshTerminal":
      return `terminal:${surface.surfaceId.trim()}`;
    case "unsupported":
      return `unsupported:${surface.originalKind}:`;
  }
}

export function surfaceProjectRef(surface: WorkbenchSurfaceSpec): ProjectRef | null {
  return surface.kind === "unsupported" ? null : surface.project;
}

/**
 * Per-pane view state. Currently empty — the slot is kept so persisted layouts
 * keep a stable shape and future view options have a home without a schema bump.
 */
export type PaneViewState = Record<string, never>;

export type PaneRecord = {
  paneId: string;
  surface: WorkbenchSurfaceSpec;
  view: PaneViewState;
};

export type PaneNode =
  | {
      type: "leaf";
      paneId: string;
    }
  | {
      type: "split";
      splitId: string;
      axis: WorkbenchAxis;
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

export type WorkbenchLayout = {
  schemaVersion: number;
  revision: number;
  root: PaneNode | null;
  panes: Record<string, PaneRecord>;
  focusedPaneId: string | null;
};

export function createEmptyWorkbenchLayout(): WorkbenchLayout {
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 0,
    root: null,
    panes: {},
    focusedPaneId: null,
  };
}
