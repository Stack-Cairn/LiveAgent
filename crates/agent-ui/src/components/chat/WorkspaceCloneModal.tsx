import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import { FolderOpen, GitBranch, Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
import { useCallback, useEffect, useRef, useState } from "react";

type RemoteBranches = {
  defaultBranch: string;
  branches: string[];
};

type WorkspaceCreateMode = "folder" | "clone";

const WORKSPACE_CREATE_MODES = [
  {
    value: "folder",
    Icon: FolderOpen,
    titleKey: "chat.workspaceOpenFolder",
    descriptionKey: "chat.workspaceOpenFolderDescription",
  },
  {
    value: "clone",
    Icon: GitBranch,
    titleKey: "chat.workspaceCloneRepository",
    descriptionKey: "chat.workspaceCloneDescription",
  },
] as const satisfies readonly {
  value: WorkspaceCreateMode;
  Icon: typeof FolderOpen;
  titleKey: string;
  descriptionKey: string;
}[];

type WorkspaceCloneModalProps = {
  initialParent: string;
  canClone?: boolean;
  cloneDisabledMessage?: string;
  onClone: (remoteUrl: string, parent: string, name: string, branch: string) => Promise<void>;
  onLoadBranches: (remoteUrl: string) => Promise<RemoteBranches>;
  onOpenFolder: () => void;
  onClose: () => void;
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const message = String(error ?? "").trim();
  return message || "Failed to clone repository";
}

function workspaceNameFromRemoteUrl(remoteUrl: string) {
  const path = remoteUrl.trim().replace(/\/+$/, "");
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf(":"));
  return path.slice(separator + 1).replace(/\.git$/i, "");
}

