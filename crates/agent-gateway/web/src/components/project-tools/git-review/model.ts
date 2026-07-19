// GitReview model: pure types and helpers shared by the git-review modules.
//
// MIRROR NOTICE: every file under components/project-tools/git-review exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative or @tauri-apps/* imports are allowed here.

import type { GraphRow } from "../../../lib/git/gitGraph";
import type {
  GitClient,
  GitCommitDetails,
  GitCommitFile,
  GitCommitSummary,
  GitDiffResponse,
  GitLogResponse,
  GitOperationResponse,
  GitRepositoryState,
  GitStatusEntry,
} from "../../../lib/git/types";

// The desktop git client exposes `openSystemFileLocation`; the web client
// does not. The panel treats it as an optional capability and only renders
// the corresponding menu entry when the method exists.
export type GitReviewClient = GitClient & {
  openSystemFileLocation?: (workdir: string, path: string) => Promise<GitOperationResponse>;
};

export const GIT_REVIEW_SPLIT_GRID_CLASS =
  "grid-cols-[clamp(9.5rem,38%,18rem)_minmax(10rem,1fr)] grid-rows-1";

export const LARGE_DIFF_CHUNK_CHAR_LIMIT = 120 * 1024;
export const LARGE_DIFF_CHUNK_LINE_LIMIT = 1800;

export type PatchChunk = {
  key: string;
  label: string;
  chunk: string;
  lineCount: number;
  large: boolean;
};

export type DiffStatFile = {
  key: string;
  path: string;
  changes: number | null;
  additions: number;
  deletions: number;
  additionPercent: number;
  deletionPercent: number;
  binary: boolean;
  raw: string;
};

export type DiffStatSummary = {
  raw?: string;
};

export type ParsedDiffStat = {
  files: DiffStatFile[];
  fallbackLines: string[];
  summary: DiffStatSummary;
};

export type DiffViewKind = "branch" | "workingTree";
export type GitReviewMode = "changes" | "history";
export type GitReviewStackedPane = "list" | "detail";
export type GitHistoryMarkerKind = Extract<
  GraphRow["kind"],
  "incoming-changes" | "outgoing-changes"
>;
export type GitHistoryGraphState = Pick<
  GitLogResponse,
  "historyBaseRef" | "historyRemoteRef" | "historyAhead" | "historyBehind" | "mergeBase"
>;
export type GitHistoryRow =
  | {
      type: "marker";
      kind: GitHistoryMarkerKind;
      graphIndex: number;
    }
  | {
      type: "commit";
      commit: GitCommitSummary;
      graphIndex: number;
    }
  | {
      type: "file";
      commit: GitCommitSummary;
      graphIndex: number;
      file: GitCommitFile;
    }
  | {
      type: "loadMore";
    };

export type ChangeListSection = "staged" | "changes";

export type ChangeContextMenuState = {
  x: number;
  y: number;
  path: string;
  section: ChangeListSection;
};

export type HistoryContextMenuState =
  | {
      kind: "commit";
      x: number;
      y: number;
      commitSha: string;
    }
  | {
      kind: "file";
      x: number;
      y: number;
      commitSha: string;
      path: string;
    };

export type ChangesMenuState = {
  x: number;
  y: number;
  section: ChangeListSection;
};

export type GitCommitContextPayload = GitCommitDetails & {
  githubUrl?: string;
};

export type GitFileContextPayload = {
  path: string;
  oldPath?: string;
  status: string;
  commitSha: string;
  shortSha: string;
  refName: string;
  remoteName: string;
  remoteUrl: string;
  githubUrl?: string;
};

export const CHANGE_CONTEXT_MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45";
export const CONTEXT_MENU_CONTAINER_CLASS =
  "editor-context-menu select-none overflow-hidden rounded-xl border border-border/60 bg-popover/80 p-1 text-xs text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]";
export const CONTEXT_MENU_SEPARATOR_CLASS = "mx-1 my-1 h-px bg-border/60";

