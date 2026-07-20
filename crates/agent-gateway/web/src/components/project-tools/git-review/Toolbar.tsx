// GitReview toolbar: panel header (branch summary, remote actions, counters,
// mode/pane switchers) plus the modal dialogs and the operation toast shared
// by the status and history views.
//
// MIRROR NOTICE: every file under components/project-tools/git-review exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative or @tauri-apps/* imports are allowed here.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../../i18n";
import type { GitBranch as GitBranchInfo } from "../../../lib/git/types";
import { gitDiscoveredRepositoryLabel, selectedGitRepositoryLabel } from "../../../lib/git/types";
import { cn } from "../../../lib/shared/utils";
import {
  AlertTriangle,
  BrushCleaning,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Download,
  Eye,
  Folder,
  GitBranch,
  History,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
  XCircle,
} from "../../icons";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Input } from "../../ui/input";
import { useRightDockToolContext } from "../RightDockContext";
import {
  type GitBranchFromCommitState,
  type GitBranchSwitchConflictState,
  type GitDiscardConfirmState,
  type GitOperationNotice,
  type GitRemoteSetupAction,
  type GitReviewStackedPane,
  remoteSetupDescriptionKey,
  remoteSetupSubmitKey,
} from "./model";
import type { GitReviewData } from "./useGitReviewData";

