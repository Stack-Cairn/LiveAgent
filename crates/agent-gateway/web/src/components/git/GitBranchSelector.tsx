import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import type {
  GitBranch as GitBranchInfo,
  GitClient,
  GitDiscoveredRepository,
  GitRepositoryState,
} from "../../lib/git/types";
import {
  emptyGitRepositoryState,
  gitDiscoveredRepositoryLabel,
  selectedGitRepositoryLabel,
} from "../../lib/git/types";
import { cn } from "../../lib/shared/utils";
import type { WorkspaceActivityClient } from "../../lib/workspace-activity/types";
import { useWorkspaceInvalidation } from "../../lib/workspace-activity/useWorkspaceInvalidation";
import {
  Check,
  ChevronRight,
  CloudDownload,
  Copy,
  Download,
  Folder,
  GitBranch,
  Github,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { useConfirmDialog } from "../ui/confirm-dialog";
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
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

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

const ACTION_MENU_BUTTON_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50";

type GitBranchRefreshOptions = {
  force?: boolean;
  silent?: boolean;
};

type GitRemoteActionKind = "" | "fetch" | "pull" | "push";

type GitBranchActionState = {
  mode: "menu" | "createFrom" | "rename";
  branch: GitBranchInfo;
};

function GitInitModal(props: {
  open: boolean;
  workdir: string;
  branch: string;
  userName: string;
  userEmail: string;
  loading: boolean;
  error: string;
  onBranchChange: (value: string) => void;
  onUserNameChange: (value: string) => void;
  onUserEmailChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const {
    open,
    workdir,
    branch,
    userName,
    userEmail,
    loading,
    error,
    onBranchChange,
    onUserNameChange,
    onUserEmailChange,
    onClose,
    onSubmit,
  } = props;
  const { t } = useLocale();
  const titleId = useId();
  const branchId = useId();
  const userNameId = useId();
  const userEmailId = useId();

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <form
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
              <GitBranch className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div id={titleId} className="text-sm font-semibold text-foreground">
                {t("git.branchSelector.initRepositoryTitle")}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("git.branchSelector.initRepositoryDescription")}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={loading}
            className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
            title={t("window.close")}
            aria-label={t("window.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t("git.branchSelector.targetDirectory")}
            </Label>
            <div
              className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-xs text-foreground"
              title={workdir}
            >
              {workdir}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={branchId} className="text-xs text-muted-foreground">
              {t("git.branchSelector.initialBranch")}
            </Label>
            <Input
              id={branchId}
              value={branch}
              onChange={(event) => onBranchChange(event.target.value)}
              className="h-9 text-xs"
              placeholder="main"
              autoFocus
              disabled={loading}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={userNameId} className="text-xs text-muted-foreground">
                {t("git.branchSelector.userNameOptional")}
              </Label>
              <Input
                id={userNameId}
                value={userName}
                onChange={(event) => onUserNameChange(event.target.value)}
                className="h-9 text-xs"
                disabled={loading}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={userEmailId} className="text-xs text-muted-foreground">
                {t("git.branchSelector.userEmailOptional")}
              </Label>
              <Input
                id={userEmailId}
                value={userEmail}
                onChange={(event) => onUserEmailChange(event.target.value)}
                className="h-9 text-xs"
                disabled={loading}
              />
            </div>
          </div>
          {error ? (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t("chat.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={loading || !branch.trim()}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {t("git.branchSelector.initRepository")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

// Per-branch action sheet opened from a branch row's "⋯" button. Lives below
// the shared ConfirmDialog (z-[120]) so delete confirmations stack above it.
function BranchActionsModal(props: {
  action: GitBranchActionState | null;
  canWrite: boolean;
  busy: boolean;
  error: string;
  draft: string;
  copied: boolean;
  onDraftChange: (value: string) => void;
  onShowCreateFrom: () => void;
  onShowRename: () => void;
  onBack: () => void;
  onCopyName: () => void;
  onDelete: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const {
    action,
    canWrite,
    busy,
    error,
    draft,
    copied,
    onDraftChange,
    onShowCreateFrom,
    onShowRename,
    onBack,
    onCopyName,
    onDelete,
    onSubmit,
    onClose,
  } = props;
  const { t } = useLocale();
  const titleId = useId();
  const inputId = useId();

  if (!action) return null;

  const { mode, branch } = action;
  const isLocal = branch.kind === "local";
  const isForm = mode !== "menu";
  const kindLabel = isLocal
    ? t("git.branchSelector.localBranches")
    : t("git.branchSelector.remoteBranches");
  const formTitle =
    mode === "rename"
      ? t("git.branchSelector.renameBranch")
      : t("git.branchSelector.createFromHere");

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={busy ? undefined : onClose}
      />
      <form
        className="relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (isForm) onSubmit();
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
              <GitBranch className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div
                id={titleId}
                className="truncate text-sm font-semibold text-foreground"
                title={branch.fullName}
              >
                {branch.fullName}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {isForm ? formTitle : kindLabel}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={busy}
            className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
            title={t("window.close")}
            aria-label={t("window.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {mode === "menu" ? (
          <div className="space-y-1 px-3 py-3">
            {canWrite ? (
              <button
                type="button"
                className={ACTION_MENU_BUTTON_CLASS}
                onClick={onShowCreateFrom}
                disabled={busy}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{t("git.branchSelector.createFromHere")}</span>
              </button>
            ) : null}
            {canWrite && isLocal ? (
              <button
                type="button"
                className={ACTION_MENU_BUTTON_CLASS}
                onClick={onShowRename}
                disabled={busy}
              >
                <Pencil className="h-3.5 w-3.5" />
                <span>{t("git.branchSelector.renameBranch")}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={ACTION_MENU_BUTTON_CLASS}
              onClick={onCopyName}
              disabled={busy}
            >
              <Copy className="h-3.5 w-3.5" />
              <span>
                {copied ? t("git.branchSelector.copied") : t("git.branchSelector.copyName")}
              </span>
            </button>
            {canWrite && isLocal && !branch.current ? (
              <button
                type="button"
                className={cn(
                  ACTION_MENU_BUTTON_CLASS,
                  "text-destructive hover:bg-destructive/10 hover:text-destructive",
                )}
                onClick={onDelete}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                <span>{t("git.branchSelector.deleteBranch")}</span>
              </button>
            ) : null}
            {error ? (
              <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4">
            {mode === "createFrom" ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("git.branchSelector.startPointLabel")}
                </Label>
                <div
                  className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-xs text-foreground"
                  title={branch.fullName}
                >
                  {branch.fullName}
                </div>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={inputId} className="text-xs text-muted-foreground">
                {formTitle}
              </Label>
              <Input
                id={inputId}
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  // Keep keystrokes local to the sheet; Escape steps back to
                  // the action list instead of dismissing the whole dialog.
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    onBack();
                  }
                }}
                placeholder={
                  mode === "rename"
                    ? t("git.branchSelector.renamePlaceholder")
                    : t("git.branchSelector.newBranchPlaceholder")
                }
                className="h-8 text-xs"
                autoFocus
                disabled={busy}
              />
            </div>
            {error ? (
              <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        )}
        {isForm ? (
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
            <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={busy}>
              {t("chat.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : mode === "rename" ? (
                <Pencil className="h-3.5 w-3.5" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {mode === "rename"
                ? t("git.branchSelector.renameBranch")
                : t("git.branchSelector.create")}
            </Button>
          </div>
        ) : null}
      </form>
    </div>,
    document.body,
  );
}

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
}) {
  const {
    workdir: workspaceCwd,
    gitClient,
    workspaceActivityClient,
    disabled,
    canWrite = true,
    disabledMessage,
    onStateChange,
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
      void runBranchMutation(() => gitClient!.switchBranch(workdir, branch.fullName, branch.kind));
    },
    [gitClient, runBranchMutation, workdir],
  );

  const createBranch = useCallback(() => {
    const name = draftBranch.trim();
    if (!name) return;
    void runBranchMutation(() => gitClient!.createBranch(workdir, name)).then((ok) => {
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
    if (!branchAction) return;
    const name = actionDraft.trim();
    if (!name) return;
    const { mode, branch } = branchAction;
    if (mode === "createFrom") {
      void runSheetMutation(() => gitClient!.createBranch(workdir, name, branch.fullName)).then(
        (ok) => {
          if (ok) resetBranchAction();
        },
      );
    } else if (mode === "rename") {
      void runSheetMutation(() => gitClient!.renameBranch(workdir, branch.fullName, name)).then(
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
    const forced = await confirm({
      title: t("git.branchSelector.deleteForceTitle"),
      description: t("git.branchSelector.deleteForceDescription"),
      confirmLabel: t("git.branchSelector.forceDelete"),
      cancelLabel: t("chat.cancel"),
      tone: "destructive",
    });
    if (!forced) return;
    const forcedOk = await runSheetMutation(() =>
      gitClient.deleteBranch(workdir, branch.fullName, true),
    );
    if (forcedOk) resetBranchAction();
  }, [branchAction, confirm, gitClient, resetBranchAction, runSheetMutation, t, workdir]);

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
      <span
        role="button"
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
      </span>
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger
          disabled={disabled || !gitClient || !workdir.trim()}
          className={cn(
            "composer-reasoning-trigger inline-flex h-8 min-w-0 max-w-[13rem] items-center gap-1 rounded-full border px-2 text-xs font-medium outline-hidden transition-colors",
            noRepo
              ? "border-transparent bg-foreground/[0.04] text-muted-foreground"
              : "border-emerald-300/25 bg-emerald-50/65 text-foreground hover:bg-emerald-50 dark:border-emerald-300/15 dark:bg-emerald-400/[0.08] dark:hover:bg-emerald-400/[0.13]",
            "disabled:pointer-events-none disabled:opacity-45",
          )}
          title={visibleError || (!canWrite ? disabledMessage : "") || label}
        >
          {loading || mutating || initializing ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
          )}
          <span className="min-w-0 truncate">{label}</span>
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
                  onClick={() => runRemoteAction("fetch", () => gitClient!.fetch(workdir))}
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
                    onClick={() => runRemoteAction("pull", () => gitClient!.pull(workdir))}
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
                    onClick={() => runRemoteAction("push", () => gitClient!.push(workdir))}
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
                        onSelect={() => void runBranchMutation(() => gitClient!.stashPush(workdir))}
                        className="gap-2 text-xs"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>{t("git.branchSelector.stashPush")}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!canWrite || mutating || state.stashCount === 0}
                        onSelect={() => void runBranchMutation(() => gitClient!.stashPop(workdir))}
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
        onSubmit={submitBranchAction}
        onClose={resetBranchAction}
      />
      {confirmDialog}
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