// Clamp a rendered context menu into its bounds using measured rects (no
// hard-coded menu dimensions). Returns the correction delta to apply to the
// menu's stored position; {0, 0} when it already fits.
export function clampMenuRectWithinRect(menuRect: DOMRect, boundsRect: DOMRect, margin: number) {
  const minLeft = boundsRect.left + margin;
  const maxLeft = Math.max(minLeft, boundsRect.right - menuRect.width - margin);
  const minTop = boundsRect.top + margin;
  const maxTop = Math.max(minTop, boundsRect.bottom - menuRect.height - margin);
  const left = Math.min(Math.max(menuRect.left, minLeft), maxLeft);
  const top = Math.min(Math.max(menuRect.top, minTop), maxTop);
  return { dx: left - menuRect.left, dy: top - menuRect.top };
}

export type GitRefreshOptions = {
  append?: boolean;
  force?: boolean;
  silent?: boolean;
};
export type GitRemoteSetupAction = "fetch" | "pull" | "push";
export type GitOperationNoticeAction =
  | GitRemoteSetupAction
  | "commit"
  | "create_branch"
  | "discard"
  | "discard_all";
export type GitOperationNotice = {
  id: number;
  kind: "success" | "error";
  title: string;
  message: string;
};
export type GitDiscardConfirmState =
  | {
      kind: "entry";
      path: string;
      oldPath?: string | null;
    }
  | {
      kind: "all";
    };
export type GitBranchFromCommitState = {
  commitSha: string;
  shortSha: string;
  subject: string;
};

export function isMissingRemoteSetupError(message: string) {
  return message.includes("找不到 origin remote") || message.includes("还没有设置远端仓库");
}

// git aborts a checkout that would clobber uncommitted local changes; the
// backend pins LC_ALL=C so the message text is stable English.
export function isCheckoutOverwriteError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("would be overwritten by checkout") ||
    lower.includes("commit your changes or stash them")
  );
}

export type GitBranchSwitchConflictState = {
  branch: string;
  kind: string;
};

export function isRemoteSetupAction(
  action: GitOperationNoticeAction,
): action is GitRemoteSetupAction {
  return action === "fetch" || action === "pull" || action === "push";
}

export function remoteSetupDescriptionKey(action: GitRemoteSetupAction) {
  if (action === "fetch") return "projectTools.gitReview.remoteSetupDescriptionFetch";
  if (action === "pull") return "projectTools.gitReview.remoteSetupDescriptionPull";
  return "projectTools.gitReview.remoteSetupDescriptionPush";
}

export function remoteSetupSubmitKey(action: GitRemoteSetupAction) {
  if (action === "fetch") return "projectTools.gitReview.remoteSetupSubmitFetch";
  if (action === "pull") return "projectTools.gitReview.remoteSetupSubmitPull";
  return "projectTools.gitReview.remoteSetupSubmitPush";
}

export function operationSuccessTitleKey(action: GitOperationNoticeAction) {
  if (action === "fetch") return "projectTools.gitReview.fetchSuccessTitle";
  if (action === "pull") return "projectTools.gitReview.pullSuccessTitle";
  if (action === "commit") return "projectTools.gitReview.commitSuccessTitle";
  if (action === "create_branch") return "projectTools.gitReview.createBranchSuccessTitle";
  if (action === "discard") return "projectTools.gitReview.discardSuccessTitle";
  if (action === "discard_all") return "projectTools.gitReview.discardAllSuccessTitle";
  return "projectTools.gitReview.pushSuccessTitle";
}

export function operationSuccessMessageKey(action: GitOperationNoticeAction) {
  if (action === "fetch") return "projectTools.gitReview.fetchSuccessMessage";
  if (action === "pull") return "projectTools.gitReview.pullSuccessMessage";
  if (action === "commit") return "projectTools.gitReview.commitSuccessMessage";
  if (action === "create_branch") return "projectTools.gitReview.createBranchSuccessMessage";
  if (action === "discard") return "projectTools.gitReview.discardSuccessMessage";
  if (action === "discard_all") return "projectTools.gitReview.discardAllSuccessMessage";
  return "projectTools.gitReview.pushSuccessMessage";
}

export function operationFailureTitleKey(action: GitOperationNoticeAction) {
  if (action === "fetch") return "projectTools.gitReview.fetchFailedTitle";
  if (action === "pull") return "projectTools.gitReview.pullFailedTitle";
  if (action === "commit") return "projectTools.gitReview.commitFailedTitle";
  if (action === "create_branch") return "projectTools.gitReview.createBranchFailedTitle";
  if (action === "discard") return "projectTools.gitReview.discardFailedTitle";
  if (action === "discard_all") return "projectTools.gitReview.discardAllFailedTitle";
  return "projectTools.gitReview.pushFailedTitle";
}