const GIT_REVIEW_STACKED_PANE_BUTTON_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function GitRemoteSetupModal(props: {
  open: boolean;
  action: GitRemoteSetupAction;
  workdir: string;
  branch: string;
  remoteUrl: string;
  loading: boolean;
  error: string;
  onRemoteUrlChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const {
    open,
    action,
    workdir,
    branch,
    remoteUrl,
    loading,
    error,
    onRemoteUrlChange,
    onClose,
    onSubmit,
  } = props;
  const { t } = useLocale();
  const titleId = useId();
  const remoteUrlId = useId();

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
        <div className="border-b border-border/60 px-5 py-4">
          <div id={titleId} className="text-sm font-semibold text-foreground">
            {t("projectTools.gitReview.remoteSetupTitle")}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(remoteSetupDescriptionKey(action))}
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div
              className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2"
              title={branch}
            >
              {branch}
            </div>
            <div
              className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2"
              title={workdir}
            >
              {workdir}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={remoteUrlId} className="text-xs text-muted-foreground">
              {t("projectTools.gitReview.remoteUrl")}
            </label>
            <Input
              id={remoteUrlId}
              value={remoteUrl}
              onChange={(event) => onRemoteUrlChange(event.target.value)}
              className="h-9 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))]"
              placeholder={t("projectTools.gitReview.remoteUrlPlaceholder")}
              autoFocus
              disabled={loading}
            />
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
          <Button type="submit" size="sm" disabled={loading || !remoteUrl.trim()}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : action === "push" ? (
              <Upload className="h-3.5 w-3.5" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t(remoteSetupSubmitKey(action))}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function GitDiscardConfirmModal(props: {
  target: GitDiscardConfirmState | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { target, loading, onClose, onConfirm } = props;
  const { t } = useLocale();
  const titleId = useId();

  if (!target) return null;

  const isAll = target.kind === "all";
  const title = isAll
    ? t("projectTools.gitReview.discardAllChanges")
    : t("projectTools.gitReview.discardChanges");
  const description = isAll
    ? t("projectTools.gitReview.discardAllConfirm")
    : t("projectTools.gitReview.discardConfirm").replace("{path}", target.path);

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
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </div>
          <div className="min-w-0 flex-1">
            <div id={titleId} className="text-sm font-semibold text-foreground">
              {title}
            </div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t("chat.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isAll ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : (
              <BrushCleaning className="h-3.5 w-3.5" />
            )}
            {title}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function GitBranchFromCommitModal(props: {
  target: GitBranchFromCommitState | null;
  branchName: string;
  loading: boolean;
  error: string;
  onBranchNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { target, branchName, loading, error, onBranchNameChange, onClose, onSubmit } = props;
  const { t } = useLocale();
  const titleId = useId();
  const branchNameId = useId();

  if (!target) return null;

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
        <div className="border-b border-border/60 px-5 py-4">
          <div id={titleId} className="text-sm font-semibold text-foreground">
            {t("projectTools.gitReview.createBranchFromCommitTitle")}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("projectTools.gitReview.createBranchFromCommitDescription")
              .replace("{sha}", target.shortSha)
              .replace("{subject}", target.subject || target.shortSha)}
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="font-mono text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
              {target.shortSha}
            </div>
            <div className="mt-1 truncate font-medium" title={target.subject}>
              {target.subject || target.commitSha}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={branchNameId} className="text-xs text-muted-foreground">
              {t("projectTools.gitReview.branchName")}
            </label>
            <Input
              id={branchNameId}
              value={branchName}
              onChange={(event) => onBranchNameChange(event.target.value)}
              className="h-9 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))]"
              placeholder={t("projectTools.gitReview.branchNamePlaceholder")}
              autoFocus
              disabled={loading}
            />
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
          <Button type="submit" size="sm" disabled={loading || !branchName.trim()}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {t("projectTools.gitReview.createBranch")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function GitOperationNoticeToast({
  notice,
  onDismiss,
}: {
  notice: GitOperationNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, notice.kind === "success" ? 4200 : 7000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice) return null;

  const isSuccess = notice.kind === "success";
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-50 flex max-w-[calc(100%-1.5rem)] justify-end">
      <div
        role={isSuccess ? "status" : "alert"}
        aria-live={isSuccess ? "polite" : "assertive"}
        className={cn(
          "pointer-events-auto flex w-80 max-w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-lg backdrop-blur-xl",
          isSuccess
            ? "border-emerald-500/25 bg-emerald-50/95 text-emerald-900 dark:bg-emerald-950/85 dark:text-emerald-100"
            : "border-red-500/30 bg-red-50/95 text-red-900 dark:bg-red-950/85 dark:text-red-100",
        )}
      >
        {isSuccess ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
        ) : (
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-5">{notice.title}</div>
          {notice.message ? (
            <div
              className={cn(
                "mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs leading-5",
                isSuccess
                  ? "text-emerald-800/80 dark:text-emerald-100/75"
                  : "text-red-800/80 dark:text-red-100/75",
              )}
            >
              {notice.message}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-0.5 shrink-0 rounded p-0.5 opacity-55 transition-opacity hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

const GIT_REVIEW_REMOTE_BRANCH_DISPLAY_LIMIT = 40;

// A checkout aborted by uncommitted local changes offers stash-and-switch
// instead of surfacing the raw git error.
export function GitBranchSwitchConflictModal(props: {
  conflict: GitBranchSwitchConflictState | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { conflict, loading, onClose, onConfirm } = props;
  const { t } = useLocale();
  const titleId = useId();

  if (!conflict) return null;

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
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div id={titleId} className="text-sm font-semibold text-foreground">
              {t("projectTools.gitReview.switchBranchConflictTitle")}
            </div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("projectTools.gitReview.switchBranchConflictDescription").replace(
                "{branch}",
                conflict.branch,
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t("chat.cancel")}
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {t("projectTools.gitReview.stashAndSwitch")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Head title as a branch switcher: branches load lazily when the menu opens
// and switching runs through runOperation so status/history refresh and
// errors surface exactly like the other toolbar operations.
function GitReviewBranchMenu(props: { data: GitReviewData; writeDisabled: boolean }) {
  const { data, writeDisabled } = props;
  const { busy, cwd, gitClient, state, switchBranch } = data;
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState("");
  const requestIdRef = useRef(0);
  const operationBusy = busy !== "";

  const loadBranches = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!gitClient || !cwd.trim()) return;
    setBranchesLoading(true);
    setBranchesError("");
    try {
      const response = await gitClient.branches(cwd);
      if (requestIdRef.current !== requestId) return;
      setBranches(response.branches);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setBranchesError(err instanceof Error ? err.message : String(err));
      setBranches([]);
    } finally {
      if (requestIdRef.current === requestId) {
        setBranchesLoading(false);
      }
    }
  }, [cwd, gitClient]);

  const title = state.head || t("projectTools.gitReviewTitle");
  if (state.status !== "ready") {
    return (
      <div className="flex min-w-0 flex-1 items-center px-2 text-[calc(12px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
        <span className="min-w-0 truncate">{title}</span>
      </div>
    );
  }

  const localBranches = branches.filter((branch) => branch.kind === "local");
  const remoteBranches = branches.filter((branch) => branch.kind === "remote");

  const renderBranchRow = (branch: GitBranchInfo, isCurrent: boolean, labelText: string) => (
    <DropdownMenuItem
      key={`${branch.kind}:${branch.fullName}`}
      disabled={operationBusy}
      onSelect={() => {
        if (isCurrent || writeDisabled) return;
        void switchBranch(branch.fullName, branch.kind);
      }}
      className={cn("gap-2 text-xs", (isCurrent || writeDisabled) && "text-muted-foreground")}
      title={branch.fullName}
    >
      {isCurrent ? (
        <Check className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{labelText}</span>
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void loadBranches();
      }}
    >
      <DropdownMenuTrigger
        disabled={operationBusy}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-[calc(12px*var(--zone-font-scale,1))] font-medium outline-hidden transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 disabled:pointer-events-none disabled:opacity-60"
        title={t("projectTools.gitReview.switchBranch")}
        aria-label={t("projectTools.gitReview.switchBranch")}
      >
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56 max-w-72">
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("projectTools.gitReview.switchBranch")}
        </DropdownMenuLabel>
        {branchesLoading ? (
          <div className="flex items-center justify-center px-2 py-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : branchesError ? (
          <div className="px-2 py-2 text-xs text-destructive">{branchesError}</div>
        ) : (
          <>
            {localBranches.length > 0 ? (
              <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                {t("git.branchSelector.localBranches")}
              </DropdownMenuLabel>
            ) : null}
            {localBranches.map((branch) => renderBranchRow(branch, branch.current, branch.name))}
            {remoteBranches.length > 0 ? (
              <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                {t("git.branchSelector.remoteBranches")}
              </DropdownMenuLabel>
            ) : null}
            {remoteBranches.slice(0, GIT_REVIEW_REMOTE_BRANCH_DISPLAY_LIMIT).map((branch) => {
              const isCurrentUpstream =
                branch.current || (state.upstream !== "" && branch.fullName === state.upstream);
              return renderBranchRow(branch, isCurrentUpstream, branch.fullName);
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Which selector the header's single dropdown edits: the repository (the
// container) or the branch (the item inside it).
type GitReviewScope = "repository" | "branch";

// Horizontal rolling scope rail above the selector dropdown: both scope
// icons share one row and the active one always rolls into the first
// (leftmost) slot — full-size and tinted — while the inactive one rolls in
// behind it, smaller and dimmed. Clicking the trailing icon swaps the slots
// with an odometer-style slide (the active icon passes above via z-index)
// and the dropdown below switches to that scope's selector, so whichever
// selector is active always gets the full header width.
function GitReviewScopeDial(props: {
  value: GitReviewScope;
  onChange: (value: GitReviewScope) => void;
  repositoryLabel: string;
  branchLabel: string;
}) {
  const { value, onChange, repositoryLabel, branchLabel } = props;
  const items = [
    {
      key: "repository" as const,
      label: repositoryLabel,
      Icon: Folder,
      activeTone: "text-sky-600 dark:text-sky-300",
    },
    {
      key: "branch" as const,
      label: branchLabel,
      Icon: GitBranch,
      activeTone: "text-emerald-600 dark:text-emerald-300",
    },
  ];
  return (
    <div className="relative h-7 w-[52px] shrink-0">
      {items.map((item) => {
        const isActive = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={isActive}
            aria-label={item.label}
            title={item.label}
            onClick={() => {
              if (!isActive) onChange(item.key);
            }}
            className={cn(
              "group absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center outline-hidden transition-[left] duration-200 ease-out motion-reduce:transition-none",
              isActive ? "left-3 z-10" : "left-10",
            )}
          >
            <item.Icon
              className={cn(
                "h-[18px] w-[18px] transition-all duration-200 ease-out motion-reduce:transition-none",
                isActive
                  ? cn("scale-100", item.activeTone)
                  : "scale-[0.7] text-muted-foreground/50 group-hover:text-muted-foreground group-focus-visible:text-muted-foreground",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

export function GitReviewToolbar(props: {
  data: GitReviewData;
  stackedPane: GitReviewStackedPane;
  onStackedPaneChange: (pane: GitReviewStackedPane, dir: "forward" | "back") => void;
  useSplitReviewLayout: boolean;
  visibleError: string;
  writeDisabled: boolean;
}) {
  const {
    data,
    stackedPane,
    onStackedPaneChange,
    useSplitReviewLayout,
    visibleError,
    writeDisabled,
  } = props;
  const {
    branchDiff,
    busy,
    canWrite,
    cwd,
    disabledMessage,
    discoverRepositories,
    gitClient,
    historyLoading,
    loadHistory,
    loading,
    refresh,
    repositories,
    reviewMode,
    runOperation,
    selectRepository,
    selectedRepoRoot,
    setReviewMode,
    state,
  } = data;
  const { t } = useLocale();
  const { onInsertCodeReviewSkill } = useRightDockToolContext().git;
  const operationBusy = busy !== "";
  // Which selector the dial exposes; branch is the everyday one, so it wins
  // the full-width dropdown by default.
  const [scope, setScope] = useState<GitReviewScope>("branch");
  // The repository scope only earns UI when discovery found more than one
  // repository to pick between; otherwise the dial collapses to a static
  // branch icon and the branch selector owns the header.
  const showRepositoryScope = repositories.length > 1;
  const effectiveScope: GitReviewScope = showRepositoryScope ? scope : "branch";

  return (
    <div className="shrink-0 border-b border-border px-3 py-3">
      <GitBranchSwitchConflictModal
        conflict={data.branchSwitchConflict}
        loading={busy === "switch_branch"}
        onClose={data.dismissBranchSwitchConflict}
        onConfirm={() => void data.stashAndSwitchBranch()}
      />
      {/* Single header line: horizontal scope rail (only when there are
          multiple repositories to pick between — with a single repository it
          collapses to a static branch icon), then the active scope's dropdown
          taking the remaining width, then the action buttons. */}
      <div className="flex items-center gap-2">
        {showRepositoryScope ? (
          <GitReviewScopeDial
            value={effectiveScope}
            onChange={setScope}
            repositoryLabel={t("projectTools.gitReview.repositoryPicker")}
            branchLabel={t("projectTools.gitReview.switchBranch")}
          />
        ) : (
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center"
            title={t("projectTools.gitReview.switchBranch")}
          >
            <GitBranch className="h-[18px] w-[18px] text-emerald-600 dark:text-emerald-300" />
          </div>
        )}
        <div className="flex h-7 min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-border bg-muted/25">
          {effectiveScope === "repository" ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={operationBusy}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-[calc(12px*var(--zone-font-scale,1))] font-medium outline-hidden transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 disabled:pointer-events-none disabled:opacity-60"
                title={t("projectTools.gitReview.repositoryPicker")}
                aria-label={t("projectTools.gitReview.repositoryPicker")}
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {selectedGitRepositoryLabel(repositories, selectedRepoRoot) ||
                    state.repoRoot ||
                    t("projectTools.gitReview.noRepository")}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground opacity-70" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56 max-w-72">
                <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("projectTools.gitReview.repositoryPicker")}
                </DropdownMenuLabel>
                {repositories.map((repo) => {
                  const value = repo.isWorkspaceRoot ? "" : repo.root;
                  const selected = value === selectedRepoRoot;
                  return (
                    <DropdownMenuItem
                      key={repo.root}
                      disabled={operationBusy}
                      onSelect={() => {
                        if (!selected) selectRepository(value);
                      }}
                      className="gap-2 text-xs"
                      title={repo.root}
                    >
                      {selected ? (
                        <Check className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {gitDiscoveredRepositoryLabel(repo)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <GitReviewBranchMenu data={data} writeDisabled={writeDisabled} />
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!onInsertCodeReviewSkill || state.status !== "ready"}
          className="h-7 w-7 px-0"
          title={t(
            !onInsertCodeReviewSkill
              ? "projectTools.gitReview.aiReviewUnavailable"
              : state.status === "ready"
                ? "projectTools.gitReview.addAiReview"
                : "projectTools.gitReview.noRepository",
          )}
          aria-label={t("projectTools.gitReview.addAiReview")}
          onClick={onInsertCodeReviewSkill}
        >
          <Sparkles className="h-3.5 w-3.5 text-primary" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading || historyLoading || operationBusy}
          className="h-7 w-7 px-0"
          title={t("projectTools.gitReview.refresh")}
          aria-label={t("projectTools.gitReview.refresh")}
          onClick={() => {
            if (data.isBusy()) return;
            // Manual refresh also re-scans for repositories so ones created
            // mid-session (e.g. a fresh clone in a subdirectory) show up.
            void discoverRepositories();
            if (reviewMode === "history") {
              void loadHistory();
            } else {
              void refresh();
            }
          }}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", (loading || historyLoading) && "animate-spin")} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={writeDisabled || operationBusy}
          title={t("projectTools.gitReview.fetch")}
          aria-label={t("projectTools.gitReview.fetch")}
          className="h-7 w-7 px-0"
          onClick={() => void runOperation("fetch", () => gitClient!.fetch(cwd), "fetch")}
        >
          {busy === "fetch" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Cloud className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={writeDisabled || operationBusy}
          title={t("projectTools.gitReview.pull")}
          aria-label={t("projectTools.gitReview.pull")}
          className="h-7 w-7 px-0"
          onClick={() => void runOperation("pull", () => gitClient!.pull(cwd), "pull")}
        >
          {busy === "pull" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={writeDisabled || operationBusy}
          title={t("projectTools.gitReview.push")}
          aria-label={t("projectTools.gitReview.push")}
          className="h-7 w-7 px-0"
          onClick={() => void runOperation("push", () => gitClient!.push(cwd), "push")}
        >
          {busy === "push" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {state.status === "ready" ? (
        <div className="mt-1.5 overflow-hidden rounded-xl border border-white/20 bg-white/50 shadow-sm backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.03]">
          <div className="flex items-center gap-1.5 border-b border-black/[0.04] px-3 py-2 dark:border-white/[0.06]">
            <span className="shrink-0 rounded bg-muted/70 px-1.5 py-0.5 text-[calc(10px*var(--zone-font-scale,1))] font-medium leading-none text-muted-foreground">
              {t("projectTools.gitReview.labelBase")}
            </span>
            <Cloud className="h-3 w-3 shrink-0 text-muted-foreground/60" />
            <span
              className="min-w-0 truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] text-foreground/75"
              title={
                branchDiff?.baseRef || state.upstream || t("projectTools.gitReview.unresolved")
              }
            >
              {branchDiff?.baseRef || state.upstream || t("projectTools.gitReview.unresolved")}
            </span>
          </div>
          <div className="grid grid-cols-5">
            {[
              {
                count: state.ahead,
                label: t("projectTools.gitReview.labelAhead"),
                tone: "text-sky-600 dark:text-sky-400",
              },
              {
                count: state.behind,
                label: t("projectTools.gitReview.labelBehind"),
                tone: "text-orange-600 dark:text-orange-400",
              },
              {
                count: state.dirtyCounts.staged,
                label: t("projectTools.gitReview.labelStaged"),
                tone: "text-emerald-600 dark:text-emerald-400",
              },
              {
                count: state.dirtyCounts.unstaged,
                label: t("projectTools.gitReview.labelUnstaged"),
                tone: "text-amber-600 dark:text-amber-400",
              },
              {
                count: state.dirtyCounts.untracked,
                label: t("projectTools.gitReview.labelUntracked"),
                tone: "text-violet-600 dark:text-violet-400",
              },
            ].map((item, index) => (
              <div
                key={item.label}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2",
                  index > 0 && "border-l border-black/[0.04] dark:border-white/[0.06]",
                )}
              >
                <span
                  className={cn(
                    "text-sm font-semibold tabular-nums leading-none",
                    item.count > 0 ? item.tone : "text-muted-foreground/40",
                  )}
                >
                  {item.count}
                </span>
                <span className="text-[calc(9px*var(--zone-font-scale,1))] leading-none text-muted-foreground/60">
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <div className="inline-flex shrink-0 rounded-md border border-border bg-muted/25 p-0.5 text-xs">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground",
              reviewMode === "changes" && "bg-background text-foreground shadow-sm",
            )}
            onClick={() => setReviewMode("changes")}
          >
            <GitBranch className="h-3.5 w-3.5" />
            {t("projectTools.gitReview.localChangesView")}
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground",
              reviewMode === "history" && "bg-background text-foreground shadow-sm",
            )}
            onClick={() => setReviewMode("history")}
          >
            <History className="h-3.5 w-3.5" />
            {t("projectTools.gitReview.commitHistoryView")}
          </button>
        </div>
        {!useSplitReviewLayout ? (
          <div className="ml-auto inline-flex shrink-0 rounded-md border border-border bg-muted/25 p-0.5">
            <button
              type="button"
              aria-label={t("projectTools.gitReview.listPane")}
              aria-pressed={stackedPane === "list"}
              title={t("projectTools.gitReview.listPane")}
              className={cn(
                GIT_REVIEW_STACKED_PANE_BUTTON_CLASS,
                stackedPane === "list" && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => onStackedPaneChange("list", "back")}
            >
              {reviewMode === "changes" ? (
                <GitBranch className="h-3.5 w-3.5" />
              ) : (
                <History className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              aria-label={t("projectTools.gitReview.detailPane")}
              aria-pressed={stackedPane === "detail"}
              title={t("projectTools.gitReview.detailPane")}
              className={cn(
                GIT_REVIEW_STACKED_PANE_BUTTON_CLASS,
                stackedPane === "detail" && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => onStackedPaneChange("detail", "forward")}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      {!canWrite && disabledMessage ? (
        <div className="mt-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {disabledMessage}
        </div>
      ) : null}
      {visibleError ? <div className="mt-2 text-xs text-destructive">{visibleError}</div> : null}
    </div>
  );
}
