// GitReview data layer: repository status / diff / history fetching, request
// bookkeeping (signatures, per-workspace request epochs, interactive-over-
// silent preemption), git mutations and the push-based refresh triggers.
// Views own presentation state only.
//
// Refresh model (no polling): workspace-activity events invalidate the panel
// via useWorkspaceInvalidation (buffered while inactive, flushed on
// activation); our own mutations refresh explicitly after they land. Only
// when no activity client exists (no-push environment) does a low-frequency
// fallback poll run while the panel is active.
//
// MIRROR NOTICE: every file under components/project-tools/git-review exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative or @tauri-apps/* imports are allowed here.

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "../../../i18n";
import type {
  GitCommitDetails,
  GitCommitFile,
  GitCommitSummary,
  GitDiffResponse,
  GitDiscoveredRepository,
  GitOperationResponse,
  GitRepositoryState,
} from "../../../lib/git/types";
import { emptyGitRepositoryState } from "../../../lib/git/types";
import type { WorkspaceInvalidationHint } from "../../../lib/workspace-activity/useWorkspaceInvalidation";
import { useWorkspaceInvalidation } from "../../../lib/workspace-activity/useWorkspaceInvalidation";
import { useRightDockToolContext } from "../RightDockContext";
import {
  assertGitOperationResult,
  basename,
  compactGitOperationMessage,
  EMPTY_GIT_HISTORY_GRAPH_STATE,
  type GitBranchSwitchConflictState,
  type GitHistoryGraphState,
  type GitOperationNotice,
  type GitOperationNoticeAction,
  type GitRefreshOptions,
  type GitRemoteSetupAction,
  type GitReviewClient,
  type GitReviewMode,
  gitDiffSignature,
  gitHistoryGraphStateFromResponse,
  gitHistorySignature,
  gitRepositoryStateSignature,
  isCheckoutOverwriteError,
  isMissingRemoteSetupError,
  isRemoteSetupAction,
  operationFailureTitleKey,
  operationSuccessMessageKey,
  operationSuccessTitleKey,
} from "./model";

const GIT_HISTORY_PAGE_SIZE = 50;
const GIT_HISTORY_LOAD_MORE_SCROLL_THRESHOLD_PX = 96;
// Only used when no workspace-activity client is available (no-push
// environment): a deliberately low-frequency safety net, not a data channel.
const GIT_REVIEW_FALLBACK_POLL_INTERVAL_MS = 10_000;

const EMPTY_GIT_REPOSITORIES: GitDiscoveredRepository[] = [];

export type UseGitReviewDataOptions = {
  active: boolean;
};