export function compactGitOperationMessage(value: string) {
  const message = value.trim();
  if (message.length <= 260) return message;
  return `${message.slice(0, 257)}...`;
}

export function splitPatchByFile(patch: string) {
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((line) => line.trim() !== "")) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

export function cleanDiffPath(value: string) {
  if (!value || value === "/dev/null") return "";
  return value.replace(/^[ab]\//, "");
}

export function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

export function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) || normalized : normalized || "Untitled";
}

export function parentPath(path: string) {
  return dirname(path) || ".";
}

export function getPatchFileNames(chunk: string, fallback: string) {
  const lines = chunk.split("\n");
  const gitHeader = lines.find((line) => line.startsWith("diff --git "));
  if (gitHeader) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(gitHeader);
    if (match) {
      return {
        oldFileName: cleanDiffPath(match[1] ?? "") || fallback,
        newFileName: cleanDiffPath(match[2] ?? "") || fallback,
      };
    }
  }
  const oldHeader = lines.find((line) => line.startsWith("--- "));
  const newHeader = lines.find((line) => line.startsWith("+++ "));
  return {
    oldFileName: cleanDiffPath(oldHeader?.slice(4).trim() ?? "") || fallback,
    newFileName: cleanDiffPath(newHeader?.slice(4).trim() ?? "") || fallback,
  };
}

export function countLines(value: string) {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export function parseDiffStatFile(line: string, index: number): DiffStatFile | null {
  const pipeIndex = line.lastIndexOf("|");
  if (pipeIndex < 0) return null;
  const path = line.slice(0, pipeIndex).trim();
  const details = line.slice(pipeIndex + 1).trim();
  if (!path || !details) return null;

  const binary = /^Bin\b/.test(details);
  if (binary) {
    return {
      key: `${path}:${index}`,
      path,
      changes: null,
      additions: 0,
      deletions: 0,
      additionPercent: 0,
      deletionPercent: 0,
      binary: true,
      raw: line,
    };
  }

  const match = /^(\d+)\s*([+-]*)/.exec(details);
  if (!match?.[1]) return null;
  const changes = Number(match[1]);
  if (!Number.isFinite(changes)) return null;
  const graph = match[2] ?? "";
  const graphAdditions = graph.split("").filter((char) => char === "+").length;
  const graphDeletions = graph.split("").filter((char) => char === "-").length;
  const graphUnits = graphAdditions + graphDeletions;
  const additions = graphUnits > 0 ? Math.round(changes * (graphAdditions / graphUnits)) : 0;
  const deletions = graphUnits > 0 ? Math.max(0, changes - additions) : 0;
  const total = additions + deletions;
  const additionPercent = total > 0 ? (additions / total) * 100 : 0;
  const deletionPercent = total > 0 ? (deletions / total) * 100 : 0;

  return {
    key: `${path}:${index}`,
    path,
    changes,
    additions,
    deletions,
    additionPercent,
    deletionPercent,
    binary: false,
    raw: line,
  };
}

export function parseDiffStat(stat: string): ParsedDiffStat {
  const lines = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  const hasSummary =
    /\bfiles? changed\b/.test(lastLine) ||
    /\binsertions?\(\+\)/.test(lastLine) ||
    /\bdeletions?\(-\)/.test(lastLine);
  const summary: DiffStatSummary = hasSummary
    ? {
        raw: lastLine,
      }
    : {};
  const fileLines = hasSummary ? lines.slice(0, -1) : lines;
  const files: DiffStatFile[] = [];
  const fallbackLines: string[] = [];
  fileLines.forEach((line, index) => {
    const file = parseDiffStatFile(line, index);
    if (file) {
      files.push(file);
    } else {
      fallbackLines.push(line);
    }
  });
  return { files, fallbackLines, summary };
}

export function buildPatchChunks(patch: string, title: string): PatchChunk[] {
  if (!patch.trim()) return [];
  return splitPatchByFile(patch).map((chunk, index) => {
    const names = getPatchFileNames(chunk, `${title}-${index + 1}`);
    const label = names.newFileName || names.oldFileName || `${title} ${index + 1}`;
    const lineCount = countLines(chunk);
    return {
      key: `${names.oldFileName}:${names.newFileName}:${index}`,
      label,
      chunk,
      lineCount,
      large: chunk.length > LARGE_DIFF_CHUNK_CHAR_LIMIT || lineCount > LARGE_DIFF_CHUNK_LINE_LIMIT,
    };
  });
}

export function statusTone(entry: GitStatusEntry) {
  if (entry.conflicted) return "text-destructive";
  if (entry.untracked) return "text-sky-600 dark:text-sky-300";
  if (isDeletedStatusEntry(entry)) return "text-rose-600 dark:text-rose-300";
  if (entry.staged) return "text-emerald-600 dark:text-emerald-300";
  return "text-amber-600 dark:text-amber-300";
}

export function isDeletedStatusEntry(entry: GitStatusEntry) {
  if (entry.untracked) return false;
  return entry.kind === "deleted" || entry.indexStatus === "D" || entry.worktreeStatus === "D";
}

export function statusLabel(entry: GitStatusEntry) {
  if (entry.conflicted) return "U";
  if (entry.untracked) return "U";
  const statuses = [entry.indexStatus, entry.worktreeStatus].filter(
    (status) => status && status !== ".",
  );
  if (entry.kind === "renamed" || statuses.includes("R")) return "R";
  if (statuses.includes("D")) return "D";
  if (statuses.includes("A")) return "A";
  if (statuses.includes("M") || statuses.includes("T")) return "M";
  return statuses[0] ?? "";
}

export function commitFileStatusTone(file: GitCommitFile) {
  const status = file.status.charAt(0).toUpperCase();
  if (status === "A") return "text-emerald-600 dark:text-emerald-300";
  if (status === "D") return "text-rose-600 dark:text-rose-300";
  if (status === "R" || status === "C") return "text-sky-600 dark:text-sky-300";
  return "text-amber-600 dark:text-amber-300";
}

export function commitFileStatusLabel(file: GitCommitFile) {
  const status = file.status.charAt(0).toUpperCase();
  return status === "R" || status === "C" || status === "A" || status === "D" ? status : "M";
}

export function formatCommitDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizeGitHubRepositoryUrl(remoteUrl: string) {
  const value = remoteUrl.trim();
  if (!value) return "";
  const sshMatch = /^git@github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/i.exec(value);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`;
  }
  try {
    const url = new URL(value);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return "";
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return "";
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (!owner || !repo) return "";
    return `https://github.com/${owner}/${repo}`;
  } catch {
    return "";
  }
}

