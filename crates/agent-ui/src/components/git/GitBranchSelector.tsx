import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Download,
  Folder,
  FolderTree,
  GitBranch,
  Github,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  COMPOSER_CONTROL_CHEVRON_CLASS,
  COMPOSER_CONTROL_LABEL_CLASS,
  COMPOSER_CONTROL_TRIGGER_CLASS,
} from "@liveagent/ui/lib/chat/composerControlStyles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { WorkspaceActivityClient } from "@liveagent/ui/lib/workspace-activity/types";
import { useWorkspaceInvalidation } from "@liveagent/ui/lib/workspace-activity/useWorkspaceInvalidation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranch as GitBranchInfo,
  GitClient,
  GitDiscoveredRepository,
  GitRemoveWorktreeOptions,
  GitRemoveWorktreeResponse,
  GitRepositoryState,
  GitWorktreeInfo,
} from "../../lib/git/types";
import {
  emptyGitRepositoryState,
  gitDiscoveredRepositoryLabel,
  isGitWorktreeBranchNotFullyMergedError,
  selectedGitRepositoryLabel,
} from "../../lib/git/types";
import {
  BranchActionsModal,
  type GitBranchActionState,
  GitInitModal,
  WorktreeCreateModal,
} from "./GitBranchSelectorModals";

