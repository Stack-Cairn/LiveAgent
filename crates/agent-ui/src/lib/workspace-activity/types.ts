// Workspace activity invalidation types.
//
// Shared contract owned by @liveagent/ui. Each host supplies its own
// WorkspaceActivityClient implementation at the application boundary.

export type WorkspaceActivity = {
  workdir: string;
  revision: number;
  fs: boolean;
  git: boolean;
  changedPaths: string[];
  truncated: boolean;
};

// `{ kind: "reset" }` marks a continuity break (reconnect / resubscribe):
// events may have been missed, so consumers must treat everything as dirty.
export type WorkspaceActivityEventPayload = WorkspaceActivity | { kind: "reset" };

export type WorkspaceActivityClient = {
  subscribe(workdir: string, listener: (ev: WorkspaceActivityEventPayload) => void): () => void;
};