export function gitHubCommitUrl(remoteUrl: string, sha: string) {
  const repoUrl = normalizeGitHubRepositoryUrl(remoteUrl);
  const commitSha = sha.trim();
  return repoUrl && commitSha ? `${repoUrl}/commit/${commitSha}` : "";
}

export function encodeGitHubPath(path: string) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function gitHubFileUrl(remoteUrl: string, commitSha: string, file: GitCommitFile) {
  if (file.status.charAt(0).toUpperCase() === "D") return "";
  const repoUrl = normalizeGitHubRepositoryUrl(remoteUrl);
  const sha = commitSha.trim();
  const path = encodeGitHubPath(file.path);
  return repoUrl && sha && path ? `${repoUrl}/blob/${sha}/${path}` : "";
}

export function commitContextRefName(
  commit: GitCommitSummary,
  state: Pick<GitRepositoryState, "remoteName">,
) {
  const refs = orderedCommitRefTags(commit.refs, { remoteName: state.remoteName });
  return (
    refs.find((ref) => ref.kind === "remote")?.label ||
    refs.find((ref) => ref.kind === "head")?.label ||
    refs.find((ref) => ref.kind === "branch")?.label ||
    refs[0]?.label ||
    commit.shortSha ||
    commit.sha.slice(0, 7)
  );
}

export function gitFileContextPayload(
  commit: GitCommitSummary,
  file: GitCommitFile,
  state: Pick<GitRepositoryState, "remoteName" | "remoteUrl">,
): GitFileContextPayload {
  return {
    path: file.path,
    oldPath: file.oldPath ?? undefined,
    status: file.status,
    commitSha: commit.sha,
    shortSha: commit.shortSha || commit.sha.slice(0, 7),
    refName: commitContextRefName(commit, state),
    remoteName: state.remoteName,
    remoteUrl: state.remoteUrl,
    githubUrl: gitHubFileUrl(state.remoteUrl, commit.sha, file) || undefined,
  };
}

