export type GitDirtyCounts = {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
};

export type GitStatusEntry = {
  path: string;
  oldPath?: string | null;
  indexStatus: string;
  worktreeStatus: string;
  kind: string;
  staged: boolean;
  conflicted: boolean;
  untracked: boolean;
};

export type GitRepositoryState = {
  repoRoot: string;
  workdir: string;
  head: string;
  upstream: string;
  remoteName: string;
  remoteUrl: string;
  ahead: number;
  behind: number;
  stashCount: number;
  dirtyCounts: GitDirtyCounts;
  entries: GitStatusEntry[];
  status: "ready" | "not_repo" | "error" | string;
  error?: string | null;
};

export type GitBranch = {
  name: string;
  fullName: string;
  kind: "local" | "remote" | string;
  current: boolean;
  upstream: string;
  ahead: number;
  behind: number;
};

export type GitBranchesResponse = {
  state: GitRepositoryState;
  branches: GitBranch[];
};

export type GitDiffResponse = {
  baseRef: string;
  headRef: string;
  mode: string;
  files: string[];
  patch: string;
  stat: string;
  truncated: boolean;
  binaryFiles: string[];
};

export type GitCommitFile = {
  path: string;
  oldPath?: string | null;
  status: string;
  kind: string;
};

export type GitCommitSummary = {
  sha: string;
  shortSha: string;
  parents: string[];
  refs: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  files: GitCommitFile[];
  fileCount: number;
  localOnly: boolean;
};

export type GitLogResponse = {
  state: GitRepositoryState;
  commits: GitCommitSummary[];
  historyBaseRef: string;
  historyRemoteRef: string;
  historyAhead: number;
  historyBehind: number;
  mergeBase: string;
};

export type GitCommitDetails = {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  files: GitCommitFile[];
  fileCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  stat: string;
  remoteName: string;
  remoteUrl: string;
};

export type GitCommitDetailsResponse = {
  state: GitRepositoryState;
  commit: GitCommitDetails;
};

export type GitOperationResponse = {
  ok: boolean;
  state: GitRepositoryState;
  stdout: string;
  stderr: string;
  message: string;
};

export type GitInitOptions = {
  branch?: string;
  userName?: string;
  userEmail?: string;
};

export type GitLogOptions = {
  limit?: number;
  skip?: number;
};

export type GitDiscoveredRepository = {
  root: string;
  name: string;
  relativePath: string;
  isWorkspaceRoot: boolean;
};

export type GitRepositoryDiscovery = {
  workdir: string;
  repositories: GitDiscoveredRepository[];
};

export function gitDiscoveredRepositoryLabel(repo: GitDiscoveredRepository): string {
  return repo.isWorkspaceRoot ? repo.name : repo.relativePath || repo.name;
}

export function selectedGitRepositoryLabel(
  repositories: GitDiscoveredRepository[],
  selectedRoot: string,
): string {
  const selected = repositories.find((repo) =>
    selectedRoot === ""
      ? repo.isWorkspaceRoot
      : !repo.isWorkspaceRoot && repo.root === selectedRoot,
  );
  return selected ? gitDiscoveredRepositoryLabel(selected) : "";
}

export type GitClient = {
  status(workdir: string): Promise<GitRepositoryState>;
  discoverRepositories?(workdir: string): Promise<GitRepositoryDiscovery>;
  branches(workdir: string): Promise<GitBranchesResponse>;
  init(workdir: string, options?: GitInitOptions): Promise<GitOperationResponse>;
  switchBranch(workdir: string, branch: string, kind?: string): Promise<GitOperationResponse>;
  createBranch(workdir: string, branch: string, startPoint?: string): Promise<GitOperationResponse>;
  diff(workdir: string, mode: "branch" | "working_tree", path?: string): Promise<GitDiffResponse>;
  log(workdir: string, options?: GitLogOptions): Promise<GitLogResponse>;
  commitDetails(workdir: string, commit: string): Promise<GitCommitDetailsResponse>;
  compareCommitWithRemote(workdir: string, commit: string): Promise<GitDiffResponse>;
  commitDiff(workdir: string, commit: string, path?: string): Promise<GitDiffResponse>;
  stage(workdir: string, path: string): Promise<GitOperationResponse>;
  stageAll(workdir: string): Promise<GitOperationResponse>;
  unstage(workdir: string, path: string): Promise<GitOperationResponse>;
  unstageAll(workdir: string): Promise<GitOperationResponse>;
  discard(workdir: string, path: string, oldPath?: string | null): Promise<GitOperationResponse>;
  discardAll(workdir: string): Promise<GitOperationResponse>;
  addToGitignore(workdir: string, path: string): Promise<GitOperationResponse>;
  openSystemFileLocation(workdir: string, path: string): Promise<GitOperationResponse>;
  commit(workdir: string, message: string): Promise<GitOperationResponse>;
  fetch(workdir: string): Promise<GitOperationResponse>;
  pull(workdir: string): Promise<GitOperationResponse>;
  setRemote(workdir: string, remoteUrl: string): Promise<GitOperationResponse>;
  push(workdir: string): Promise<GitOperationResponse>;
  deleteBranch(workdir: string, branch: string, force?: boolean): Promise<GitOperationResponse>;
  renameBranch(workdir: string, branch: string, newBranch: string): Promise<GitOperationResponse>;
  stashPush(workdir: string, message?: string): Promise<GitOperationResponse>;
  stashPop(workdir: string): Promise<GitOperationResponse>;
};