export function useGitReviewData(options: UseGitReviewDataOptions) {
  const { active } = options;
  const context = useRightDockToolContext();
  const workspaceCwd = context.cwd;
  const gitClient = (context.clients.git ?? null) as GitReviewClient | null;
  const workspaceActivityClient = context.clients.workspaceActivity ?? null;
  const canWrite = context.capabilities.gitWriteEnabled;
  const disabledMessage = context.capabilities.gitDisabledMessage;
  const { t } = useLocale();

  // Subdirectory repository support (modeled on VSCode's workspace-folder
  // scanning): when the workspace folder is not itself a repository, git
  // repositories found in its subdirectories can be reviewed instead. Both
  // the discovered list and the picked root are keyed by workspace so a
  // workspace switch resets them during render, before any effect runs.
  const [repoPick, setRepoPick] = useState<{ workspace: string; root: string }>(() => ({
    workspace: workspaceCwd,
    root: "",
  }));
  const [discoveredRepos, setDiscoveredRepos] = useState<{
    workspace: string;
    list: GitDiscoveredRepository[];
  }>(() => ({ workspace: workspaceCwd, list: EMPTY_GIT_REPOSITORIES }));
  if (repoPick.workspace !== workspaceCwd) {
    setRepoPick({ workspace: workspaceCwd, root: "" });
  }
  if (discoveredRepos.workspace !== workspaceCwd) {
    setDiscoveredRepos({ workspace: workspaceCwd, list: EMPTY_GIT_REPOSITORIES });
  }
  const selectedRepoRoot = repoPick.workspace === workspaceCwd ? repoPick.root : "";
  const repositories =
    discoveredRepos.workspace === workspaceCwd ? discoveredRepos.list : EMPTY_GIT_REPOSITORIES;
  // Every git request below runs against the picked repository; the workspace
  // folder itself is the default when no subdirectory repository is picked.
  const cwd = selectedRepoRoot || workspaceCwd;

  const [state, setState] = useState<GitRepositoryState>(() => emptyGitRepositoryState(cwd));
  const [branchDiff, setBranchDiff] = useState<GitDiffResponse | null>(null);
  const [worktreeDiff, setWorktreeDiff] = useState<GitDiffResponse | null>(null);
  const [branchError, setBranchError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [remoteSetupOpen, setRemoteSetupOpen] = useState(false);
  const [remoteSetupAction, setRemoteSetupAction] = useState<GitRemoteSetupAction>("push");
  const [remoteSetupUrl, setRemoteSetupUrl] = useState("");
  const [remoteSetupError, setRemoteSetupError] = useState("");
  const [operationNotice, setOperationNotice] = useState<GitOperationNotice | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [reviewMode, setReviewMode] = useState<GitReviewMode>("changes");
  const [historyCommits, setHistoryCommits] = useState<GitCommitSummary[]>([]);
  const [historyGraphState, setHistoryGraphState] = useState<GitHistoryGraphState>(
    EMPTY_GIT_HISTORY_GRAPH_STATE,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadMoreError, setHistoryLoadMoreError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [selectedCommitSha, setSelectedCommitSha] = useState("");
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState("");
  const [expandedCommitShas, setExpandedCommitShas] = useState<Set<string>>(() => new Set());
  const [commitDiff, setCommitDiff] = useState<GitDiffResponse | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [historyDiffTitle, setHistoryDiffTitle] = useState("");
  const [historyDiffSubtitle, setHistoryDiffSubtitle] = useState("");

  const selectedPathRef = useRef("");
  const selectedCommitShaRef = useRef("");
  const selectedCommitFilePathRef = useRef("");
  const historyCommitsRef = useRef<GitCommitSummary[]>([]);
  const historyHasMoreRef = useRef(false);
  const expandedCommitShasRef = useRef<Set<string>>(new Set());
  const reviewModeRef = useRef<GitReviewMode>("changes");
  const refreshRequestIdRef = useRef(0);
  const historyRequestIdRef = useRef(0);
  const diffRequestIdRef = useRef(0);
  const diffInFlightRequestIdRef = useRef(0);
  const commitDiffRequestIdRef = useRef(0);
  const diffPathRef = useRef("");
  const commitDetailsCacheRef = useRef<Map<string, GitCommitDetails>>(new Map());
  const busyRef = useRef("");
  const statusSignatureRef = useRef("");
  const historySignatureRef = useRef("");
  const branchDiffSignatureRef = useRef("");
  const worktreeDiffSignatureRef = useRef("");
  const refreshInFlightRef = useRef(false);
  const historyInFlightRef = useRef(false);
  // Coalescing markers: a silent reload that yields to an in-flight request
  // must run again once that request settles — the in-flight one was issued
  // earlier, so its response is staler than whatever triggered the reload.
  // Dropping the reload outright would let the older response land last and
  // stick (no poll exists to heal it in push environments).
  const refreshQueuedRef = useRef(false);
  const historyQueuedRef = useRef(false);
  const diffQueuedRef = useRef(false);
  // Invalidation hints arriving while a git mutation is running are parked
  // here and flushed after the operation's own refresh, because the hint has
  // already been consumed from the tracker and would otherwise be lost.
  const pendingBusyInvalidationRef = useRef<WorkspaceInvalidationHint | null>(null);
  const operationNoticeIdRef = useRef(0);
  const statusLoadedRef = useRef(false);
  const historyLoadedRef = useRef(false);

  // Per-workspace request epoch: when cwd (or client availability) changes,
  // bump every request id during render so responses still in flight for the
  // previous workspace land as no-ops, and reset all per-workspace
  // bookkeeping before this render's effects issue new requests. React state
  // is reset in the effect below (mutating refs during render is safe).
  const cwdKey = `${cwd}\x00${gitClient ? "git" : "no-git"}`;
  const renderedCwdKeyRef = useRef(cwdKey);
  if (renderedCwdKeyRef.current !== cwdKey) {
    renderedCwdKeyRef.current = cwdKey;
    refreshRequestIdRef.current += 1;
    historyRequestIdRef.current += 1;
    diffRequestIdRef.current += 1;
    commitDiffRequestIdRef.current += 1;
    diffInFlightRequestIdRef.current = 0;
    refreshInFlightRef.current = false;
    historyInFlightRef.current = false;
    refreshQueuedRef.current = false;
    historyQueuedRef.current = false;
    diffQueuedRef.current = false;
    pendingBusyInvalidationRef.current = null;
    statusSignatureRef.current = "";
    historySignatureRef.current = "";
    branchDiffSignatureRef.current = "";
    worktreeDiffSignatureRef.current = "";
    diffPathRef.current = "";
    selectedPathRef.current = "";
    selectedCommitShaRef.current = "";
    selectedCommitFilePathRef.current = "";
    historyCommitsRef.current = [];
    historyHasMoreRef.current = false;
    expandedCommitShasRef.current = new Set();
    commitDetailsCacheRef.current = new Map();
    statusLoadedRef.current = false;
    historyLoadedRef.current = false;
  }

  const committedCwdKeyRef = useRef(cwdKey);
  useEffect(() => {
    if (committedCwdKeyRef.current === cwdKey) return;
    committedCwdKeyRef.current = cwdKey;
    setState(emptyGitRepositoryState(cwd));
    setBranchDiff(null);
    setWorktreeDiff(null);
    setBranchError("");
    setError("");
    setLoading(false);
    setDiffLoading(false);
    setSelectedPath("");
    setHistoryCommits([]);
    setHistoryGraphState(EMPTY_GIT_HISTORY_GRAPH_STATE);
    setHistoryLoading(false);
    setHistoryLoadingMore(false);
    setHistoryHasMore(false);
    setHistoryLoadMoreError("");
    setHistoryError("");
    setSelectedCommitSha("");
    setSelectedCommitFilePath("");
    setExpandedCommitShas(new Set());
    setCommitDiff(null);
    setCommitDiffLoading(false);
    setHistoryDiffTitle("");
    setHistoryDiffSubtitle("");
  }, [cwd, cwdKey]);

  const beginGitOperation = useCallback((name: string) => {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = name;
    setBusy(name);
    return true;
  }, []);

  const finishGitOperation = useCallback((name: string) => {
    if (busyRef.current !== name) {
      return;
    }
    busyRef.current = "";
    setBusy("");
  }, []);

  const isBusy = useCallback(() => busyRef.current !== "", []);

  const setHistoryHasMoreValue = useCallback((value: boolean) => {
    historyHasMoreRef.current = value;
    setHistoryHasMore(value);
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    reviewModeRef.current = reviewMode;
  }, [reviewMode]);

  useEffect(() => {
    selectedCommitShaRef.current = selectedCommitSha;
  }, [selectedCommitSha]);

  useEffect(() => {
    selectedCommitFilePathRef.current = selectedCommitFilePath;
  }, [selectedCommitFilePath]);

  useEffect(() => {
    historyCommitsRef.current = historyCommits;
  }, [historyCommits]);

  useEffect(() => {
    historyHasMoreRef.current = historyHasMore;
  }, [historyHasMore]);

  useEffect(() => {
    expandedCommitShasRef.current = expandedCommitShas;
  }, [expandedCommitShas]);

  const repoDiscoveryRequestIdRef = useRef(0);
  const discoverRepositories = useCallback(async () => {
    const requestId = ++repoDiscoveryRequestIdRef.current;
    const workspace = workspaceCwd;
    if (!gitClient?.discoverRepositories || !workspace.trim()) {
      return;
    }
    try {
      const response = await gitClient.discoverRepositories(workspace);
      if (repoDiscoveryRequestIdRef.current !== requestId) return;
      setDiscoveredRepos({ workspace, list: response.repositories });
      // When the workspace folder itself is not a repository, fall back to
      // the first discovered subdirectory repository so the panel still has
      // something to review; an explicit pick that is still listed is kept.
      setRepoPick((current) => {
        if (current.workspace !== workspace) return current;
        const hasWorkspaceRootRepo = response.repositories.some((repo) => repo.isWorkspaceRoot);
        if (
          current.root !== "" &&
          response.repositories.some((repo) => !repo.isWorkspaceRoot && repo.root === current.root)
        ) {
          return current;
        }
        const fallbackRoot = hasWorkspaceRootRepo
          ? ""
          : (response.repositories.find((repo) => !repo.isWorkspaceRoot)?.root ?? "");
        return current.root === fallbackRoot ? current : { workspace, root: fallbackRoot };
      });
    } catch {
      if (repoDiscoveryRequestIdRef.current === requestId) {
        setDiscoveredRepos({ workspace, list: EMPTY_GIT_REPOSITORIES });
      }
    }
  }, [gitClient, workspaceCwd]);

  const selectRepository = useCallback(
    (root: string) => {
      setRepoPick({ workspace: workspaceCwd, root });
    },
    [workspaceCwd],
  );

  // Discovery runs on activation and whenever the workspace changes; the
  // toolbar refresh button re-runs it explicitly to pick up newly created
  // repositories mid-session.
  useEffect(() => {
    if (!active) return;
    void discoverRepositories();
  }, [active, discoverRepositories]);

  const clearDiffs = useCallback(() => {
    diffRequestIdRef.current += 1;
    diffInFlightRequestIdRef.current = 0;
    diffQueuedRef.current = false;
    diffPathRef.current = "";
    branchDiffSignatureRef.current = "";
    worktreeDiffSignatureRef.current = "";
    setBranchDiff(null);
    setWorktreeDiff(null);
    setBranchError("");
    setDiffLoading(false);
  }, []);

  const loadDiffForPath = useCallback(
    async (path: string, options: GitRefreshOptions = {}) => {
      const cleanPath = path.trim();
      // Silent reloads never preempt anything in flight (preempting would
      // strand the interactive spinner); instead they are coalesced into one
      // queued rerun that fires after the in-flight request settles, so a
      // post-mutation reload can never lose to an older in-flight response.
      if (options.silent && diffInFlightRequestIdRef.current !== 0) {
        diffQueuedRef.current = true;
        return;
      }
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      diffInFlightRequestIdRef.current = requestId;
      diffQueuedRef.current = false;
      if (!options.silent) {
        setBranchError("");
        setError("");
      }
      if (!gitClient || !cwd.trim() || !cleanPath) {
        clearDiffs();
        return;
      }
      if (diffPathRef.current !== cleanPath) {
        branchDiffSignatureRef.current = "";
        worktreeDiffSignatureRef.current = "";
        setBranchDiff(null);
        setWorktreeDiff(null);
      }
      diffPathRef.current = cleanPath;
      if (!options.silent) {
        setDiffLoading(true);
      }
      try {
        const [branchResult, worktreeResult] = await Promise.allSettled([
          gitClient.diff(cwd, "branch", cleanPath),
          gitClient.diff(cwd, "working_tree", cleanPath),
        ]);
        if (diffRequestIdRef.current !== requestId) return;
        if (branchResult.status === "fulfilled") {
          const signature = gitDiffSignature(branchResult.value);
          if (!options.silent || branchDiffSignatureRef.current !== signature) {
            setBranchDiff(branchResult.value);
          }
          branchDiffSignatureRef.current = signature;
          setBranchError("");
        } else {
          branchDiffSignatureRef.current = "";
          setBranchDiff(null);
          setBranchError(
            branchResult.reason instanceof Error
              ? branchResult.reason.message
              : String(branchResult.reason),
          );
        }
        if (worktreeResult.status === "fulfilled") {
          const signature = gitDiffSignature(worktreeResult.value);
          if (!options.silent || worktreeDiffSignatureRef.current !== signature) {
            setWorktreeDiff(worktreeResult.value);
          }
          worktreeDiffSignatureRef.current = signature;
          setError("");
        } else {
          worktreeDiffSignatureRef.current = "";
          setWorktreeDiff(null);
          setError(
            worktreeResult.reason instanceof Error
              ? worktreeResult.reason.message
              : String(worktreeResult.reason),
          );
        }
      } catch (err) {
        if (diffRequestIdRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (diffRequestIdRef.current === requestId) {
          diffInFlightRequestIdRef.current = 0;
          if (!options.silent) {
            setDiffLoading(false);
          }
          // Drain a coalesced silent reload. The id guard above proves no
          // newer request replaced this one, so the selection is unchanged.
          if (diffQueuedRef.current) {
            diffQueuedRef.current = false;
            const queuedPath = selectedPathRef.current;
            if (queuedPath) {
              void loadDiffForPath(queuedPath, { silent: true, force: false });
            }
          }
        }
      }
    },
    [clearDiffs, cwd, gitClient],
  );

  const refresh = useCallback(
    async (options: GitRefreshOptions = {}) => {
      const silent = options.silent === true;
      const force = options.force !== false;
      // A silent refresh yields to whatever is already in flight but queues a
      // rerun for when it settles (the in-flight response is staler than this
      // refresh's trigger); an interactive one preempts it (the bumped
      // request id turns the stale response into a no-op).
      if (silent && refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
        return;
      }
      const requestId = ++refreshRequestIdRef.current;
      refreshInFlightRef.current = true;
      refreshQueuedRef.current = false;
      if (!gitClient || !cwd.trim()) {
        statusSignatureRef.current = "";
        setState(emptyGitRepositoryState(cwd));
        setSelectedPath("");
        clearDiffs();
        refreshInFlightRef.current = false;
        return;
      }
      if (!silent) {
        setLoading(true);
        setError("");
        setBranchError("");
      }
      try {
        const nextState = await gitClient.status(cwd);
        if (refreshRequestIdRef.current !== requestId) return;
        const previousSignature = statusSignatureRef.current;
        const nextSignature = gitRepositoryStateSignature(nextState);
        const stateChanged = previousSignature !== nextSignature;
        statusSignatureRef.current = nextSignature;
        if (!force && !stateChanged) {
          const currentPath = selectedPathRef.current;
          if (currentPath && reviewModeRef.current === "changes") {
            void loadDiffForPath(currentPath, { silent: true, force: false });
          }
          return;
        }
        setState(nextState);
        if (nextState.status !== "ready") {
          selectedPathRef.current = "";
          setSelectedPath("");
          clearDiffs();
          return;
        }
        const currentPath = selectedPathRef.current;
        const nextPath = nextState.entries.some((entry) => entry.path === currentPath)
          ? currentPath
          : (nextState.entries[0]?.path ?? "");
        selectedPathRef.current = nextPath;
        setSelectedPath(nextPath);
        if (nextPath) {
          // When the selection is unchanged, reload its diff silently even on
          // interactive refreshes: the signature guard keeps identical diffs
          // from re-rendering and the header spinner from flashing.
          void loadDiffForPath(nextPath, { silent: nextPath === currentPath });
        } else {
          clearDiffs();
        }
      } catch (err) {
        if (refreshRequestIdRef.current !== requestId) return;
        if (!silent || force) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (refreshRequestIdRef.current === requestId) {
          refreshInFlightRef.current = false;
          if (!silent) {
            setLoading(false);
          }
          // Drain a coalesced silent refresh that arrived while this request
          // was in flight (id guard: no newer request replaced this one).
          if (refreshQueuedRef.current) {
            refreshQueuedRef.current = false;
            void refresh({ silent: true, force: false });
          }
        }
      }
    },
    [clearDiffs, cwd, gitClient, loadDiffForPath],
  );

  const loadCommitDiff = useCallback(
    async (commitSha: string, path = "") => {
      const cleanCommit = commitSha.trim();
      const cleanPath = path.trim();
      const requestId = commitDiffRequestIdRef.current + 1;
      commitDiffRequestIdRef.current = requestId;
      setHistoryError("");
      setCommitDiff(null);
      if (!gitClient || !cwd.trim() || !cleanCommit) {
        setCommitDiffLoading(false);
        return;
      }
      setCommitDiffLoading(true);
      try {
        const diff = await gitClient.commitDiff(cwd, cleanCommit, cleanPath || undefined);
        if (commitDiffRequestIdRef.current === requestId) {
          setCommitDiff(diff);
        }
      } catch (err) {
        if (commitDiffRequestIdRef.current === requestId) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (commitDiffRequestIdRef.current === requestId) {
          setCommitDiffLoading(false);
        }
      }
    },
    [cwd, gitClient],
  );

  const clearCommitDiff = useCallback(() => {
    commitDiffRequestIdRef.current += 1;
    setCommitDiff(null);
    setCommitDiffLoading(false);
  }, []);

  const loadCommitDetails = useCallback(
    async (commitSha: string) => {
      const cleanCommit = commitSha.trim();
      const cache = commitDetailsCacheRef.current;
      const cached = cache.get(cleanCommit);
      if (cached) return cached;
      if (!gitClient || !cwd.trim() || !cleanCommit) {
        throw new Error(t("projectTools.gitReview.operationFailed"));
      }
      const response = await gitClient.commitDetails(cwd, cleanCommit);
      // Only populate the cache this request was issued against; a workspace
      // switch replaces the map, so stale responses must not leak into it.
      if (commitDetailsCacheRef.current === cache) {
        cache.set(response.commit.sha, response.commit);
        cache.set(cleanCommit, response.commit);
      }
      return response.commit;
    },
    [cwd, gitClient, t],
  );

  const resetHistorySelection = useCallback(() => {
    selectedCommitShaRef.current = "";
    selectedCommitFilePathRef.current = "";
    expandedCommitShasRef.current = new Set();
    setSelectedCommitSha("");
    setSelectedCommitFilePath("");
    setExpandedCommitShas(new Set());
    setHistoryHasMoreValue(false);
    clearCommitDiff();
  }, [clearCommitDiff, setHistoryHasMoreValue]);

  const loadHistory = useCallback(
    async (options: GitRefreshOptions = {}) => {
      const append = options.append === true && historyCommitsRef.current.length > 0;
      if (append && !historyHasMoreRef.current) {
        return;
      }
      const silent = options.silent === true;
      const force = options.force !== false;
      // Silent refreshes and appends yield to an in-flight request; an
      // interactive reload preempts it via the bumped request id. A yielded
      // silent reload is queued (not dropped): the in-flight response is
      // staler than whatever triggered it.
      if ((silent || append) && historyInFlightRef.current) {
        if (!append) {
          historyQueuedRef.current = true;
        }
        return;
      }
      const requestId = ++historyRequestIdRef.current;
      historyInFlightRef.current = true;
      if (!append) {
        historyQueuedRef.current = false;
      }
      const skip = append ? historyCommitsRef.current.length : 0;
      // Reloads keep the already-paginated window: after "load more", a
      // refresh re-requests every loaded page instead of collapsing back to
      // the first one.
      const limit = append
        ? GIT_HISTORY_PAGE_SIZE
        : Math.max(GIT_HISTORY_PAGE_SIZE, historyCommitsRef.current.length);
      if (!gitClient || !cwd.trim()) {
        historySignatureRef.current = "";
        historyCommitsRef.current = [];
        setHistoryCommits([]);
        setHistoryGraphState(EMPTY_GIT_HISTORY_GRAPH_STATE);
        resetHistorySelection();
        setHistoryLoadMoreError("");
        setHistoryLoading(false);
        setHistoryLoadingMore(false);
        setHistoryError("");
        historyInFlightRef.current = false;
        return;
      }
      if (append) {
        setHistoryLoadingMore(true);
        setHistoryLoadMoreError("");
      } else if (!silent) {
        setHistoryLoading(true);
        setHistoryError("");
        setHistoryLoadMoreError("");
        // An interactive reload preempts any in-flight append (whose finally
        // is skipped by the id guard), so its spinner must be cleared here or
        // the load-more row stays stuck in its loading state.
        setHistoryLoadingMore(false);
      }
      try {
        const response = await gitClient.log(cwd, {
          limit,
          skip,
        });
        if (historyRequestIdRef.current !== requestId) return;
        const nextHistoryGraphState = gitHistoryGraphStateFromResponse(response);
        const pageHasMore = response.commits.length >= limit;
        const previousStatusSignature = statusSignatureRef.current;
        const nextStatusSignature = gitRepositoryStateSignature(response.state);
        const statusChanged = previousStatusSignature !== nextStatusSignature;
        statusSignatureRef.current = nextStatusSignature;

        if (append) {
          setState(response.state);
          if (response.state.status !== "ready") {
            historySignatureRef.current = "";
            historyCommitsRef.current = [];
            setHistoryCommits([]);
            setHistoryGraphState(EMPTY_GIT_HISTORY_GRAPH_STATE);
            resetHistorySelection();
            return;
          }
          const existingCommits = historyCommitsRef.current;
          const existingShas = new Set(existingCommits.map((commit) => commit.sha));
          const nextCommits = [
            ...existingCommits,
            ...response.commits.filter((commit) => !existingShas.has(commit.sha)),
          ];
          // Keep the history signature in step with the widened window;
          // otherwise the next silent reload of the same commits reads as a
          // change and needlessly resets the list, the details cache and the
          // selected commit diff.
          historySignatureRef.current = gitHistorySignature(nextCommits, nextHistoryGraphState);
          historyCommitsRef.current = nextCommits;
          setHistoryCommits(nextCommits);
          setHistoryGraphState(nextHistoryGraphState);
          setHistoryHasMoreValue(pageHasMore);
          setHistoryLoadMoreError("");
          return;
        }

        // Status and history are settled independently: status-only changes
        // update the header/state, while the history list only resets when
        // commits or graph refs actually changed (see gitHistorySignature).
        const nextSignature = gitHistorySignature(response.commits, nextHistoryGraphState);
        const historyChanged = historySignatureRef.current !== nextSignature;
        historySignatureRef.current = nextSignature;
        if (historyChanged) {
          commitDetailsCacheRef.current.clear();
        }
        if (force || statusChanged) {
          setState(response.state);
        }
        setHistoryHasMoreValue(
          !force && !historyChanged && !historyHasMoreRef.current ? false : pageHasMore,
        );
        setHistoryLoadMoreError("");
        if (!force && !historyChanged) {
          return;
        }
        historyCommitsRef.current = response.commits;
        setHistoryCommits(response.commits);
        setHistoryGraphState(nextHistoryGraphState);
        if (response.state.status !== "ready" || response.commits.length === 0) {
          resetHistorySelection();
          return;
        }
        const currentCommit = response.commits.find(
          (commit) => commit.sha === selectedCommitShaRef.current,
        );
        const nextCommit = currentCommit ?? response.commits[0];
        const currentFile =
          currentCommit?.files.find((file) => file.path === selectedCommitFilePathRef.current) ??
          null;
        const availableCommitShas = new Set(response.commits.map((commit) => commit.sha));
        const nextExpandedCommitShas = new Set(
          [...expandedCommitShasRef.current].filter((sha) => availableCommitShas.has(sha)),
        );
        if (currentCommit && currentFile) {
          nextExpandedCommitShas.add(currentCommit.sha);
        }
        selectedCommitShaRef.current = nextCommit.sha;
        selectedCommitFilePathRef.current = currentFile?.path ?? "";
        expandedCommitShasRef.current = nextExpandedCommitShas;
        setSelectedCommitSha(nextCommit.sha);
        setSelectedCommitFilePath(currentFile?.path ?? "");
        setExpandedCommitShas(nextExpandedCommitShas);
        if (currentCommit && currentFile) {
          void loadCommitDiff(currentCommit.sha, currentFile.path);
        } else {
          clearCommitDiff();
        }
      } catch (err) {
        if (historyRequestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        if (append) {
          setHistoryLoadMoreError(message);
          setHistoryHasMoreValue(true);
        } else if (!silent || force) {
          historyCommitsRef.current = [];
          setHistoryCommits([]);
          setHistoryGraphState(EMPTY_GIT_HISTORY_GRAPH_STATE);
          resetHistorySelection();
          setHistoryLoadMoreError("");
          setHistoryError(message);
        }
      } finally {
        if (historyRequestIdRef.current === requestId) {
          historyInFlightRef.current = false;
          if (append) {
            setHistoryLoadingMore(false);
          } else if (!silent) {
            setHistoryLoading(false);
          }
          // Drain a coalesced silent reload that arrived while this request
          // was in flight (id guard: no newer request replaced this one).
          if (historyQueuedRef.current) {
            historyQueuedRef.current = false;
            void loadHistory({ silent: true, force: false });
          }
        }
      }
    },
    [
      clearCommitDiff,
      cwd,
      gitClient,
      loadCommitDiff,
      resetHistorySelection,
      setHistoryHasMoreValue,
    ],
  );

  const maybeLoadMoreHistory = useCallback(
    (element: HTMLElement | null, listPaneVisible: boolean) => {
      if (
        !element ||
        !listPaneVisible ||
        !historyHasMoreRef.current ||
        historyInFlightRef.current ||
        historyLoadMoreError
      ) {
        return;
      }
      const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (distanceToBottom <= GIT_HISTORY_LOAD_MORE_SCROLL_THRESHOLD_PX) {
        void loadHistory({ append: true, silent: true });
      }
    },
    [historyLoadMoreError, loadHistory],
  );

  // Visibility-gated loading: while inactive the panel issues no requests at
  // all (useWorkspaceInvalidation buffers invalidations meanwhile). The first
  // load per workspace and mode is interactive (spinner); later re-entries
  // reconcile silently and are no-ops when signatures are unchanged.
  useEffect(() => {
    if (!active) return;
    if (reviewMode === "history") {
      const silent = historyLoadedRef.current;
      historyLoadedRef.current = true;
      void loadHistory({ silent, force: false });
    } else {
      const silent = statusLoadedRef.current;
      statusLoadedRef.current = true;
      void refresh({ silent, force: false });
    }
  }, [active, loadHistory, refresh, reviewMode]);

  const handleWorkspaceInvalidate = useCallback(
    (hint: WorkspaceInvalidationHint) => {
      // The hint is already consumed from the tracker, so while one of our
      // own mutations is running it must be parked rather than dropped:
      // activity landing after the operation's follow-up refresh sampled the
      // repository would otherwise be lost for good. The park is flushed
      // right after the operation finishes.
      if (busyRef.current) {
        const pending = pendingBusyInvalidationRef.current;
        pendingBusyInvalidationRef.current = {
          fs: (pending?.fs ?? false) || hint.fs,
          git: (pending?.git ?? false) || hint.git,
        };
        return;
      }
      if (reviewModeRef.current === "history" && hint.git) {
        void loadHistory({ silent: true, force: false });
      } else {
        void refresh({ silent: true, force: false });
      }
    },
    [loadHistory, refresh],
  );

  const flushPendingBusyInvalidation = useCallback(() => {
    const pending = pendingBusyInvalidationRef.current;
    if (!pending || busyRef.current) return;
    pendingBusyInvalidationRef.current = null;
    handleWorkspaceInvalidate(pending);
  }, [handleWorkspaceInvalidate]);

  // Invalidation stays keyed to the workspace folder: activity events cover
  // subdirectory repositories because they live inside the workspace tree.
  useWorkspaceInvalidation({
    client: workspaceActivityClient,
    workdir: workspaceCwd,
    active,
    onInvalidate: handleWorkspaceInvalidate,
  });

  useEffect(() => {
    if (workspaceActivityClient || !gitClient || !cwd.trim() || !active) {
      return undefined;
    }
    // No workspace-activity push channel (no-push environment): fall back to
    // a low-frequency poll while the panel is active.
    const interval = window.setInterval(() => {
      if (busyRef.current) return;
      if (reviewModeRef.current === "history") {
        void loadHistory({ silent: true, force: false });
      } else {
        void refresh({ silent: true, force: false });
      }
    }, GIT_REVIEW_FALLBACK_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, cwd, gitClient, loadHistory, refresh, workspaceActivityClient]);

  const openRemoteSetup = useCallback((action: GitRemoteSetupAction) => {
    setRemoteSetupAction(action);
    setRemoteSetupError("");
    setRemoteSetupUrl("");
    setRemoteSetupOpen(true);
  }, []);

  const dismissOperationNotice = useCallback(() => {
    setOperationNotice(null);
  }, []);

  const showOperationNotice = useCallback(
    (kind: GitOperationNotice["kind"], action: GitOperationNoticeAction, detail?: string) => {
      const title =
        kind === "success"
          ? t(operationSuccessTitleKey(action))
          : t(operationFailureTitleKey(action));
      const message =
        kind === "success"
          ? t(operationSuccessMessageKey(action))
          : compactGitOperationMessage(detail || t("projectTools.gitReview.operationFailed"));
      setOperationNotice({
        id: ++operationNoticeIdRef.current,
        kind,
        title,
        message,
      });
    },
    [t],
  );

  const runOperation = useCallback(
    async (
      name: string,
      task: () => Promise<GitOperationResponse>,
      noticeAction?: GitOperationNoticeAction,
    ) => {
      if (!gitClient || !cwd.trim() || !canWrite || !beginGitOperation(name)) return false;
      setError("");
      if (noticeAction) {
        setOperationNotice(null);
      }
      try {
        const result = await task();
        assertGitOperationResult(result, t("projectTools.gitReview.operationFailed"));
        await refresh();
        if (reviewModeRef.current === "history") {
          await loadHistory();
        }
        if (noticeAction) {
          showOperationNotice("success", noticeAction);
        }
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          noticeAction &&
          isRemoteSetupAction(noticeAction) &&
          isMissingRemoteSetupError(message)
        ) {
          openRemoteSetup(noticeAction);
          return false;
        }
        if (noticeAction) {
          showOperationNotice("error", noticeAction, message);
        }
        setError(message);
        return false;
      } finally {
        finishGitOperation(name);
        flushPendingBusyInvalidation();
      }
    },
    [
      beginGitOperation,
      canWrite,
      cwd,
      finishGitOperation,
      flushPendingBusyInvalidation,
      gitClient,
      loadHistory,
      openRemoteSetup,
      refresh,
      showOperationNotice,
      t,
    ],
  );

  const [branchSwitchConflict, setBranchSwitchConflict] =
    useState<GitBranchSwitchConflictState | null>(null);

  const dismissBranchSwitchConflict = useCallback(() => {
    if (busyRef.current) return;
    setBranchSwitchConflict(null);
  }, []);

  // Dedicated switch flow (not runOperation): a checkout aborted because it
  // would clobber uncommitted changes surfaces as an actionable stash-and-
  // switch prompt instead of a raw git error.
  const switchBranch = useCallback(
    async (branch: string, kind?: string) => {
      const operationName = "switch_branch";
      if (!gitClient || !cwd.trim() || !canWrite || !beginGitOperation(operationName)) return false;
      setError("");
      try {
        const result = await gitClient.switchBranch(cwd, branch, kind);
        assertGitOperationResult(result, t("projectTools.gitReview.operationFailed"));
        await refresh();
        if (reviewModeRef.current === "history") {
          await loadHistory();
        }
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isCheckoutOverwriteError(message)) {
          setBranchSwitchConflict({ branch, kind: kind ?? "" });
        } else {
          setError(message);
        }
        return false;
      } finally {
        finishGitOperation(operationName);
        flushPendingBusyInvalidation();
      }
    },
    [
      beginGitOperation,
      canWrite,
      cwd,
      finishGitOperation,
      flushPendingBusyInvalidation,
      gitClient,
      loadHistory,
      refresh,
      t,
    ],
  );

  const stashAndSwitchBranch = useCallback(async () => {
    const conflict = branchSwitchConflict;
    const operationName = "switch_branch";
    if (!conflict || !gitClient || !cwd.trim() || !canWrite || !beginGitOperation(operationName))
      return false;
    setError("");
    try {
      const stashed = await gitClient.stashPush(cwd);
      assertGitOperationResult(stashed, t("projectTools.gitReview.operationFailed"));
      const switched = await gitClient.switchBranch(
        cwd,
        conflict.branch,
        conflict.kind || undefined,
      );
      assertGitOperationResult(switched, t("projectTools.gitReview.operationFailed"));
      setBranchSwitchConflict(null);
      await refresh();
      if (reviewModeRef.current === "history") {
        await loadHistory();
      }
      return true;
    } catch (err) {
      setBranchSwitchConflict(null);
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      finishGitOperation(operationName);
      flushPendingBusyInvalidation();
    }
  }, [
    beginGitOperation,
    branchSwitchConflict,
    canWrite,
    cwd,
    finishGitOperation,
    flushPendingBusyInvalidation,
    gitClient,
    loadHistory,
    refresh,
    t,
  ]);

  const closeRemoteSetup = useCallback(() => {
    if (busyRef.current) return;
    setRemoteSetupOpen(false);
    setRemoteSetupError("");
  }, []);

  const saveRemoteAndContinue = useCallback(async () => {
    const operationName = "set_remote";
    if (!gitClient || !cwd.trim() || !canWrite || !beginGitOperation(operationName)) return false;
    const remoteUrl = remoteSetupUrl.trim();
    if (!remoteUrl) {
      finishGitOperation(operationName);
      setRemoteSetupError(t("projectTools.gitReview.remoteUrlRequired"));
      return false;
    }
    setError("");
    setRemoteSetupError("");
    setOperationNotice(null);
    try {
      const remoteResult = await gitClient.setRemote(cwd, remoteUrl);
      assertGitOperationResult(remoteResult, t("projectTools.gitReview.operationFailed"));
      const operationResult =
        remoteSetupAction === "fetch"
          ? await gitClient.fetch(cwd)
          : remoteSetupAction === "pull"
            ? await gitClient.pull(cwd)
            : await gitClient.push(cwd);
      assertGitOperationResult(operationResult, t("projectTools.gitReview.operationFailed"));
      setRemoteSetupOpen(false);
      setRemoteSetupUrl("");
      await refresh();
      if (reviewModeRef.current === "history") {
        await loadHistory();
      }
      showOperationNotice("success", remoteSetupAction);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRemoteSetupError(message);
      showOperationNotice("error", remoteSetupAction, message);
      return false;
    } finally {
      finishGitOperation(operationName);
      flushPendingBusyInvalidation();
    }
  }, [
    beginGitOperation,
    canWrite,
    cwd,
    finishGitOperation,
    flushPendingBusyInvalidation,
    gitClient,
    loadHistory,
    refresh,
    remoteSetupAction,
    remoteSetupUrl,
    showOperationNotice,
    t,
  ]);

  const selectPath = useCallback(
    (path: string) => {
      selectedPathRef.current = path;
      setSelectedPath(path);
      void loadDiffForPath(path);
    },
    [loadDiffForPath],
  );

  const selectCommitRow = useCallback(
    (commit: GitCommitSummary) => {
      selectedCommitShaRef.current = commit.sha;
      selectedCommitFilePathRef.current = "";
      setSelectedCommitSha(commit.sha);
      setSelectedCommitFilePath("");
      clearCommitDiff();
      setHistoryDiffTitle("");
      setHistoryDiffSubtitle("");
      setHistoryError("");
      // Compute-then-set: the ref is the source of truth and state updaters
      // must stay pure (StrictMode double-invokes them).
      const next = new Set(expandedCommitShasRef.current);
      if (next.has(commit.sha)) {
        next.delete(commit.sha);
      } else {
        next.add(commit.sha);
      }
      expandedCommitShasRef.current = next;
      setExpandedCommitShas(next);
    },
    [clearCommitDiff],
  );

  const selectCommitFileData = useCallback(
    (commit: GitCommitSummary, file: GitCommitFile) => {
      selectedCommitShaRef.current = commit.sha;
      selectedCommitFilePathRef.current = file.path;
      const nextExpandedCommitShas = new Set(expandedCommitShasRef.current);
      nextExpandedCommitShas.add(commit.sha);
      expandedCommitShasRef.current = nextExpandedCommitShas;
      setSelectedCommitSha(commit.sha);
      setSelectedCommitFilePath(file.path);
      setHistoryDiffTitle(t("projectTools.gitReview.commitDiff"));
      setHistoryDiffSubtitle(
        `${basename(file.path)} - ${commit.shortSha || commit.sha.slice(0, 7)}`,
      );
      setExpandedCommitShas(nextExpandedCommitShas);
      void loadCommitDiff(commit.sha, file.path);
    },
    [loadCommitDiff, t],
  );

  const focusCommitData = useCallback(
    (commit: GitCommitSummary) => {
      selectedCommitShaRef.current = commit.sha;
      selectedCommitFilePathRef.current = "";
      setSelectedCommitSha(commit.sha);
      setSelectedCommitFilePath("");
      clearCommitDiff();
      setHistoryDiffTitle("");
      setHistoryDiffSubtitle("");
      setHistoryError("");
      // Compute-then-set (see selectCommitRow); keep the identity stable when
      // the commit is already expanded so memoized rows don't re-render.
      const current = expandedCommitShasRef.current;
      if (!current.has(commit.sha)) {
        const next = new Set(current);
        next.add(commit.sha);
        expandedCommitShasRef.current = next;
        setExpandedCommitShas(next);
      }
    },
    [clearCommitDiff],
  );

  const openCommitDiffData = useCallback(
    (commit: GitCommitSummary) => {
      focusCommitData(commit);
      setHistoryDiffTitle(t("projectTools.gitReview.commitDiff"));
      setHistoryDiffSubtitle(`${commit.shortSha || commit.sha.slice(0, 7)} - ${commit.subject}`);
      void loadCommitDiff(commit.sha);
    },
    [focusCommitData, loadCommitDiff, t],
  );

  const compareCommitWithRemote = useCallback(
    (commit: GitCommitSummary) => {
      if (!gitClient || !cwd.trim()) return;
      focusCommitData(commit);
      const requestId = commitDiffRequestIdRef.current + 1;
      commitDiffRequestIdRef.current = requestId;
      setHistoryDiffTitle(t("projectTools.gitReview.remoteCompare"));
      setHistoryDiffSubtitle(
        `${state.upstream || "remote"} ↔ ${commit.shortSha || commit.sha.slice(0, 7)}`,
      );
      setHistoryError("");
      setCommitDiff(null);
      setCommitDiffLoading(true);
      void gitClient
        .compareCommitWithRemote(cwd, commit.sha)
        .then((diff) => {
          if (commitDiffRequestIdRef.current !== requestId) return;
          setCommitDiff(diff);
          setHistoryDiffSubtitle(`${diff.baseRef} ↔ ${commit.shortSha || commit.sha.slice(0, 7)}`);
        })
        .catch((err) => {
          if (commitDiffRequestIdRef.current !== requestId) return;
          setHistoryError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (commitDiffRequestIdRef.current === requestId) {
            setCommitDiffLoading(false);
          }
        });
    },
    [cwd, focusCommitData, gitClient, state.upstream, t],
  );

  return {
    branchDiff,
    branchError,
    branchSwitchConflict,
    busy,
    canWrite,
    closeRemoteSetup,
    commitDiff,
    commitDiffLoading,
    compareCommitWithRemote,
    cwd,
    diffLoading,
    disabledMessage,
    discoverRepositories,
    dismissBranchSwitchConflict,
    dismissOperationNotice,
    error,
    expandedCommitShas,
    focusCommitData,
    gitClient,
    historyCommits,
    historyDiffSubtitle,
    historyDiffTitle,
    historyError,
    historyGraphState,
    historyHasMore,
    historyLoadMoreError,
    historyLoading,
    historyLoadingMore,
    isBusy,
    loadCommitDetails,
    loadHistory,
    loading,
    maybeLoadMoreHistory,
    openCommitDiffData,
    operationNotice,
    refresh,
    remoteSetupAction,
    remoteSetupError,
    remoteSetupOpen,
    remoteSetupUrl,
    repositories,
    reviewMode,
    runOperation,
    saveRemoteAndContinue,
    selectCommitFileData,
    selectCommitRow,
    selectPath,
    selectRepository,
    selectedCommitFilePath,
    selectedCommitSha,
    selectedPath,
    selectedRepoRoot,
    setError,
    setHistoryError,
    setRemoteSetupUrl,
    setReviewMode,
    stashAndSwitchBranch,
    state,
    switchBranch,
    workspaceCwd,
    worktreeDiff,
  };
}

export type GitReviewData = ReturnType<typeof useGitReviewData>;