function assertGitOperationResult(value: unknown, fallbackMessage: string) {
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

function worktreeDirectoryNameFromBranch(branch: string) {
  return branch
    .trim()
    .replace(/[\\/:]+/g, "-")
    .replace(/\s+/g, "-");
}

// Legacy fallback for environments where the async clipboard API is missing
// or rejects (insecure context, denied permission).
function fallbackCopyToClipboard(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

const GIT_BRANCH_SELECTOR_POLL_INTERVAL_MS = 3000;
const REMOTE_BRANCH_DISPLAY_LIMIT = 40;
const BRANCH_FILTER_THRESHOLD = 8;
const COPY_FEEDBACK_MS = 1500;

const HEADER_ICON_BUTTON_CLASS =
  "rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45";

type GitBranchRefreshOptions = {
  force?: boolean;
  silent?: boolean;
};

type GitRemoteActionKind = "" | "fetch" | "pull" | "push";

export function GitBranchSelector(props: {
  workdir: string;
  gitClient?: GitClient | null;
  // Push-based refresh channel; when absent the selector falls back to its
  // low-frequency poll.
  workspaceActivityClient?: WorkspaceActivityClient | null;
  disabled?: boolean;
  canWrite?: boolean;
  disabledMessage?: string;
  onStateChange?: (state: GitRepositoryState) => void;
  /** 创建 worktree 成功后，用后端返回的仓库身份与路径把工作区加入侧边栏。 */
  onOpenWorktree?: (worktree: { path: string; repositoryPath: string; branch: string }) => void;
  /** Worktree 删除成功后，让宿主清理对应的工作空间登记。 */
  onWorktreeRemoved?: (worktree: { path: string; repositoryPath: string; branch: string }) => void;
}) {
  const {
    workdir: workspaceCwd,
    gitClient,
    workspaceActivityClient,
    disabled,
    canWrite = true,
    disabledMessage,
    onStateChange,
    onOpenWorktree,
    onWorktreeRemoved,
  } = props;
  const { t } = useLocale();
  // Subdirectory repository support: when the workspace folder is not itself
  // a git repository, repositories discovered in its subdirectories can be
  // operated on instead. Both the discovered list and the picked root are
  // keyed by workspace so a workspace switch resets them during render.
  const [repoPick, setRepoPick] = useState<{ workspace: string; root: string }>(() => ({
    workspace: workspaceCwd,
    root: "",
  }));
  const [discoveredRepos, setDiscoveredRepos] = useState<{
    workspace: string;
    list: GitDiscoveredRepository[];
  }>(() => ({ workspace: workspaceCwd, list: [] }));
  if (repoPick.workspace !== workspaceCwd) {
    setRepoPick({ workspace: workspaceCwd, root: "" });
  }
  if (discoveredRepos.workspace !== workspaceCwd) {
    setDiscoveredRepos({ workspace: workspaceCwd, list: [] });
  }
  const selectedRepoRoot = repoPick.workspace === workspaceCwd ? repoPick.root : "";
  const repositories = discoveredRepos.workspace === workspaceCwd ? discoveredRepos.list : [];
  // Every git request below runs against the picked repository; the workspace
  // folder itself is the default when no subdirectory repository is picked.
  const workdir = selectedRepoRoot || workspaceCwd;
  const [state, setState] = useState<GitRepositoryState>(() => emptyGitRepositoryState(workdir));
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftBranch, setDraftBranch] = useState("");
  const [filter, setFilter] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Controlled so picking a repository can close only the submenu while the
  // root menu stays open for a manual branch pick on the new repository.
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [remoteAction, setRemoteAction] = useState<GitRemoteActionKind>("");
  const [branchAction, setBranchAction] = useState<GitBranchActionState | null>(null);
  const [actionDraft, setActionDraft] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [copiedName, setCopiedName] = useState(false);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);
  const [worktreeBranchDraft, setWorktreeBranchDraft] = useState("");
  const [worktreeDirectoryDraft, setWorktreeDirectoryDraft] = useState("");
  const [worktreeParentDirectory, setWorktreeParentDirectory] = useState("");
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [worktreeError, setWorktreeError] = useState("");
  const [initBranch, setInitBranch] = useState("main");
  const [initUserName, setInitUserName] = useState("");
  const [initUserEmail, setInitUserEmail] = useState("");
  const [initError, setInitError] = useState("");
  const [initializing, setInitializing] = useState(false);
  const refreshInFlightRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  // Mirrors actionError so the delete flow can inspect the latest failure
  // message synchronously (state updates lag behind the await).
  const actionErrorRef = useRef("");
  const copyResetTimerRef = useRef(0);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const refresh = useCallback(
    async (options: GitBranchRefreshOptions = {}) => {
      if (!gitClient || !workdir.trim()) {
        const next = emptyGitRepositoryState(workdir);
        setState(next);
        setBranches([]);
        onStateChange?.(next);
        return;
      }
      if (refreshInFlightRef.current && options.silent && !options.force) return;
      const requestId = refreshRequestIdRef.current + 1;
      refreshRequestIdRef.current = requestId;
      refreshInFlightRef.current = true;
      if (!options.silent) {
        setLoading(true);
        // Silent background refreshes must not wipe a surfaced mutation error
        // (e.g. a failed stash pop) before the user has seen it.
        setError("");
      }
      try {
        const response = await gitClient.branches(workdir);
        if (refreshRequestIdRef.current !== requestId) return;
        setState(response.state);
        setBranches(response.branches);
        setWorktrees(response.worktrees);
        onStateChange?.(response.state);
      } catch (err) {
        if (refreshRequestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : String(err));
        const next = emptyGitRepositoryState(workdir);
        setState(next);
        onStateChange?.(next);
      } finally {
        if (refreshRequestIdRef.current === requestId) {
          refreshInFlightRef.current = false;
          if (!options.silent) {
            setLoading(false);
          }
        }
      }
    },
    [gitClient, onStateChange, workdir],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      // the first discovered subdirectory repository; an explicit pick that
      // is still listed is kept.
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
        setDiscoveredRepos({ workspace, list: [] });
      }
    }
  }, [gitClient, workspaceCwd]);

  useEffect(() => {
    void discoverRepositories();
  }, [discoverRepositories]);

  const selectRepository = useCallback(
    (root: string) => {
      setRepoPick({ workspace: workspaceCwd, root });
    },
    [workspaceCwd],
  );

  useEffect(() => {
    return () => window.clearTimeout(copyResetTimerRef.current);
  }, []);

  // Push-based refresh: workspace-activity events with the git flag replace
  // both the old window-event broadcast and the constant poll.
  const handleWorkspaceInvalidate = useCallback(
    (hint: { fs: boolean; git: boolean }) => {
      if (!hint.git || !gitClient || !workdir.trim()) return;
      void refresh({ force: true, silent: true });
    },
    [gitClient, refresh, workdir],
  );

  // Invalidation stays keyed to the workspace folder: activity events cover
  // subdirectory repositories because they live inside the workspace tree.
  useWorkspaceInvalidation({
    client: gitClient ? workspaceActivityClient : null,
    workdir: workspaceCwd,
    active: true,
    onInvalidate: handleWorkspaceInvalidate,
  });

  useEffect(() => {
    if (workspaceActivityClient || !gitClient || !workdir.trim()) return;
    // No workspace-activity push channel (no-push environment): fall back to
    // the low-frequency visible poll.
    let stopped = false;
    const refreshVisibleSelector = () => {
      if (stopped || document.hidden) return;
      void refresh({ silent: true });
    };
    const interval = window.setInterval(
      refreshVisibleSelector,
      GIT_BRANCH_SELECTOR_POLL_INTERVAL_MS,
    );
    const handleFocus = () => refreshVisibleSelector();
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshVisibleSelector();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [gitClient, refresh, workdir, workspaceActivityClient]);

  const localBranches = useMemo(
    () => branches.filter((branch) => branch.kind === "local"),
    [branches],
  );
  const remoteBranches = useMemo(
    () => branches.filter((branch) => branch.kind === "remote"),
    [branches],
  );
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredLocalBranches = useMemo(
    () =>
      normalizedFilter
        ? localBranches.filter((branch) => branch.fullName.toLowerCase().includes(normalizedFilter))
        : localBranches,
    [localBranches, normalizedFilter],
  );
  const filteredRemoteBranches = useMemo(
    () =>
      normalizedFilter
        ? remoteBranches.filter((branch) =>
            branch.fullName.toLowerCase().includes(normalizedFilter),
          )
        : remoteBranches,
    [normalizedFilter, remoteBranches],
  );
  const currentUpstream = state.upstream.trim();
  const dirtyTotal =
    state.dirtyCounts.staged +
    state.dirtyCounts.unstaged +
    state.dirtyCounts.untracked +
    state.dirtyCounts.conflicted;

  const resetCreateBranch = useCallback(() => {
    setCreating(false);
    setDraftBranch("");
  }, []);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (!open) {
        resetCreateBranch();
        setFilter("");
        setRepoMenuOpen(false);
      }
    },
    [resetCreateBranch],
  );

  const runBranchMutation = useCallback(
    async (task: () => Promise<unknown>) => {
      if (!gitClient || !workdir.trim()) return;
      if (!canWrite) {
        setError(disabledMessage || t("git.branchSelector.writeDisabled"));
        return false;
      }
      setMutating(true);
      setError("");
      try {
        const result = await task();
        assertGitOperationResult(result, t("git.branchSelector.operationFailed"));
        await refresh({ force: true });
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setMutating(false);
      }
    },
    [canWrite, disabledMessage, gitClient, refresh, t, workdir],
  );

  const runRemoteAction = useCallback(
    (kind: Exclude<GitRemoteActionKind, "">, task: () => Promise<unknown>) => {
      if (remoteAction || mutating) return;
      setRemoteAction(kind);
      void runBranchMutation(task).finally(() => setRemoteAction(""));
    },
    [mutating, remoteAction, runBranchMutation],
  );

  const selectBranch = useCallback(
    (branch: GitBranchInfo) => {
      if (!gitClient) return;
      void runBranchMutation(() => gitClient.switchBranch(workdir, branch.fullName, branch.kind));
    },
    [gitClient, runBranchMutation, workdir],
  );

  const createBranch = useCallback(() => {
    const name = draftBranch.trim();
    if (!name || !gitClient) return;
    void runBranchMutation(() => gitClient.createBranch(workdir, name)).then((ok) => {
      if (!ok) return;
      // Close through the shared handler: a bare setMenuOpen(false) skips
      // onOpenChange, leaving the draft/filter cleanup behind.
      handleMenuOpenChange(false);
    });
  }, [draftBranch, gitClient, handleMenuOpenChange, runBranchMutation, workdir]);

  const resetBranchAction = useCallback(() => {
    setBranchAction(null);
    setActionDraft("");
    setActionError("");
    actionErrorRef.current = "";
    setCopiedName(false);
  }, []);

  const openBranchActions = useCallback(
    (branch: GitBranchInfo) => {
      setActionDraft("");
      setActionError("");
      actionErrorRef.current = "";
      setCopiedName(false);
      setBranchAction({ mode: "menu", branch });
      handleMenuOpenChange(false);
    },
    [handleMenuOpenChange],
  );

  const showCreateFrom = useCallback(() => {
    if (!branchAction) return;
    setActionDraft("");
    setActionError("");
    actionErrorRef.current = "";
    setBranchAction({ ...branchAction, mode: "createFrom" });
  }, [branchAction]);

  const showRename = useCallback(() => {
    if (!branchAction) return;
    setActionDraft(branchAction.branch.name);
    setActionError("");
    actionErrorRef.current = "";
    setBranchAction({ ...branchAction, mode: "rename" });
  }, [branchAction]);

  const showActionMenu = useCallback(() => {
    if (!branchAction) return;
    setActionError("");
    actionErrorRef.current = "";
    setBranchAction({ ...branchAction, mode: "menu" });
  }, [branchAction]);

  const runSheetMutation = useCallback(
    async (task: () => Promise<unknown>) => {
      if (!gitClient || !workdir.trim() || actionBusy) return false;
      if (!canWrite) {
        const message = disabledMessage || t("git.branchSelector.writeDisabled");
        actionErrorRef.current = message;
        setActionError(message);
        return false;
      }
      setActionBusy(true);
      setActionError("");
      actionErrorRef.current = "";
      try {
        const result = await task();
        assertGitOperationResult(result, t("git.branchSelector.operationFailed"));
        await refresh({ force: true });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        actionErrorRef.current = message;
        setActionError(message);
        return false;
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, canWrite, disabledMessage, gitClient, refresh, t, workdir],
  );

  const submitBranchAction = useCallback(() => {
    if (!branchAction || !gitClient) return;
    const name = actionDraft.trim();
    if (!name) return;
    const { mode, branch } = branchAction;
    if (mode === "createFrom") {
      void runSheetMutation(() => gitClient.createBranch(workdir, name, branch.fullName)).then(
        (ok) => {
          if (ok) resetBranchAction();
        },
      );
    } else if (mode === "rename") {
      void runSheetMutation(() => gitClient.renameBranch(workdir, branch.fullName, name)).then(
        (ok) => {
          if (ok) resetBranchAction();
        },
      );
    }
  }, [actionDraft, branchAction, gitClient, resetBranchAction, runSheetMutation, workdir]);

  const copyBranchName = useCallback(async () => {
    if (!branchAction) return;
    const text = branchAction.branch.fullName;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      copied = fallbackCopyToClipboard(text);
    }
    if (copied) {
      setActionError("");
      actionErrorRef.current = "";
      setCopiedName(true);
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopiedName(false), COPY_FEEDBACK_MS);
    } else {
      const message = t("git.branchSelector.copyFailed");
      actionErrorRef.current = message;
      setActionError(message);
    }
  }, [branchAction, t]);

  const confirmForceDeleteBranch = useCallback(
    async (branch: GitBranchInfo) => {
      if (!gitClient) return false;
      const forced = await confirm({
        title: t("git.branchSelector.deleteForceTitle"),
        description: t("git.branchSelector.deleteForceDescription"),
        confirmLabel: t("git.branchSelector.forceDelete"),
        cancelLabel: t("chat.cancel"),
        tone: "destructive",
      });
      if (!forced) return false;
      return runSheetMutation(() => gitClient.deleteBranch(workdir, branch.fullName, true));
    },
    [confirm, gitClient, runSheetMutation, t, workdir],
  );

  const confirmForceDeleteBranchAfterWorktreeRemoval = useCallback(
    async (branch: GitBranchInfo, controlWorkdir: string) => {
      if (!gitClient || actionBusy) return false;
      const forced = await confirm({
        title: t("git.branchSelector.deleteForceTitle"),
        description: t("git.branchSelector.deleteForceDescription"),
        confirmLabel: t("git.branchSelector.forceDelete"),
        cancelLabel: t("chat.cancel"),
        tone: "destructive",
      });
      if (!forced) return false;
      setActionBusy(true);
      setActionError("");
      actionErrorRef.current = "";
      try {
        const result = await gitClient.deleteBranch(controlWorkdir, branch.fullName, true);
        assertGitOperationResult(result, t("git.branchSelector.operationFailed"));
        setBranches((current) => current.filter((item) => item.fullName !== branch.fullName));
        setState(result.state);
        onStateChange?.(result.state);
        return true;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        actionErrorRef.current = message;
        setActionError(message);
        return false;
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, confirm, gitClient, onStateChange, t],
  );

  const deleteBranchFlow = useCallback(async () => {
    if (!branchAction || !gitClient) return;
    const { branch } = branchAction;
    const confirmed = await confirm({
      // Replacer fn: branch names may contain `$`, which a string replacement
      // pattern would expand.
      title: t("git.branchSelector.deleteConfirmTitle").replace("{branch}", () => branch.name),
      description: t("git.branchSelector.deleteConfirmDescription"),
      confirmLabel: t("git.branchSelector.deleteBranch"),
      cancelLabel: t("chat.cancel"),
      tone: "destructive",
    });
    if (!confirmed) return;
    const ok = await runSheetMutation(() => gitClient.deleteBranch(workdir, branch.fullName));
    if (ok) {
      resetBranchAction();
      return;
    }
    if (!/not fully merged/i.test(actionErrorRef.current)) return;
    const forcedOk = await confirmForceDeleteBranch(branch);
    if (forcedOk) resetBranchAction();
  }, [
    branchAction,
    confirm,
    confirmForceDeleteBranch,
    gitClient,
    resetBranchAction,
    runSheetMutation,
    t,
    workdir,
  ]);

  // 分支被 linked worktree 检出时，删除入口切换为真实 Worktree 删除。
  const checkedOutWorktree = branchAction
    ? gitClient?.removeWorktree
      ? worktrees.find((worktree) => worktree.branch === branchAction.branch.fullName)
      : undefined
    : undefined;
  const checkedOutWorktreePath = checkedOutWorktree?.path;

  const runWorktreeRemoval = useCallback(
    async (
      worktreePath: string,
      options: GitRemoveWorktreeOptions,
      refreshAfterRemoval: boolean,
    ): Promise<GitRemoveWorktreeResponse | null> => {
      if (!gitClient?.removeWorktree || !workdir.trim() || actionBusy) return null;
      if (!canWrite) {
        const message = disabledMessage || t("git.branchSelector.writeDisabled");
        actionErrorRef.current = message;
        setActionError(message);
        return null;
      }
      setActionBusy(true);
      setActionError("");
      actionErrorRef.current = "";
      try {
        const result = await gitClient.removeWorktree(workdir, worktreePath, options);
        if (result.worktreeRemoved) {
          setWorktrees((current) => current.filter((item) => item.path !== result.worktreePath));
          setState(result.state);
          onStateChange?.(result.state);
          if (refreshAfterRemoval) void refresh({ force: true });
        }
        if (!result.ok) {
          actionErrorRef.current = result.message || result.stderr;
          setActionError(result.message || result.stderr);
        }
        return result;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        actionErrorRef.current = message;
        setActionError(message);
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, canWrite, disabledMessage, gitClient, onStateChange, refresh, t, workdir],
  );

  const deleteWorktreeFlow = useCallback(async () => {
    if (!branchAction || !gitClient?.removeWorktree || !checkedOutWorktree) return;
    const { branch } = branchAction;
    const worktreePath = checkedOutWorktree.path;
    const confirmed = await confirm({
      title: t("git.branchSelector.deleteWorktreeConfirmTitle").replace(
        "{path}",
        () => worktreePath,
      ),
      description: t("git.branchSelector.deleteWorktreeConfirmDescription"),
      confirmLabel: t("git.branchSelector.deleteWorktree"),
      cancelLabel: t("chat.cancel"),
      tone: "destructive",
    });
    if (!confirmed) return;

    const deleteBranch = await confirm({
      title: t("git.branchSelector.deleteWorktreeBranchTitle").replace(
        "{branch}",
        () => branch.name,
      ),
      description: t("git.branchSelector.deleteWorktreeBranchDescription"),
      confirmLabel: t("git.branchSelector.deleteWorktreeAndBranch"),
      cancelLabel: t("git.branchSelector.keepWorktreeBranch"),
      tone: "warning",
    });

    const refreshAfterRemoval = !checkedOutWorktree.isCurrent;
    let result = await runWorktreeRemoval(worktreePath, { deleteBranch }, refreshAfterRemoval);
    if (!result) return;
    if (!result.worktreeRemoved && /contains modified or untracked files/i.test(result.message)) {
      const forced = await confirm({
        title: t("git.branchSelector.deleteWorktreeForceTitle"),
        description: t("git.branchSelector.deleteWorktreeForceDescription"),
        confirmLabel: t("git.branchSelector.forceRemoveWorktree"),
        cancelLabel: t("chat.cancel"),
        tone: "destructive",
      });
      if (!forced) return;
      result = await runWorktreeRemoval(
        worktreePath,
        { force: true, deleteBranch },
        refreshAfterRemoval,
      );
      if (!result) return;
    }
    if (!result.worktreeRemoved) return;

    if (
      result.branchDeleteRequested &&
      result.branch &&
      !result.branchDeleted &&
      isGitWorktreeBranchNotFullyMergedError(result.message)
    ) {
      const actualBranch = {
        ...branch,
        name: result.branch,
        fullName: result.branch,
      };
      const branchDeleted = await confirmForceDeleteBranchAfterWorktreeRemoval(
        actualBranch,
        result.state.repoRoot || result.mainWorktreePath,
      );
      if (!branchDeleted) setError(result.message);
    } else if (!result.ok) {
      setError(result.message || result.stderr);
    }
    onWorktreeRemoved?.({
      path: result.worktreePath,
      repositoryPath: result.mainWorktreePath,
      branch: result.branch,
    });
    resetBranchAction();
  }, [
    branchAction,
    checkedOutWorktree,
    confirm,
    confirmForceDeleteBranchAfterWorktreeRemoval,
    gitClient,
    onWorktreeRemoved,
    resetBranchAction,
    runWorktreeRemoval,
    t,
  ]);

  const openInitModal = useCallback(() => {
    setInitBranch("main");
    setInitUserName("");
    setInitUserEmail("");
    setInitError("");
    setInitModalOpen(true);
  }, []);

  const closeInitModal = useCallback(() => {
    if (initializing) return;
    setInitModalOpen(false);
    setInitError("");
  }, [initializing]);

  const initRepository = useCallback(async () => {
    if (!gitClient || !workdir.trim() || initializing) return;
    if (!canWrite) {
      setInitError(disabledMessage || t("git.branchSelector.writeDisabled"));
      return;
    }
    const branch = initBranch.trim();
    if (!branch) {
      setInitError(t("git.branchSelector.initialBranchRequired"));
      return;
    }
    setInitializing(true);
    setInitError("");
    setError("");
    try {
      const result = await gitClient.init(workdir, {
        branch,
        userName: initUserName.trim() || undefined,
        userEmail: initUserEmail.trim() || undefined,
      });
      assertGitOperationResult(result, t("git.branchSelector.operationFailed"));
      setState(result.state);
      onStateChange?.(result.state);
      await refresh({ force: true });
      setInitModalOpen(false);
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitializing(false);
    }
  }, [
    canWrite,
    disabledMessage,
    gitClient,
    initBranch,
    initUserEmail,
    initUserName,
    initializing,
    onStateChange,
    refresh,
    t,
    workdir,
  ]);

  // Worktree 起点：默认当前分支，可切换为任意本地/远程分支
  // （后端 validate_start_point 接受任意可 rev-parse 的 ref）。
  const defaultWorktreeStartPoint = state.head && state.head !== "(detached)" ? state.head : "HEAD";
  const [worktreeStartPoint, setWorktreeStartPoint] = useState("");
  const worktreeStartPointOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const branch of [...localBranches, ...remoteBranches]) {
      if (seen.has(branch.fullName)) continue;
      seen.add(branch.fullName);
      options.push(branch.fullName);
    }
    if (!seen.has(defaultWorktreeStartPoint)) options.unshift(defaultWorktreeStartPoint);
    return options;
  }, [defaultWorktreeStartPoint, localBranches, remoteBranches]);

  const handleWorktreeBranchChange = useCallback(
    (value: string) => {
      const previousAutomaticName = worktreeDirectoryNameFromBranch(worktreeBranchDraft);
      setWorktreeDirectoryDraft((current) =>
        !current || current === previousAutomaticName
          ? worktreeDirectoryNameFromBranch(value)
          : current,
      );
      setWorktreeBranchDraft(value);
    },
    [worktreeBranchDraft],
  );

  const openWorktreeModal = useCallback(() => {
    if (!gitClient?.createWorktree) return;
    setWorktreeBranchDraft("");
    setWorktreeDirectoryDraft("");
    setWorktreeParentDirectory("");
    setWorktreeError("");
    setWorktreeStartPoint(defaultWorktreeStartPoint);
    setWorktreeModalOpen(true);
    handleMenuOpenChange(false);
  }, [defaultWorktreeStartPoint, gitClient, handleMenuOpenChange]);

  const closeWorktreeModal = useCallback(() => {
    if (worktreeBusy) return;
    setWorktreeModalOpen(false);
    setWorktreeError("");
  }, [worktreeBusy]);

  const createWorktree = useCallback(() => {
    const branch = worktreeBranchDraft.trim();
    const directoryName = worktreeDirectoryDraft.trim();
    if (
      !branch ||
      !directoryName ||
      !gitClient?.createWorktree ||
      !workdir.trim() ||
      worktreeBusy
    ) {
      return;
    }
    const createWorktreeRequest = gitClient.createWorktree;
    if (!canWrite) {
      setWorktreeError(disabledMessage || t("git.branchSelector.writeDisabled"));
      return;
    }
    setWorktreeBusy(true);
    setWorktreeError("");
    void createWorktreeRequest(workdir, {
      branch,
      directoryName,
      parentDirectory: worktreeParentDirectory.trim() || undefined,
      startPoint: worktreeStartPoint,
    })
      .then((response) => {
        if (!response.ok) {
          setWorktreeError(
            response.message || response.stderr || t("git.branchSelector.worktreeFailed"),
          );
          return;
        }
        setWorktreeModalOpen(false);
        onOpenWorktree?.({
          path: response.worktreePath,
          repositoryPath: response.mainWorktreePath,
          branch: response.branch,
        });
        void refresh({ force: true });
      })
      .catch((error) => {
        setWorktreeError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setWorktreeBusy(false));
  }, [
    canWrite,
    disabledMessage,
    gitClient,
    onOpenWorktree,
    refresh,
    t,
    workdir,
    worktreeBranchDraft,
    worktreeBusy,
    worktreeDirectoryDraft,
    worktreeParentDirectory,
    worktreeStartPoint,
  ]);

  const noRepo = state.status !== "ready";
  const stateError = state.status === "error" ? state.error?.trim() || "" : "";
  const visibleError = error || stateError;
  const label = noRepo
    ? t("git.branchSelector.noRepoShort")
    : state.head || t("git.branchSelector.detached");
  const showFilter = !noRepo && branches.length > BRANCH_FILTER_THRESHOLD;
  const showSyncBadges = !noRepo && currentUpstream !== "";

  const renderBranchRow = (branch: GitBranchInfo, isCurrent: boolean, labelText: string) => (
    <DropdownMenuItem
      key={branch.fullName}
      disabled={mutating}
      onSelect={() => {
        // Guarded no-op instead of `disabled` so the row's "⋯" button stays
        // clickable on the current branch and in read-only mode.
        if (isCurrent || !canWrite) return;
        selectBranch(branch);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        openBranchActions(branch);
      }}
      className={cn(
        // active: gives touch long-press (contextmenu) visible pressed
        // feedback; on desktop it coincides with the hover highlight.
        "group/branch gap-2 text-xs active:bg-accent active:text-accent-foreground",
        (isCurrent || !canWrite) && "text-muted-foreground",
      )}
    >
      {isCurrent ? <Check className="h-3.5 w-3.5" /> : <GitBranch className="h-3.5 w-3.5" />}
      <span className="min-w-0 flex-1 truncate">{labelText}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("git.branchSelector.branchActions")}
        title={t("git.branchSelector.branchActions")}
        className="pointer-events-none ml-auto inline-flex shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/branch:pointer-events-auto group-hover/branch:opacity-100 group-data-[highlighted]/branch:pointer-events-auto group-data-[highlighted]/branch:opacity-100"
        onPointerDown={(event) => {
          // Swallow every selection trigger the menu items listen to (Base UI
          // selects on click plus mouseup for drag-release gestures, Radix on
          // pointerup) so "⋯" never switches the branch.
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerUp={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openBranchActions(branch);
        }}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              disabled={disabled || !gitClient || !workdir.trim()}
              className={cn(
                COMPOSER_CONTROL_TRIGGER_CLASS,
                "data-[popup-open]:bg-muted/60",
                noRepo && "text-muted-foreground",
              )}
            />
          }
          title={visibleError || (!canWrite ? disabledMessage : "") || label}
        >
          {loading || mutating || initializing ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className={COMPOSER_CONTROL_LABEL_CLASS}>{label}</span>
          <ChevronDown className={cn(COMPOSER_CONTROL_CHEVRON_CLASS, menuOpen && "rotate-180")} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="composer-branch-dropdown flex w-72 flex-col overflow-hidden p-0"
          side="top"
          align="start"
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-foreground">
              <Github className="h-3.5 w-3.5 shrink-0" />
              <span>Git</span>
            </div>
            {noRepo ? null : (
              <>
                <button
                  type="button"
                  className={HEADER_ICON_BUTTON_CLASS}
                  disabled={!canWrite || mutating}
                  onClick={() => {
                    if (gitClient) runRemoteAction("fetch", () => gitClient.fetch(workdir));
                  }}
                  title={!canWrite ? disabledMessage : t("git.branchSelector.fetch")}
                  aria-label={t("git.branchSelector.fetch")}
                >
                  {remoteAction === "fetch" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CloudDownload className="h-3.5 w-3.5" />
                  )}
                </button>
                <span className="relative inline-flex">
                  <button
                    type="button"
                    className={HEADER_ICON_BUTTON_CLASS}
                    disabled={!canWrite || mutating}
                    onClick={() => {
                      if (gitClient) runRemoteAction("pull", () => gitClient.pull(workdir));
                    }}
                    title={!canWrite ? disabledMessage : t("git.branchSelector.pull")}
                    aria-label={t("git.branchSelector.pull")}
                  >
                    {remoteAction === "pull" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {showSyncBadges && state.behind > 0 ? (
                    <span className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 text-[9px] font-medium leading-3 text-primary-foreground">
                      {state.behind > 9 ? "9+" : state.behind}
                    </span>
                  ) : null}
                </span>
                <span className="relative inline-flex">
                  <button
                    type="button"
                    className={HEADER_ICON_BUTTON_CLASS}
                    disabled={!canWrite || mutating}
                    onClick={() => {
                      if (gitClient) runRemoteAction("push", () => gitClient.push(workdir));
                    }}
                    title={!canWrite ? disabledMessage : t("git.branchSelector.push")}
                    aria-label={t("git.branchSelector.push")}
                  >
                    {remoteAction === "push" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {showSyncBadges && state.ahead > 0 ? (
                    <span className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 text-[9px] font-medium leading-3 text-primary-foreground">
                      {state.ahead > 9 ? "9+" : state.ahead}
                    </span>
                  ) : null}
                </span>
              </>
            )}
            <button
              type="button"
              className={HEADER_ICON_BUTTON_CLASS}
              onClick={() => {
                // Manual refresh also re-scans for repositories so ones
                // created mid-session show up.
                void discoverRepositories();
                void refresh();
              }}
              title={t("git.branchSelector.refresh")}
              aria-label={t("git.branchSelector.refresh")}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>
          {repositories.length > 1 ? (
            <div className="shrink-0 border-b border-border/60 p-1">
              <DropdownMenuSub open={repoMenuOpen} onOpenChange={setRepoMenuOpen}>
                <DropdownMenuSubTrigger
                  clickToggle
                  className="w-full gap-2 text-xs"
                  title={t("git.branchSelector.switchRepository")}
                  aria-label={t("git.branchSelector.switchRepository")}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-muted-foreground">
                    {t("git.branchSelector.repositoryLabel")}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {selectedGitRepositoryLabel(repositories, selectedRepoRoot) ||
                      t("git.branchSelector.switchRepository")}
                  </span>
                  <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                    {repositories.length}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-52">
                  {repositories.map((repo) => {
                    const value = repo.isWorkspaceRoot ? "" : repo.root;
                    const isCurrent = value === selectedRepoRoot;
                    return (
                      // Plain button (not a menu item): picking a repository
                      // must close only the submenu and keep the root menu
                      // open so the branch is still picked manually on the
                      // newly selected repository.
                      <button
                        key={repo.root}
                        type="button"
                        disabled={mutating}
                        className={cn(
                          "flex w-full cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5 text-left text-xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
                          isCurrent && "text-muted-foreground",
                        )}
                        title={repo.root}
                        onClick={(event) => {
                          // Swallow the menu selection triggers so the root
                          // menu stays open (see the footer create-branch
                          // button for the same pattern).
                          event.preventDefault();
                          event.stopPropagation();
                          setRepoMenuOpen(false);
                          if (!isCurrent) selectRepository(value);
                        }}
                      >
                        {isCurrent ? (
                          <Check className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {gitDiscoveredRepositoryLabel(repo)}
                        </span>
                      </button>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </div>
          ) : null}
          {showFilter ? (
            <div className="shrink-0 border-b border-border/60 px-2 py-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    // Keep keystrokes out of the menu typeahead; Escape clears
                    // the filter without closing the menu.
                    event.stopPropagation();
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setFilter("");
                    }
                  }}
                  placeholder={t("git.branchSelector.filterBranches")}
                  className="h-8 pl-7 text-xs"
                />
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {visibleError ? (
              <div className="px-2 py-1 text-xs text-destructive">{visibleError}</div>
            ) : null}
            {!canWrite && disabledMessage ? (
              <div className="px-2 py-1 text-xs text-muted-foreground">{disabledMessage}</div>
            ) : null}
            {noRepo && !visibleError ? (
              <>
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {t("git.branchSelector.noRepositoryFound")}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!canWrite || initializing}
                  onSelect={openInitModal}
                  className="gap-2 text-xs"
                  title={!canWrite ? disabledMessage : undefined}
                >
                  {initializing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  <span>{t("git.branchSelector.initRepository")}</span>
                </DropdownMenuItem>
              </>
            ) : noRepo ? null : (
              <>
                {filteredLocalBranches.length > 0 ? (
                  <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("git.branchSelector.localBranches")}
                  </DropdownMenuLabel>
                ) : null}
                {filteredLocalBranches.map((branch) =>
                  renderBranchRow(branch, branch.current, branch.name),
                )}
                {filteredRemoteBranches.length > 0 ? (
                  <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("git.branchSelector.remoteBranches")}
                  </DropdownMenuLabel>
                ) : null}
                {filteredRemoteBranches.slice(0, REMOTE_BRANCH_DISPLAY_LIMIT).map((branch) => {
                  const isCurrentUpstream =
                    branch.current ||
                    (currentUpstream !== "" && branch.fullName === currentUpstream);
                  return renderBranchRow(branch, isCurrentUpstream, branch.fullName);
                })}
                {filteredRemoteBranches.length > REMOTE_BRANCH_DISPLAY_LIMIT ? (
                  <div className="px-2 py-1 text-[11px] text-muted-foreground">
                    {t("git.branchSelector.moreRemoteBranches").replace(
                      "{count}",
                      String(filteredRemoteBranches.length - REMOTE_BRANCH_DISPLAY_LIMIT),
                    )}
                  </div>
                ) : null}
                {normalizedFilter &&
                filteredLocalBranches.length === 0 &&
                filteredRemoteBranches.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {t("git.branchSelector.noMatches")}
                  </div>
                ) : null}
              </>
            )}
          </div>
          {noRepo ? null : (
            <div className="shrink-0 border-t border-border/60 p-1">
              {creating ? (
                <div className="flex items-center gap-1 px-1 py-0.5">
                  <Input
                    value={draftBranch}
                    onChange={(event) => setDraftBranch(event.target.value)}
                    onKeyDown={(event) => {
                      // Keep keystrokes out of the menu: typeahead would steal
                      // focus while typing, and Escape should only discard the
                      // draft instead of closing the whole menu.
                      event.stopPropagation();
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        createBranch();
                      } else if (event.key === "Escape") {
                        resetCreateBranch();
                      }
                    }}
                    placeholder={t("git.branchSelector.newBranchPlaceholder")}
                    className="h-8 text-xs"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded bg-foreground px-2 text-xs text-background"
                    onClick={createBranch}
                  >
                    {t("git.branchSelector.create")}
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={!canWrite || mutating}
                      title={!canWrite ? disabledMessage : undefined}
                      className="relative flex min-w-0 flex-1 cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5 text-left text-xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setCreating(true);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("git.branchSelector.createNewBranch")}
                    </button>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        clickToggle
                        className="shrink-0 px-1.5 text-xs"
                        aria-label={t("git.branchSelector.moreActions")}
                        title={t("git.branchSelector.moreActions")}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-44">
                        <DropdownMenuItem
                          disabled={!canWrite || mutating || dirtyTotal === 0}
                          onSelect={() => {
                            if (gitClient) {
                              void runBranchMutation(() => gitClient.stashPush(workdir));
                            }
                          }}
                          className="gap-2 text-xs"
                        >
                          <Download className="h-3.5 w-3.5" />
                          <span>{t("git.branchSelector.stashPush")}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canWrite || mutating || state.stashCount === 0}
                          onSelect={() => {
                            if (gitClient) {
                              void runBranchMutation(() => gitClient.stashPop(workdir));
                            }
                          }}
                          className="gap-2 text-xs"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          <span>
                            {t("git.branchSelector.stashPop")}
                            {state.stashCount > 0 ? ` (${state.stashCount})` : ""}
                          </span>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </div>
                  {gitClient?.createWorktree ? (
                    <button
                      type="button"
                      disabled={!canWrite || mutating}
                      title={!canWrite ? disabledMessage : undefined}
                      className="relative flex min-w-0 w-full cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5 text-left text-xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openWorktreeModal();
                      }}
                    >
                      <FolderTree className="h-3.5 w-3.5" />
                      {t("git.branchSelector.createWorktree")}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <BranchActionsModal
        action={branchAction}
        canWrite={canWrite}
        busy={actionBusy}
        error={actionError}
        draft={actionDraft}
        copied={copiedName}
        onDraftChange={setActionDraft}
        onShowCreateFrom={showCreateFrom}
        onShowRename={showRename}
        onBack={showActionMenu}
        onCopyName={() => void copyBranchName()}
        onDelete={() => void deleteBranchFlow()}
        checkedOutWorktreePath={checkedOutWorktreePath}
        onDeleteWorktree={checkedOutWorktreePath ? () => void deleteWorktreeFlow() : undefined}
        onSubmit={submitBranchAction}
        onClose={resetBranchAction}
      />
      {confirmDialog}
      {gitClient?.createWorktree ? (
        <WorktreeCreateModal
          open={worktreeModalOpen}
          repoRoot={state.repoRoot}
          startPoint={worktreeStartPoint}
          startPointOptions={worktreeStartPointOptions}
          branch={worktreeBranchDraft}
          directoryName={worktreeDirectoryDraft}
          parentDirectory={worktreeParentDirectory}
          loading={worktreeBusy}
          error={worktreeError}
          onStartPointChange={setWorktreeStartPoint}
          onBranchChange={handleWorktreeBranchChange}
          onDirectoryNameChange={setWorktreeDirectoryDraft}
          onParentDirectoryChange={setWorktreeParentDirectory}
          onError={setWorktreeError}
          onClose={closeWorktreeModal}
          onSubmit={createWorktree}
        />
      ) : null}
      <GitInitModal
        open={initModalOpen}
        workdir={workdir.trim()}
        branch={initBranch}
        userName={initUserName}
        userEmail={initUserEmail}
        loading={initializing}
        error={initError}
        onBranchChange={setInitBranch}
        onUserNameChange={setInitUserName}
        onUserEmailChange={setInitUserEmail}
        onClose={closeInitModal}
        onSubmit={initRepository}
      />
    </>
  );
}