export function WorkspaceCloneModal({
  initialParent,
  canClone: cloningEnabled = true,
  cloneDisabledMessage,
  onClone,
  onLoadBranches,
  onOpenFolder,
  onClose,
}: WorkspaceCloneModalProps) {
  const { t } = useLocale();
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const [mode, setMode] = useState<WorkspaceCreateMode>("folder");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [parent, setParent] = useState(initialParent);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [cloning, setCloning] = useState(false);

  const [nameIsAutomatic, setNameIsAutomatic] = useState(true);
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const branchRequestId = useRef(0);

  const canSubmit = Boolean(
    cloningEnabled &&
      remoteUrl.trim() &&
      parent.trim() &&
      name.trim() &&
      branch &&
      !branchesLoading &&
      !cloning,
  );

  async function chooseParent() {
    try {
      const selected = await pickDirectory(parent);
      const path = selected?.trim();
      if (path) setParent(path);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const loadRemoteBranches = useCallback(
    async (url: string, requestId: number) => {
      try {
        const response = await onLoadBranches(url);
        if (requestId !== branchRequestId.current) return;
        const nextBranches = [
          ...new Set(response.branches.map((value) => value.trim()).filter(Boolean)),
        ];
        setBranches(nextBranches);
        setBranch((current) =>
          current && nextBranches.includes(current)
            ? current
            : response.defaultBranch || nextBranches[0] || "",
        );
      } catch (reason) {
        if (requestId === branchRequestId.current) setError(errorMessage(reason));
      } finally {
        if (requestId === branchRequestId.current) setBranchesLoading(false);
      }
    },
    [onLoadBranches],
  );

  useEffect(() => {
    const url = remoteUrl.trim();
    const requestId = ++branchRequestId.current;
    if (!url) {
      setBranches([]);
      setBranch("");
      setBranchesLoading(false);
      return;
    }

    setBranchesLoading(true);
    const timer = window.setTimeout(() => void loadRemoteBranches(url, requestId), 350);
    return () => {
      window.clearTimeout(timer);
      if (requestId === branchRequestId.current) branchRequestId.current += 1;
    };
  }, [loadRemoteBranches, remoteUrl]);

  async function cloneRepository() {
    if (!canSubmit) return;
    setCloning(true);
    setError("");
    try {
      await onClone(remoteUrl.trim(), parent.trim(), name.trim(), branch);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCloning(false);
    }
  }

  const modal = (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cloning) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] max-w-xl flex-col p-0"
        closeDisabled={cloning}
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{t("chat.workspaceCreate")}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {t("chat.workspaceCreateDescription")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {WORKSPACE_CREATE_MODES.map(({ value, Icon, titleKey, descriptionKey }) => {
              const isActive = mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setMode(value)}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-lg p-3 text-left transition-colors focus-visible:outline-hidden",
                    isActive ? "bg-primary/[0.08]" : "bg-muted/40 hover:bg-muted/70",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground",
                        isActive && "text-primary",
                      )}
                    />
                    <span className="text-sm font-medium">{t(titleKey)}</span>
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {t(descriptionKey)}
                  </span>
                </button>
              );
            })}
          </div>

          {mode === "clone" ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="workspace-clone-url" className="text-muted-foreground">
                  {t("chat.workspaceCloneUrl")}
                </Label>
                <Input
                  id="workspace-clone-url"
                  className="h-8 shadow-none"
                  value={remoteUrl}
                  onChange={(event) => {
                    const nextUrl = event.currentTarget.value;
                    setRemoteUrl(nextUrl);
                    setBranches([]);
                    setBranch("");
                    setBranchesLoading(Boolean(nextUrl.trim()));
                    setError("");
                    if (nameIsAutomatic) setName(workspaceNameFromRemoteUrl(nextUrl));
                  }}
                  placeholder={t("chat.workspaceCloneUrlPlaceholder")}
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="space-y-2">
                  <Label htmlFor="workspace-clone-parent" className="text-muted-foreground">
                    {t("chat.workspaceCloneParent")}
                  </Label>
                  <Input
                    id="workspace-clone-parent"
                    className="h-8 shadow-none"
                    value={parent}
                    readOnly
                    placeholder={t("chat.workspaceCloneParentPlaceholder")}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 self-end"
                  onClick={() => void chooseParent()}
                >
                  {t("chat.workspaceCloneChooseParent")}
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="workspace-clone-name" className="text-muted-foreground">
                    {t("chat.workspaceCloneName")}
                  </Label>
                  <Input
                    id="workspace-clone-name"
                    className="h-8 shadow-none"
                    value={name}
                    onChange={(event) => {
                      setName(event.currentTarget.value);
                      setNameIsAutomatic(false);
                    }}
                    placeholder={t("chat.workspaceCloneNamePlaceholder")}
                    autoComplete="off"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void cloneRepository();
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="workspace-clone-branch" className="text-muted-foreground">
                    {t("chat.workspaceCloneBranch")}
                  </Label>
                  <Select
                    value={branch || null}
                    onValueChange={setBranch}
                    disabled={!branches.length || branchesLoading}
                  >
                    <SelectTrigger id="workspace-clone-branch" className="h-8 shadow-none">
                      <SelectValue
                        placeholder={
                          branchesLoading
                            ? t("chat.workspaceCloneBranchesLoading")
                            : t("chat.workspaceCloneBranchPlaceholder")
                        }
                      />
                    </SelectTrigger>
                    <SelectContent className="max-h-60 w-72 max-w-[calc(100vw-2rem)]">
                      {branches.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {!cloningEnabled && cloneDisabledMessage ? (
                <p className="text-xs text-muted-foreground">{cloneDisabledMessage}</p>
              ) : null}
            </div>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button variant="outline" className="h-8" onClick={onClose} disabled={cloning}>
              {t("settings.cancel")}
            </Button>
            {mode === "folder" ? (
              <Button
                className="h-8"
                onClick={() => {
                  onOpenFolder();
                  onClose();
                }}
              >
                <FolderOpen className="h-4 w-4" />
                {t("chat.workspaceOpenFolderSubmit")}
              </Button>
            ) : (
              <Button className="h-8" onClick={() => void cloneRepository()} disabled={!canSubmit}>
                {cloning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitBranch className="h-4 w-4" />
                )}
                {cloning ? t("chat.workspaceCloning") : t("chat.workspaceCloneSubmit")}
              </Button>
            )}
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      {modal}
      {directoryPickerElement}
    </>
  );
}