export function defaultBranchNameForCommit(commit: Pick<GitCommitSummary, "sha" | "shortSha">) {
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  return `commit/${shortSha}`;
}

export function commitMessageText(commit: Pick<GitCommitDetails, "subject" | "body">) {
  return [commit.subject.trim(), commit.body.trim()].filter(Boolean).join("\n\n");
}

export function canStageEntry(entry: GitStatusEntry) {
  return entry.untracked || entry.conflicted || entry.worktreeStatus !== ".";
}

export function canUnstageEntry(entry: GitStatusEntry) {
  return !entry.untracked && !entry.conflicted && entry.indexStatus !== ".";
}

export function revealTargetForEntry(entry: GitStatusEntry) {
  if (!entry.untracked && (entry.indexStatus === "D" || entry.worktreeStatus === "D")) {
    return dirname(entry.oldPath ?? entry.path);
  }
  return entry.path;
}

export function writeTextToClipboard(text: string) {
  if (!text.trim()) return;
  const value = text;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).catch(() => {
      fallbackWriteTextToClipboard(value);
    });
    return;
  }
  fallbackWriteTextToClipboard(value);
}

export function fallbackWriteTextToClipboard(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function gitRepositoryStateSignature(state: GitRepositoryState) {
  const dirty = state.dirtyCounts;
  const header = [
    state.status,
    state.error ?? "",
    state.repoRoot,
    state.workdir,
    state.head,
    state.upstream,
    state.remoteName,
    state.remoteUrl,
    state.ahead,
    state.behind,
    dirty.staged,
    dirty.unstaged,
    dirty.untracked,
    dirty.conflicted,
  ].join("\x1f");
  const entries = state.entries
    .map((entry) =>
      [
        entry.path,
        entry.oldPath ?? "",
        entry.indexStatus,
        entry.worktreeStatus,
        entry.kind,
        entry.staged ? "1" : "0",
        entry.conflicted ? "1" : "0",
        entry.untracked ? "1" : "0",
      ].join("\x1e"),
    )
    .join("\x1f");
  return `${header}\x1d${entries}`;
}

// History identity deliberately excludes the repository-status signature:
// status-only churn (working-tree edits flipping dirty counts) must never
// reset the history view, its pagination or its selection. Only real commit /
// graph-ref changes count.
export function gitHistorySignature(
  commits: GitCommitSummary[],
  historyGraphState: GitHistoryGraphState,
) {
  const commitsSignature = commits
    .map((commit) =>
      [
        commit.sha,
        commit.parents.join(","),
        commit.refs.join(","),
        commit.authorDate,
        commit.subject,
        commit.fileCount,
        commit.localOnly ? "1" : "0",
        commit.files
          .map((file) => [file.path, file.oldPath ?? "", file.status, file.kind].join("\x1e"))
          .join("\x1c"),
      ].join("\x1e"),
    )
    .join("\x1f");
  return `${historyGraphState.historyBaseRef}\x1e${historyGraphState.historyRemoteRef}\x1e${historyGraphState.historyAhead}\x1e${historyGraphState.historyBehind}\x1e${historyGraphState.mergeBase}\x1c${commitsSignature}`;
}

export function gitDiffSignature(diff: GitDiffResponse) {
  return [
    diff.baseRef,
    diff.headRef,
    diff.mode,
    diff.files.join("\x1e"),
    diff.binaryFiles.join("\x1e"),
    diff.truncated ? "1" : "0",
    diff.stat,
    diff.patch,
  ].join("\x1f");
}

export function assertGitOperationResult(value: unknown, fallbackMessage: string) {
  if (!value || typeof value !== "object") return;
  const result = value as { ok?: unknown; message?: unknown; stderr?: unknown };
  if (result.ok === false) {
    const message =
      typeof result.message === "string" && result.message.trim()
        ? result.message
        : typeof result.stderr === "string" && result.stderr.trim()
          ? result.stderr
          : fallbackMessage;
    throw new Error(message);
  }
}

export type CommitRefKind = "head" | "branch" | "remote" | "tag" | "ref";

export type CommitRefTagInfo = {
  label: string;
  kind: CommitRefKind;
  title: string;
  order: number;
  index: number;
};

export type CommitRefTagOptions = {
  remoteName?: string;
};

export const COMMIT_REF_KIND_ORDER: Record<CommitRefKind, number> = {
  head: 0,
  branch: 1,
  remote: 2,
  tag: 3,
  ref: 4,
};

export const COMMIT_REF_KIND_TITLE: Record<CommitRefKind, string> = {
  head: "HEAD",
  branch: "Branch",
  remote: "Remote branch",
  tag: "Tag",
  ref: "Ref",
};

export function normalizeRefRemoteName(remoteName: string | undefined) {
  return (
    remoteName
      ?.trim()
      .replace(/^refs\/remotes\//, "")
      .replace(/\/HEAD$/, "") ?? ""
  );
}

export function isLikelyRemoteRefLabel(ref: string, remoteName: string | undefined) {
  const remote = normalizeRefRemoteName(remoteName);
  if (remote && ref.startsWith(`${remote}/`)) return true;
  return /^(origin|upstream)\//.test(ref);
}

export function commitRefTagInfo(rawRef: string, index: number, options: CommitRefTagOptions) {
  const raw = rawRef.trim();
  if (!raw) return null;

  let ref = raw;
  let isHead = false;
  let isTag = false;

  if (ref.startsWith("HEAD -> ")) {
    isHead = true;
    ref = ref.slice("HEAD -> ".length).trim();
  }

  if (ref.startsWith("tag: ")) {
    isTag = true;
    ref = ref.slice("tag: ".length).trim();
  }

  if (!ref || ref === "HEAD" || ref.endsWith("/HEAD")) return null;

  let kind: CommitRefKind = "ref";
  let label = ref;
  if (ref.startsWith("refs/heads/")) {
    kind = "branch";
    label = ref.slice("refs/heads/".length);
  } else if (ref.startsWith("refs/remotes/")) {
    kind = "remote";
    label = ref.slice("refs/remotes/".length);
  } else if (ref.startsWith("refs/tags/")) {
    kind = "tag";
    label = ref.slice("refs/tags/".length);
  } else if (isTag) {
    kind = "tag";
  } else if (isLikelyRemoteRefLabel(ref, options.remoteName)) {
    kind = "remote";
  } else {
    kind = "branch";
  }

  if (!label) return null;
  const resolvedKind = isHead ? "head" : kind;
  return {
    label,
    kind: resolvedKind,
    title: `${COMMIT_REF_KIND_TITLE[resolvedKind]}: ${label}`,
    order: COMMIT_REF_KIND_ORDER[resolvedKind],
    index,
  } satisfies CommitRefTagInfo;
}

export function orderedCommitRefTags(refs: readonly string[], options: CommitRefTagOptions = {}) {
  const orderedRefs: CommitRefTagInfo[] = [];
  const seenRefs = new Set<string>();
  refs.forEach((rawRef, index) => {
    const ref = commitRefTagInfo(rawRef, index, options);
    if (!ref) return;
    const key = `${ref.kind}\x00${ref.label}`;
    if (seenRefs.has(key)) return;
    seenRefs.add(key);
    orderedRefs.push(ref);
  });
  return orderedRefs.sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.index - right.index;
  });
}