const emptyCounts: GitDirtyCounts = {
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

export function normalizeGitRepositoryState(
  input: unknown,
  fallbackWorkdir = "",
): GitRepositoryState {
  const source = asObject(input);
  const dirtyCounts = asObject(source.dirtyCounts ?? source.dirty_counts);
  const entries = Array.isArray(source.entries) ? source.entries.map(normalizeGitStatusEntry) : [];
  return {
    repoRoot: asString(source.repoRoot ?? source.repo_root),
    workdir: asString(source.workdir) || fallbackWorkdir,
    head: asString(source.head),
    upstream: asString(source.upstream),
    remoteName: asString(source.remoteName ?? source.remote_name),
    remoteUrl: asString(source.remoteUrl ?? source.remote_url),
    ahead: asNumber(source.ahead),
    behind: asNumber(source.behind),
    stashCount: asNumber(source.stashCount ?? source.stash_count),
    dirtyCounts: {
      staged: asNumber(dirtyCounts.staged),
      unstaged: asNumber(dirtyCounts.unstaged),
      untracked: asNumber(dirtyCounts.untracked),
      conflicted: asNumber(dirtyCounts.conflicted),
    },
    entries,
    status: asString(source.status) || "error",
    error: asString(source.error) || null,
  };
}

export function normalizeGitStatusEntry(input: unknown): GitStatusEntry {
  const source = asObject(input);
  return {
    path: asString(source.path),
    oldPath: asString(source.oldPath ?? source.old_path) || null,
    indexStatus: asString(source.indexStatus ?? source.index_status),
    worktreeStatus: asString(source.worktreeStatus ?? source.worktree_status),
    kind: asString(source.kind),
    staged: asBoolean(source.staged),
    conflicted: asBoolean(source.conflicted),
    untracked: asBoolean(source.untracked),
  };
}

export function normalizeGitDiscoveredRepository(input: unknown): GitDiscoveredRepository {
  const source = asObject(input);
  return {
    root: asString(source.root),
    name: asString(source.name),
    relativePath: asString(source.relativePath ?? source.relative_path),
    isWorkspaceRoot: asBoolean(source.isWorkspaceRoot ?? source.is_workspace_root),
  };
}

export function normalizeGitRepositoryDiscovery(
  input: unknown,
  fallbackWorkdir = "",
): GitRepositoryDiscovery {
  const source = asObject(input);
  return {
    workdir: asString(source.workdir) || fallbackWorkdir,
    repositories: Array.isArray(source.repositories)
      ? source.repositories.map(normalizeGitDiscoveredRepository).filter((repo) => repo.root)
      : [],
  };
}

export function normalizeGitBranch(input: unknown): GitBranch {
  const source = asObject(input);
  return {
    name: asString(source.name),
    fullName: asString(source.fullName ?? source.full_name),
    kind: asString(source.kind),
    current: asBoolean(source.current),
    upstream: asString(source.upstream),
    ahead: asNumber(source.ahead),
    behind: asNumber(source.behind),
  };
}

export function normalizeGitBranchesResponse(input: unknown, workdir = ""): GitBranchesResponse {
  const source = asObject(input);
  return {
    state: normalizeGitRepositoryState(source.state, workdir),
    branches: Array.isArray(source.branches) ? source.branches.map(normalizeGitBranch) : [],
  };
}

export function normalizeGitDiffResponse(input: unknown): GitDiffResponse {
  const source = asObject(input);
  return {
    baseRef: asString(source.baseRef ?? source.base_ref),
    headRef: asString(source.headRef ?? source.head_ref),
    mode: asString(source.mode),
    files: stringArray(source.files),
    patch: asString(source.patch),
    stat: asString(source.stat),
    truncated: asBoolean(source.truncated),
    binaryFiles: stringArray(source.binaryFiles ?? source.binary_files),
  };
}

export function normalizeGitCommitFile(input: unknown): GitCommitFile {
  const source = asObject(input);
  return {
    path: asString(source.path),
    oldPath: asString(source.oldPath ?? source.old_path) || null,
    status: asString(source.status),
    kind: asString(source.kind),
  };
}

export function normalizeGitCommitSummary(input: unknown): GitCommitSummary {
  const source = asObject(input);
  const files = Array.isArray(source.files) ? source.files.map(normalizeGitCommitFile) : [];
  return {
    sha: asString(source.sha),
    shortSha: asString(source.shortSha ?? source.short_sha),
    parents: stringArray(source.parents),
    refs: stringArray(source.refs),
    subject: asString(source.subject),
    authorName: asString(source.authorName ?? source.author_name),
    authorEmail: asString(source.authorEmail ?? source.author_email),
    authorDate: asString(source.authorDate ?? source.author_date),
    files,
    fileCount: asNumber(source.fileCount ?? source.file_count) || files.length,
    localOnly: asBoolean(source.localOnly ?? source.local_only),
  };
}

export function normalizeGitLogResponse(input: unknown, workdir = ""): GitLogResponse {
  const source = asObject(input);
  const rawHistoryBaseRef = asString(source.historyBaseRef ?? source.history_base_ref);
  const hasHistoryRemoteRef =
    Object.hasOwn(source, "historyRemoteRef") || Object.hasOwn(source, "history_remote_ref");
  const rawHistoryRemoteRef = asString(source.historyRemoteRef ?? source.history_remote_ref);
  return {
    state: normalizeGitRepositoryState(source.state, workdir),
    commits: Array.isArray(source.commits) ? source.commits.map(normalizeGitCommitSummary) : [],
    historyBaseRef: hasHistoryRemoteRef ? rawHistoryBaseRef : "",
    historyRemoteRef: rawHistoryRemoteRef || rawHistoryBaseRef,
    historyAhead: asNumber(source.historyAhead ?? source.history_ahead),
    historyBehind: asNumber(source.historyBehind ?? source.history_behind),
    mergeBase: asString(source.mergeBase ?? source.merge_base),
  };
}

export function normalizeGitCommitDetails(input: unknown): GitCommitDetails {
  const source = asObject(input);
  const files = Array.isArray(source.files) ? source.files.map(normalizeGitCommitFile) : [];
  return {
    sha: asString(source.sha),
    shortSha: asString(source.shortSha ?? source.short_sha),
    subject: asString(source.subject),
    body: asString(source.body),
    authorName: asString(source.authorName ?? source.author_name),
    authorEmail: asString(source.authorEmail ?? source.author_email),
    authorDate: asString(source.authorDate ?? source.author_date),
    files,
    fileCount: asNumber(source.fileCount ?? source.file_count) || files.length,
    filesChanged: asNumber(source.filesChanged ?? source.files_changed),
    insertions: asNumber(source.insertions),
    deletions: asNumber(source.deletions),
    stat: asString(source.stat),
    remoteName: asString(source.remoteName ?? source.remote_name),
    remoteUrl: asString(source.remoteUrl ?? source.remote_url),
  };
}

export function normalizeGitCommitDetailsResponse(
  input: unknown,
  workdir = "",
): GitCommitDetailsResponse {
  const source = asObject(input);
  return {
    state: normalizeGitRepositoryState(source.state, workdir),
    commit: normalizeGitCommitDetails(source.commit),
  };
}

export function normalizeGitOperationResponse(input: unknown, workdir = ""): GitOperationResponse {
  const source = asObject(input);
  return {
    ok: asBoolean(source.ok),
    state: normalizeGitRepositoryState(source.state, workdir),
    stdout: asString(source.stdout),
    stderr: asString(source.stderr),
    message: asString(source.message),
  };
}

export function emptyGitRepositoryState(workdir = ""): GitRepositoryState {
  return {
    repoRoot: "",
    workdir,
    head: "",
    upstream: "",
    remoteName: "",
    remoteUrl: "",
    ahead: 0,
    behind: 0,
    stashCount: 0,
    dirtyCounts: emptyCounts,
    entries: [],
    status: "not_repo",
    error: null,
  };
}
