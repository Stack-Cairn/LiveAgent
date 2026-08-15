import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import {
  Copy,
  FolderOpen,
  FolderTree,
  GitBranch,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useId } from "react";
import type { GitBranch as GitBranchInfo } from "../../lib/git/types";

const ACTION_MENU_BUTTON_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50";

export type GitBranchActionState = {
  mode: "menu" | "createFrom" | "rename";
  branch: GitBranchInfo;
};

export function GitInitModal(props: {
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
  const branchId = useId();
  const userNameId = useId();
  const userEmailId = useId();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) onClose();
      }}
    >
      <DialogContent
        className="max-w-md p-0"
        overlayClassName="z-[110]"
        viewportClassName="z-[110]"
      >
        <form
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
                <DialogTitle className="text-sm leading-normal">
                  {t("git.branchSelector.initRepositoryTitle")}
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs leading-5">
                  {t("git.branchSelector.initRepositoryDescription")}
                </DialogDescription>
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
                className="git-branch-selector-input h-9 text-sm"
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
                  className="git-branch-selector-input h-9 text-sm"
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
                  className="git-branch-selector-input h-9 text-sm"
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
      </DialogContent>
    </Dialog>
  );
}

// Worktree 创建弹窗：分支名、目录名与可选父目录分别传递，避免把 Git
// 引用命名规则与文件系统目录规则混为一谈。
export function WorktreeCreateModal(props: {
  open: boolean;
  repoRoot: string;
  startPoint: string;
  startPointOptions: string[];
  branch: string;
  directoryName: string;
  parentDirectory: string;
  loading: boolean;
  error: string;
  onStartPointChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onDirectoryNameChange: (value: string) => void;
  onParentDirectoryChange: (value: string) => void;
  onError: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const {
    open,
    repoRoot,
    startPoint,
    startPointOptions,
    branch,
    directoryName,
    parentDirectory,
    loading,
    error,
    onStartPointChange,
    onBranchChange,
    onDirectoryNameChange,
    onParentDirectoryChange,
    onError,
    onClose,
    onSubmit,
  } = props;
  const { t } = useLocale();
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const branchInputId = useId();
  const directoryInputId = useId();
  const parentInputId = useId();

  async function chooseParentDirectory() {
    try {
      const selected = await pickDirectory(parentDirectory || repoRoot);
      const path = selected?.trim();
      if (path) onParentDirectoryChange(path);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) onClose();
      }}
    >
      <DialogContent
        className="max-w-md p-0"
        overlayClassName="z-[110]"
        viewportClassName="z-[110]"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                <FolderTree className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-sm leading-normal">
                  {t("git.branchSelector.createWorktreeTitle")}
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs leading-5">
                  {t("git.branchSelector.worktreeDescription")}
                </DialogDescription>
              </div>
            </div>
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={loading}
                  className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
                  title={t("window.close")}
                  aria-label={t("window.close")}
                />
              }
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("git.branchSelector.repositoryLabel")}
              </Label>
              <div
                className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-xs text-foreground"
                title={repoRoot}
              >
                {repoRoot}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("git.branchSelector.worktreeStartPoint")}
              </Label>
              <Select
                value={startPoint || null}
                onValueChange={onStartPointChange}
                disabled={loading || startPointOptions.length === 0}
              >
                <SelectTrigger type="button" className="h-9 text-xs">
                  <SelectValue placeholder="HEAD" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {startPointOptions.map((option) => (
                    <SelectItem key={option} value={option} className="text-xs">
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={branchInputId} className="text-xs text-muted-foreground">
                  {t("git.branchSelector.worktreeBranch")}
                </Label>
                <Input
                  id={branchInputId}
                  value={branch}
                  onChange={(event) => onBranchChange(event.target.value)}
                  className="h-9 text-sm"
                  placeholder={t("git.branchSelector.worktreeBranchPlaceholder")}
                  autoFocus
                  disabled={loading}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={directoryInputId} className="text-xs text-muted-foreground">
                  {t("git.branchSelector.worktreeDirectoryName")}
                </Label>
                <Input
                  id={directoryInputId}
                  value={directoryName}
                  onChange={(event) => onDirectoryNameChange(event.target.value)}
                  className="h-9 text-sm"
                  placeholder={t("git.branchSelector.worktreeDirectoryPlaceholder")}
                  disabled={loading}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={parentInputId} className="text-xs text-muted-foreground">
                {t("git.branchSelector.worktreeParentDirectory")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id={parentInputId}
                  value={parentDirectory}
                  readOnly
                  className="h-9 min-w-0 flex-1 text-xs"
                  placeholder={t("git.branchSelector.worktreeDefaultLocation")}
                  disabled={loading}
                  title={parentDirectory}
                />
                {parentDirectory ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => onParentDirectoryChange("")}
                    disabled={loading}
                    title={t("git.branchSelector.worktreeUseDefaultLocation")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => void chooseParentDirectory()}
                  disabled={loading}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("git.branchSelector.worktreeChooseParent")}
                </Button>
              </div>
            </div>
            <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {parentDirectory
                ? t("git.branchSelector.worktreeCustomLocationHint")
                : t("git.branchSelector.worktreeLocationHint")}
            </div>
            {error ? (
              <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
            <DialogClose
              render={<Button type="button" variant="ghost" size="sm" disabled={loading} />}
            >
              {t("chat.cancel")}
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={loading || !branch.trim() || !directoryName.trim()}
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderTree className="h-3.5 w-3.5" />
              )}
              {t("git.branchSelector.createWorktree")}
            </Button>
          </div>
        </form>
        {/* Web 端目录选择器是嵌套 Dialog；置于父 Popup 内交给 Base UI 管理层级与焦点。 */}
        {directoryPickerElement}
      </DialogContent>
    </Dialog>
  );
}

// Per-branch action sheet opened from a branch row's "⋯" button. Lives below
// the shared ConfirmDialog (z-[120]) so delete confirmations stack above it.
export function BranchActionsModal(props: {
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
  // 当前分支被 worktree 检出时，删除入口切换为“删除 Worktree”。
  checkedOutWorktreePath?: string;
  onDeleteWorktree?: () => void;
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
    checkedOutWorktreePath,
    onDeleteWorktree,
    onSubmit,
    onClose,
  } = props;
  const { t } = useLocale();
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

  return (
    <Dialog
      open={Boolean(action)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-sm p-0">
        <form
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
                <DialogTitle className="truncate text-sm leading-normal" title={branch.fullName}>
                  {branch.fullName}
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs leading-5">
                  {isForm ? formTitle : kindLabel}
                </DialogDescription>
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
                checkedOutWorktreePath && onDeleteWorktree ? (
                  <button
                    type="button"
                    className={cn(
                      ACTION_MENU_BUTTON_CLASS,
                      "text-destructive hover:bg-destructive/10 hover:text-destructive",
                    )}
                    onClick={onDeleteWorktree}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderTree className="h-3.5 w-3.5" />
                    )}
                    <span>{t("git.branchSelector.deleteWorktree")}</span>
                  </button>
                ) : (
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
                )
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
      </DialogContent>
    </Dialog>
  );
}
