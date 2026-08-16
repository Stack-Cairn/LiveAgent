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

export type PaneRecord = {
  paneId: string;
  surface: WorkbenchSurfaceSpec;
  view: {
    compactChrome?: boolean;
  };
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