export function orderedCommitRefs(refs: readonly string[], options: CommitRefTagOptions = {}) {
  return orderedCommitRefTags(refs, options).map((ref) => ref.label);
}

export function commitHistoryTitle(commit: GitCommitSummary) {
  const label = commit.subject || commit.shortSha;
  const refs = orderedCommitRefs(commit.refs);
  return refs.length > 0 ? `${label} - ${refs.join(", ")}` : label;
}

export function gitHistoryMarkerRef(
  kind: GitHistoryMarkerKind,
  state: Pick<GitRepositoryState, "head">,
  historyRemoteRef: string,
) {
  return kind === "outgoing-changes" ? state.head : historyRemoteRef;
}

export const EMPTY_GIT_HISTORY_GRAPH_STATE: GitHistoryGraphState = {
  historyBaseRef: "",
  historyRemoteRef: "",
  historyAhead: 0,
  historyBehind: 0,
  mergeBase: "",
};

export function gitHistoryGraphStateFromResponse(response: GitLogResponse): GitHistoryGraphState {
  return {
    historyBaseRef: response.historyBaseRef,
    historyRemoteRef: response.historyRemoteRef,
    historyAhead: response.historyAhead,
    historyBehind: response.historyBehind,
    mergeBase: response.mergeBase,
  };
}
