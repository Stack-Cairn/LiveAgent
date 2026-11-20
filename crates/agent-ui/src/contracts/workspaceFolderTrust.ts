/**
 * Trust decision for one project folder as the backend reports it. `workdir`
 * is the canonical folder the decision applies to; `source` is the recorded
 * folder (the folder itself or an ancestor) that decided it.
 */
export type WorkspaceFolderTrustStatus = {
  workdir: string;
  trusted: boolean;
  source?: string;
};

/**
 * Host-provided adapter for project folder trust. Trust gates project prompt
 * templates, project slash commands and other project files, and is shared
 * with the terminal UI, so changes apply immediately rather than on settings
 * save.
 */
export type WorkspaceFolderTrustClient = {
  /** Resolves false when the connected backend cannot read or change trust. */
  supported: () => Promise<boolean>;
  get: (path: string) => Promise<WorkspaceFolderTrustStatus>;
  trust: (path: string) => Promise<WorkspaceFolderTrustStatus>;
  revoke: (path: string) => Promise<WorkspaceFolderTrustStatus>;
};
